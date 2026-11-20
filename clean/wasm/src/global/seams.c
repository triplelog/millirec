#include "../hw.h"
#include "../core/utils.h"
#include <stdlib.h>
#include <string.h>

/* Rule tracing via coupled parallel seam pairs.
 *
 * Energy image: horizontal grayscale opening of the inverted flat image —
 * long dark horizontal runs (ruled lines) survive, short strokes (text)
 * vanish.
 *
 * Ruled lines come in near-parallel families, so instead of tracing each
 * rule independently (where a lone seam can wander onto a dense text row),
 * we seed candidate start rows from dark line-energy at the LEFT edge, form
 * candidate pairs from nearby starts, and trace BOTH seams of a pair with a
 * single joint dynamic program. The DP state couples the seams: the pair's
 * vertical gap may never drift more than P_RULE_SKEW px from its value at
 * the left edge. Pairs are ranked by energy (lowest cost first) and their
 * member seams accepted greedily with dedup. A rule shared by two pairs
 * (its upper and lower neighbor) is accepted once.
 */

#define DRIFT_PENALTY 0.5f
#define ANCHOR_PENALTY 0.1f
#define MEAN_FLOOR 6.0f /* min mean seam energy for an accepted rule */
#define CAND_FLOOR 3.0f /* laxer per-px floor for left-edge candidates */
#define NEG (-1e9f)

/* Line-height estimation by stratified random probing.
 *
 * Hundreds of jittered grid points across the central region of the page;
 * at each empty (non-dark) point, measure the distance to the nearest dark
 * pixel above plus below. Points inside text lines see small sums; points
 * in an empty ruled line see the rule-to-rule gap. The 95th percentile of
 * valid sums is the empty-line height. Samples that hit the scan cap
 * (blank margins, unruled regions) are discarded rather than clamped, so
 * they cannot inflate the percentile. Returns 0 if too few valid samples. */
static float estimate_line_height(const img_u8 *im, int dark) {
    int w = im->w, h = im->h;
    const int GX = 24, GY = 24; /* 576 candidate probes */
    int x0 = w / 5, x1 = w - w / 5;   /* central 60% horizontally */
    int y0 = h / 6, y1 = h - h / 6;   /* central 2/3 vertically */
    int maxscan = h / 4;
    if (x1 - x0 < GX || y1 - y0 < GY) return 0;

    float *sums = (float *)arena_alloc(sizeof(float) * GX * GY);
    if (!sums) return 0;
    uint32_t rng = 0x12345678u;
    int cw = (x1 - x0) / GX, chh = (y1 - y0) / GY; /* cell size */
    int n = 0;
    for (int j = 0; j < GY; j++) {
        for (int i = 0; i < GX; i++) {
            rng = rng * 1664525u + 1013904223u;
            int cx = x0 + cw * i + (int)((rng >> 16) % (uint32_t)cw);
            rng = rng * 1664525u + 1013904223u;
            int cy = y0 + chh * j + (int)((rng >> 16) % (uint32_t)chh);
            cx = clampi(cx, 0, w - 1);
            cy = clampi(cy, 0, h - 1);
            if (im->data[(size_t)cy * w + cx] < dark) continue; /* on ink */
            int du = -1, dd = -1;
            for (int d = 1; d <= maxscan; d++) {
                if (du < 0 && cy - d >= 0 &&
                    im->data[(size_t)(cy - d) * w + cx] < dark) du = d;
                if (dd < 0 && cy + d < h &&
                    im->data[(size_t)(cy + d) * w + cx] < dark) dd = d;
                if (du >= 0 && dd >= 0) break;
            }
            if (du < 0 || dd < 0) continue; /* open space: discard */
            sums[n++] = (float)(du + dd);
        }
    }
    if (n < 30) return 0;
    /* insertion sort is fine at this size */
    for (int i = 1; i < n; i++) {
        float v = sums[i];
        int j = i;
        while (j > 0 && sums[j - 1] > v) { sums[j] = sums[j - 1]; j--; }
        sums[j] = v;
    }
    return sums[(int)(0.95f * (n - 1))];
}

static img_u8 energy_h(const img_u8 *src, int kernel) {
    img_u8 inv = img_new(src->w, src->h);
    img_u8 E = img_new(src->w, src->h);
    if (!inv.data || !E.data) {
        E.data = NULL;
        return E;
    }
    size_t n = (size_t)src->w * src->h;
    for (size_t i = 0; i < n; i++) inv.data[i] = 255 - src->data[i];
    open_horizontal(&inv, &E, kernel);
    return E;
}

/* Row peaks of summed energy over columns [0, x1): candidate rule starts. */
static int find_candidates(const img_u8 *E, int x1, int min_gap, float rel,
                           int max_c, int *out) {
    int w = E->w, h = E->h;
    if (x1 > w) x1 = w;
    double *score = (double *)arena_alloc(sizeof(double) * h);
    if (!score) return 0;
    double maxs = 0;
    for (int y = 0; y < h; y++) {
        const uint8_t *row = E->data + (size_t)y * w;
        double s = 0;
        for (int x = 0; x < x1; x++) s += row[x];
        score[y] = s;
        if (s > maxs) maxs = s;
    }
    double cut = rel * maxs;
    double floor_cut = CAND_FLOOR * x1;
    if (cut < floor_cut) cut = floor_cut;

    int nc = 0;
    for (int y = 0; y < h && nc < max_c; y++) {
        if (score[y] < cut) continue;
        int is_peak = 1;
        for (int d = 1; d <= min_gap && is_peak; d++) {
            if (y - d >= 0 && score[y - d] > score[y]) is_peak = 0;
            if (y + d < h && score[y + d] >= score[y]) is_peak = 0;
        }
        if (is_peak) out[nc++] = y;
    }
    return nc;
}

/* Sum energy columns into blocks of S: one DP step per block enforces the
 * local slope limit (1 px vertical per S horizontal px). */
static uint16_t *block_sum(const img_u8 *E, int S, int *out_wb) {
    int w = E->w, h = E->h;
    int wb = (w + S - 1) / S;
    uint16_t *Eb = (uint16_t *)arena_alloc(sizeof(uint16_t) * (size_t)wb * h);
    if (!Eb) return NULL;
    for (int y = 0; y < h; y++) {
        const uint8_t *row = E->data + (size_t)y * w;
        uint16_t *out = Eb + (size_t)y * wb;
        for (int xb = 0; xb < wb; xb++) {
            uint32_t sum = 0;
            int c0 = xb * S, c1 = c0 + S < w ? c0 + S : w;
            for (int c = c0; c < c1; c++) sum += row[c];
            out[xb] = (uint16_t)sum;
        }
    }
    *out_wb = wb;
    return Eb;
}

/* Joint DP over one pair of seams, on a BLOCK-SUMMED energy image: columns
 * are grouped into blocks of S px and each seam moves -1/0/+1 per block.
 * That enforces a LOCAL slope limit (at most 1 px vertical per S horizontal
 * px, e.g. S=4 -> 5 px per 20 px) instead of only a global wander band, and
 * shrinks the DP by a factor of S. State = (ka, d): seam A at
 * y = ya0 - band + ka, seam B at yA + (gap - skew) + d; d stays in
 * [0, 2*skew], enforcing near-parallelism.
 * Eb is h rows x wb block-columns of column-summed energy; out traces are
 * expanded back to per-column resolution (w). Returns 0 on success. */
static int trace_pair(const uint16_t *Eb, int wb, int h, int S, int w,
                      int ya0, int yb0, int band, int skew,
                      float *dp0, float *dp1, int8_t *choice,
                      int16_t *out_a, int16_t *out_b,
                      float *mean_a, float *mean_b) {
    int Ha = 2 * band + 1, D = 2 * skew + 1;
    int base = yb0 - ya0 - skew; /* yb = ya + base + d */
    float pen_drift = DRIFT_PENALTY * (float)S;
    float pen_anchor = ANCHOR_PENALTY * (float)S;

    /* Which states are on the page at all does not depend on the column, so
     * it is decided once. Rows of Eb for each state are hoisted likewise. */
    uint8_t *valid = (uint8_t *)arena_alloc((size_t)Ha * D);
    int *rowA = (int *)arena_alloc(sizeof(int) * Ha);
    int *rowB = (int *)arena_alloc(sizeof(int) * (size_t)Ha * D);
    /* Separable predecessor max: per row ka, the best over db for every
     * sheared column j in [-1, D] (D + 2 entries, index j + 1); M carries one
     * NEG guard row above and below, so the da scan needs no row check. The
     * dp layers themselves are PADDED: two NEG cells on each side of every
     * row, so the db scan needs no column check either. A NEG candidate
     * minus a penalty is still far below any live value, so letting it take
     * part in the strict-greater scan changes nothing; when every candidate
     * is NEG the result stays below NEG/2 and the state is dead as before. */
    int Dp = D + 4;                  /* padded row: index d + 2 */
    int Dj = D + 2;                  /* M row: index j + 1, j in [-1, D] */
    float *dpA = (float *)arena_alloc(sizeof(float) * (size_t)Ha * Dp);
    float *dpB = (float *)arena_alloc(sizeof(float) * (size_t)Ha * Dp);
    float *M = (float *)arena_alloc(sizeof(float) * (size_t)(Ha + 2) * Dj);
    int8_t *Mb = (int8_t *)arena_alloc((size_t)(Ha + 2) * Dj);
    if (!valid || !rowA || !rowB || !dpA || !dpB || !M || !Mb) return 1;
    for (int i = 0; i < Ha * Dp; i++) { dpA[i] = NEG; dpB[i] = NEG; }
    for (int j = 0; j < Dj; j++) {
        M[j] = NEG; Mb[j] = 4;                                   /* guard row above */
        M[(size_t)(Ha + 1) * Dj + j] = NEG; Mb[(size_t)(Ha + 1) * Dj + j] = 4;   /* below */
    }

    for (int ka = 0; ka < Ha; ka++) {
        int ya = ya0 - band + ka;
        rowA[ka] = ya;
        for (int d = 0; d < D; d++) {
            int yb = ya + base + d;
            int s = ka * D + d;
            rowB[s] = yb;
            valid[s] = (ya < 0 || ya >= h || yb < 0 || yb >= h) ? 0 : 1;
            if (!valid[s])
                dpA[ka * Dp + d + 2] = NEG;
            else
                dpA[ka * Dp + d + 2] = (float)Eb[(size_t)ya * wb] +
                         (float)Eb[(size_t)yb * wb] -
                         pen_anchor * (float)(abs(ka - band) + abs(d - skew));
        }
    }

    /* THE PREDECESSOR MAX IS SEPARABLE. State (ka2, d2) reaches back to the
     * nine states (ka2 - da, d2 - db + da), paying pen_drift * (|da| + |db|).
     * Splitting the sum splits the max: first, per row ka, the best over db
     * for each sheared column j = d - ... (M, with the winning db in Mb); then
     * per state the best over da of M[ka2 - da][d2 + da] minus pen_drift *
     * |da|. Six reads per state instead of nine, and IDENTICAL by
     * construction — the penalty is subtracted in two steps instead of one,
     * and both subtractions are exact in float32 (pen_drift is S/2, and every
     * dp value is a multiple of its own ulp with |dp| far below 2^24, so
     * subtracting a small integer multiple of 0.5 from it never rounds); the
     * tie-break is the same first-in-(da, db)-order winner, because each row's
     * first-winning db is taken and the rows are then scanned in da order
     * with a strict compare, exactly as the single nine-way scan did. */
    for (int x = 1; x < wb; x++) {
        int8_t *ch = choice + (size_t)x * Ha * D;
        /* stage 1: per row, the best over db (candidates at d = j+1, j, j-1
         * for db = -1, 0, +1 — padded index d + 2), first-wins in db order */
        for (int ka = 0; ka < Ha; ka++) {
            const float *row = dpA + ka * Dp;
            float *Mrow = M + (size_t)(ka + 1) * Dj;
            int8_t *Mbrow = Mb + (size_t)(ka + 1) * Dj;
            for (int j = -1; j <= D; j++) {
                float c0 = row[j + 3] - pen_drift;     /* db = -1 */
                float c1 = row[j + 2];                 /* db =  0 */
                float c2 = row[j + 1] - pen_drift;     /* db = +1 */
                float best = c0;
                int8_t bdb = -1;
                if (c1 > best) { best = c1; bdb = 0; }
                if (c2 > best) { best = c2; bdb = 1; }
                Mrow[j + 1] = best;
                Mbrow[j + 1] = bdb;
            }
        }
        /* stage 2: per state, the best over da (row ka2 - da, sheared column
         * d2 + da), first-wins in da order; guard rows make every row legal */
        for (int ka2 = 0; ka2 < Ha; ka2++) {
            int ya2 = rowA[ka2];
            const float *Mup = M + (size_t)(ka2 + 2) * Dj;   /* da = -1: ka2 + 1 */
            const float *Mmid = M + (size_t)(ka2 + 1) * Dj;  /* da =  0 */
            const float *Mdn = M + (size_t)ka2 * Dj;         /* da = +1: ka2 - 1 */
            const int8_t *Bup = Mb + (size_t)(ka2 + 2) * Dj;
            const int8_t *Bmid = Mb + (size_t)(ka2 + 1) * Dj;
            const int8_t *Bdn = Mb + (size_t)ka2 * Dj;
            float *out = dpB + ka2 * Dp;
            for (int d2 = 0; d2 < D; d2++) {
                int s2 = ka2 * D + d2;
                if (!valid[s2]) {
                    out[d2 + 2] = NEG;
                    ch[s2] = 4;
                    continue;
                }
                /* M index j + 1 with j = d2 + da: da = -1 -> d2, 0 -> d2 + 1, +1 -> d2 + 2 */
                float c0 = Mup[d2] - pen_drift;
                float c1 = Mmid[d2 + 1];
                float c2 = Mdn[d2 + 2] - pen_drift;
                float best = c0;
                int8_t bda = -1, bdb = Bup[d2];
                if (c1 > best) { best = c1; bda = 0; bdb = Bmid[d2 + 1]; }
                if (c2 > best) { best = c2; bda = 1; bdb = Bdn[d2 + 2]; }
                if (best <= NEG / 2) {
                    out[d2 + 2] = NEG;
                    ch[s2] = 4;
                } else {
                    out[d2 + 2] = best + (float)Eb[(size_t)ya2 * wb + x] +
                                  (float)Eb[(size_t)rowB[s2] * wb + x];
                    ch[s2] = (int8_t)((bda + 1) * 3 + (bdb + 1));
                }
            }
        }
        float *t = dpA;
        dpA = dpB;
        dpB = t;
    }
    /* unpad the final layer into dp0 for the backtrack below */
    for (int ka = 0; ka < Ha; ka++)
        for (int d = 0; d < D; d++) dp0[ka * D + d] = dpA[ka * Dp + d + 2];

    int s = 0;
    for (int i = 1; i < Ha * D; i++)
        if (dp0[i] > dp0[s]) s = i;
    if (dp0[s] <= NEG / 2) return 1;

    double sa = 0, sb = 0;
    for (int x = wb - 1; x >= 0; x--) {
        int ka = s / D, d = s % D;
        int ya = ya0 - band + ka;
        int yb = ya + base + d;
        for (int c = x * S; c < (x + 1) * S && c < w; c++) {
            out_a[c] = (int16_t)ya;
            out_b[c] = (int16_t)yb;
        }
        sa += Eb[(size_t)ya * wb + x];
        sb += Eb[(size_t)yb * wb + x];
        if (x > 0) {
            int8_t bc = choice[(size_t)x * Ha * D + s];
            int da = bc / 3 - 1, db = bc % 3 - 1;
            s = (ka - da) * D + (d - db + da);
        }
    }
    *mean_a = (float)(sa / w);
    *mean_b = (float)(sb / w);
    return 0;
}

typedef struct {
    int16_t *a, *b;
    float mean_a, mean_b;
} pair_res;

static int cmp_pairs(const void *pa, const void *pb) {
    float a = ((const pair_res *)pa)->mean_a + ((const pair_res *)pa)->mean_b;
    float b = ((const pair_res *)pb)->mean_a + ((const pair_res *)pb)->mean_b;
    return a < b ? 1 : (a > b ? -1 : 0);
}

static float trace_mean_y(const int16_t *t, int w) {
    double m = 0;
    for (int x = 0; x < w; x++) m += t[x];
    return (float)(m / w);
}

/* Single-seam block DP (same local slope limit as pairs, no partner).
 * Returns the seam's mean energy per column, or -1 if the DP is dead. */
static float trace_seam_block(const uint16_t *Eb, int wb, int h, int S, int w,
                              int seed, int band, float *dp0, float *dp1,
                              int8_t *choice, int16_t *out) {
    int Ha = 2 * band + 1;
    float pen = DRIFT_PENALTY * (float)S;
    float anchor = ANCHOR_PENALTY * (float)S;

    for (int ka = 0; ka < Ha; ka++) {
        int y = seed - band + ka;
        dp0[ka] = (y < 0 || y >= h)
                      ? NEG
                      : (float)Eb[(size_t)y * wb] -
                            anchor * (float)(ka > band ? ka - band : band - ka);
    }
    for (int x = 1; x < wb; x++) {
        int8_t *ch = choice + (size_t)x * Ha;
        for (int ka2 = 0; ka2 < Ha; ka2++) {
            int y2 = seed - band + ka2;
            if (y2 < 0 || y2 >= h) {
                dp1[ka2] = NEG;
                ch[ka2] = 0;
                continue;
            }
            float best = NEG;
            int8_t bc = 0;
            for (int da = -1; da <= 1; da++) {
                int ka = ka2 - da;
                if (ka < 0 || ka >= Ha) continue;
                float c = dp0[ka];
                if (c <= NEG / 2) continue;
                c -= pen * (float)(da < 0 ? -da : da);
                if (c > best) {
                    best = c;
                    bc = (int8_t)da;
                }
            }
            dp1[ka2] = best <= NEG / 2 ? NEG : best + (float)Eb[(size_t)y2 * wb + x];
            ch[ka2] = bc;
        }
        float *t = dp0;
        dp0 = dp1;
        dp1 = t;
    }
    int bk = 0;
    for (int k = 1; k < Ha; k++)
        if (dp0[k] > dp0[bk]) bk = k;
    if (dp0[bk] <= NEG / 2) return -1;

    double sum = 0;
    for (int x = wb - 1; x >= 0; x--) {
        int y = seed - band + bk;
        for (int c = x * S; c < (x + 1) * S && c < w; c++) out[c] = (int16_t)y;
        sum += Eb[(size_t)y * wb + x];
        if (x > 0) bk -= choice[(size_t)x * Ha + bk];
    }
    return (float)(sum / w);
}

/* Is this seam the paper's edge rather than a printed line? A real line has
 * paper-bright pixels on BOTH flanks within a short lookahead in most rows;
 * a page edge or shadow strip has background/dark on one side. */
static int edge_test(const img_u8 *im, const int16_t *trace, int dark,
                     int max_t) {
    int w = im->w, h = im->h;
    int cap = max_t * 3 + 4, look = 18;
    int ok = 0, n = 0;
    for (int x = 4; x < w - 4; x += 8) {
        int yc = -1;
        for (int d = 0; d <= 2 && yc < 0; d++) {
            if (img_get(im, x, trace[x] + d) < dark) yc = trace[x] + d;
            else if (d && img_get(im, x, trace[x] - d) < dark) yc = trace[x] - d;
        }
        if (yc < 0) continue;
        int y0 = yc, y1 = yc;
        while (y0 > 0 && yc - y0 < cap && img_get(im, x, y0 - 1) < dark) y0--;
        while (y1 < h - 1 && y1 - yc < cap && img_get(im, x, y1 + 1) < dark) y1++;
        n++;
        int lok = 0, rok = 0;
        for (int d = 1; d <= look && !(lok && rok); d++) {
            if (!lok && y0 - d >= 0 && im->data[(size_t)(y0 - d) * w + x] >= dark)
                lok = 1;
            if (!rok && y1 + d < h && im->data[(size_t)(y1 + d) * w + x] >= dark)
                rok = 1;
        }
        if (lok && rok) ok++;
    }
    if (n < 8) return 0; /* too faint/sparse to be a real line */
    return ok * 10 >= n * 8; /* paper on both sides in >=80% of samples */
}

/* Thickness probe that tolerates double lines: after the first dark run,
 * keep scanning a short lookahead on BOTH sides for a second run and
 * measure the full extent (line + gap + line). The median across probes
 * decides single vs double: a real second line shows up in nearly all
 * probes, occasional text past the gap only in a few. */
static int probe_thickness_double(const img_u8 *im, const int16_t *trace,
                                  int dark, int max_t) {
    int w = im->w, h = im->h;
    int step = w / 128 > 1 ? w / 128 : 1;
    int cap = max_t * 3 + 4;
    /* How far past the first run to look for a partner line.
     *
     * This used to be max_t + 2, which conflated two different quantities: how
     * thick ONE line can be, and how far apart TWO of them sit. Ruled paper
     * with a double margin often leaves a wider gap than a single rule is
     * thick, and the probe then measured only the first line and left the
     * second one in the page.
     *
     * The answer is already bounded by `cap`, so looking less far than that
     * only loses doubles that would have been legal anyway. The false-positive
     * risk — mistaking nearby text for the partner — is handled below by
     * requiring a real RUN rather than a single dark pixel, and by taking a
     * median across probes: a rule appears in nearly every probe, a letter in
     * a few. */
    int look = cap;
    /* A partner must be a run at least this deep to count. A serif or a speck
     * beside the rule is not a second rule. */
    const int MIN_PARTNER_RUN = 2;
    int lens[256];
    int n = 0;
    for (int x = step / 2; x < w && n < 256; x += step) {
        int yc = -1;
        for (int d = 0; d <= 2 && yc < 0; d++) {
            if (img_get(im, x, trace[x] + d) < dark) yc = trace[x] + d;
            else if (d && img_get(im, x, trace[x] - d) < dark) yc = trace[x] - d;
        }
        if (yc < 0) continue;
        int y0 = yc, y1 = yc;
        while (y0 > 0 && yc - y0 < cap && img_get(im, x, y0 - 1) < dark) y0--;
        while (y1 < h - 1 && y1 - yc < cap && img_get(im, x, y1 + 1) < dark) y1++;
        /* partner line past a light gap, either side */
        for (int d = 2; d <= look; d++) {
            int yy = y0 - d;
            if (yy >= 0 && im->data[(size_t)yy * w + x] < dark) {
                int top = yy;
                while (top > 0 && y0 - top < cap && img_get(im, x, top - 1) < dark)
                    top--;
                if (yy - top + 1 >= MIN_PARTNER_RUN) y0 = top;
                break;
            }
        }
        for (int d = 2; d <= look; d++) {
            int yy = y1 + d;
            if (yy < h && im->data[(size_t)yy * w + x] < dark) {
                int bot = yy;
                while (bot < h - 1 && bot - y1 < cap && img_get(im, x, bot + 1) < dark)
                    bot++;
                if (bot - yy + 1 >= MIN_PARTNER_RUN) y1 = bot;
                break;
            }
        }
        int len = y1 - y0 + 1;
        if (len <= cap) lens[n++] = len;
    }
    if (n < 8) return 0;
    for (int i = 1; i < n; i++) {
        int v = lens[i], j = i;
        while (j > 0 && lens[j - 1] > v) { lens[j] = lens[j - 1]; j--; }
        lens[j] = v;
    }
    int med = lens[n / 2];
    int kept = 0;
    for (int i = 0; i < n; i++)
        if (lens[i] <= med * 2 + 2) kept++;
    int t = lens[(int)(0.9f * (kept - 1))] + 2;
    return clampi(t, 1, max_t * 3);
}

/* Uniform box average of the energy over the (possibly double) width: a
 * double line's energy sits at the band edges, so unlike horizontal rules
 * the re-trace kernel must NOT be center-weighted. */
static img_u8 box_energy(const img_u8 *E, int thick) {
    int w = E->w, h = E->h;
    img_u8 out = img_new(w, h);
    if (!out.data) return out;
    int r = thick / 2 > 1 ? thick / 2 : 1;
    int norm = 2 * r + 1;
    for (int y = 0; y < h; y++) {
        uint16_t acc;
        uint8_t *dst = out.data + (size_t)y * w;
        for (int x = 0; x < w; x++) {
            uint32_t sum = 0;
            for (int o = -r; o <= r; o++)
                sum += E->data[(size_t)clampi(y + o, 0, h - 1) * w + x];
            dst[x] = (uint8_t)(sum / (uint32_t)norm);
        }
        (void)acc;
    }
    return out;
}

/* Vertical line finder, operating on the TRANSPOSED flat image (so the
 * margin line is a horizontal seam here). Assumes at most one line or one
 * close-together pair: candidates are traced with the slope-limited block
 * DP, edge-rejected, the best survivor's (possibly double) thickness is
 * probed, and the seam is re-traced on a box-averaged thick energy in the
 * same area. Returns 0 or 1. */
static int trace_vertical(const img_u8 *im, int kernel, float thresh,
                          int band, int slope, int max_t, int dark,
                          int16_t **out_trace, int *out_thick) {
    int w = im->w, h = im->h;
    img_u8 E = energy_h(im, kernel);
    if (!E.data) return 0;
    int S = clampi(20 / slope, 1, 20);
    int wb;
    uint16_t *Eb = block_sum(&E, S, &wb);
    if (!Eb) return 0;

    int cand[12];
    int nc = find_candidates(&E, clampi(w / 8, kernel, w), 12, thresh * 0.5f,
                             12, cand);
    if (nc == 0) return 0;

    int Ha = 2 * band + 1;
    float *dp0 = (float *)arena_alloc(sizeof(float) * Ha);
    float *dp1 = (float *)arena_alloc(sizeof(float) * Ha);
    int8_t *choice = (int8_t *)arena_alloc((size_t)wb * Ha);
    if (!dp0 || !dp1 || !choice) return 0;

    /* trace every candidate; keep the strongest one that isn't a page edge */
    int16_t *best = NULL;
    float best_mean = 0;
    for (int i = 0; i < nc; i++) {
        int16_t *tr = (int16_t *)arena_alloc(sizeof(int16_t) * w);
        if (!tr) return 0;
        float mean = trace_seam_block(Eb, wb, h, S, w, cand[i], band, dp0, dp1,
                                      choice, tr);
        if (mean < MEAN_FLOOR) continue;
        if (!edge_test(im, tr, dark, max_t)) continue;
        if (mean > best_mean) {
            best_mean = mean;
            best = tr;
        }
    }
    if (!best) return 0;

    int thick = probe_thickness_double(im, best, dark, max_t);
    if (thick <= 0) thick = 3;
    thick += 2; /* extra margin so the removal band fully covers the line */

    /* re-trace on box-averaged energy, anchored to the found seam */
    img_u8 Ebox = box_energy(&E, thick);
    if (Ebox.data) {
        int wb2;
        uint16_t *Eb2 = block_sum(&Ebox, S, &wb2);
        int16_t *fin = (int16_t *)arena_alloc(sizeof(int16_t) * w);
        if (Eb2 && fin) {
            float m2 = trace_seam_block(Eb2, wb2, h, S, w, best[0], band, dp0,
                                        dp1, choice, fin);
            if (m2 >= MEAN_FLOOR && edge_test(im, fin, dark, max_t))
                best = fin;
        }
    }

    *out_trace = best;
    *out_thick = thick;
    return 1;
}

/* One full pair pass over an energy image: left-edge candidates, coupled
 * pair DP, greedy lowest-cost acceptance, dedup, pack sorted by y.
 * Returns rule count; packed traces land in *out_rules. When record_best
 * is set, the best pair's indices/energies go into g.best_*. */
static int pair_pass(const img_u8 *E, int kernel, float thresh, int min_gap,
                     int max_gap, int band, int slope, int skew,
                     int max_rules, int record_best, int16_t **out_rules) {
    int w = E->w, h = E->h;

    /* candidate starts from the left region of the energy map */
    int left_w = clampi(w / 8, kernel, w);
    int max_c = max_rules + 8;
    int *cand = (int *)arena_alloc(sizeof(int) * max_c);
    if (!cand) return 0;
    int nc = find_candidates(E, left_w, min_gap, thresh * 0.5f, max_c, cand);
    if (nc == 0) return 0;

    int S = clampi(20 / slope, 1, 20);
    int wb;
    uint16_t *Eb = block_sum(E, S, &wb);
    if (!Eb) return 0;

    /* form pairs: each candidate with its next 1-2 neighbors below */
    int Ha = 2 * band + 1, D = 2 * skew + 1;
    float *dp0 = (float *)arena_alloc(sizeof(float) * Ha * D);
    float *dp1 = (float *)arena_alloc(sizeof(float) * Ha * D);
    int8_t *choice = (int8_t *)arena_alloc((size_t)wb * Ha * D);
    pair_res *pairs = (pair_res *)arena_alloc(sizeof(pair_res) * max_c * 2);
    if (!dp0 || !dp1 || !choice || !pairs) return 0;

    int np = 0;
    for (int i = 0; i < nc; i++) {
        for (int j = i + 1; j <= i + 2 && j < nc; j++) {
            int gap = cand[j] - cand[i];
            if (gap < min_gap || gap > max_gap || gap - skew < 3) continue;
            if (np >= max_c * 2) break;
            pair_res *p = &pairs[np];
            p->a = (int16_t *)arena_alloc(sizeof(int16_t) * w);
            p->b = (int16_t *)arena_alloc(sizeof(int16_t) * w);
            if (!p->a || !p->b) return 0;
            if (trace_pair(Eb, wb, h, S, w, cand[i], cand[j], band, skew,
                           dp0, dp1, choice,
                           p->a, p->b, &p->mean_a, &p->mean_b) == 0)
                np++;
        }
    }
    if (np == 0) return 0;

    qsort(pairs, np, sizeof(pair_res), cmp_pairs);
    float best_mean = 0;
    for (int i = 0; i < np; i++) {
        if (pairs[i].mean_a > best_mean) best_mean = pairs[i].mean_a;
        if (pairs[i].mean_b > best_mean) best_mean = pairs[i].mean_b;
    }
    float cut = thresh * best_mean;
    if (cut < MEAN_FLOOR) cut = MEAN_FLOOR;

    /* greedy accept: best pairs first, dedup shared members */
    int16_t **acc = (int16_t **)arena_alloc(sizeof(int16_t *) * max_rules);
    float *acc_my = (float *)arena_alloc(sizeof(float) * max_rules);
    if (!acc || !acc_my) return 0;
    int count = 0;
    for (int i = 0; i < np && count < max_rules; i++) {
        int16_t *members[2] = {pairs[i].a, pairs[i].b};
        float means[2] = {pairs[i].mean_a, pairs[i].mean_b};
        for (int m = 0; m < 2 && count < max_rules; m++) {
            if (means[m] < cut) continue;
            float my = trace_mean_y(members[m], w);
            int dup = 0;
            for (int p = 0; p < count && !dup; p++)
                if (acc_my[p] - my < min_gap * 0.5f &&
                    my - acc_my[p] < min_gap * 0.5f)
                    dup = 1;
            if (dup) continue;
            acc[count] = members[m];
            acc_my[count] = my;
            count++;
        }
    }
    if (count > 0) {
        /* sort by mean y and pack contiguously */
        for (int i = 1; i < count; i++)
            for (int j = i; j > 0 && acc_my[j - 1] > acc_my[j]; j--) {
                float tf = acc_my[j - 1];
                acc_my[j - 1] = acc_my[j];
                acc_my[j] = tf;
                int16_t *tp = acc[j - 1];
                acc[j - 1] = acc[j];
                acc[j] = tp;
            }
        int16_t *packed = (int16_t *)arena_alloc(sizeof(int16_t) * count * w);
        if (!packed) return 0;
        for (int i = 0; i < count; i++)
            memcpy(packed + (size_t)i * w, acc[i], sizeof(int16_t) * w);
        *out_rules = packed;
    }

    if (record_best) {
        /* pairs[0] is the lowest-cost pair; locate its members in the
         * packed list by pointer identity against acc[]. */
        g.best_ea = pairs[0].mean_a;
        g.best_eb = pairs[0].mean_b;
        for (int i = 0; i < count; i++) {
            if (acc[i] == pairs[0].a) g.best_a = i;
            if (acc[i] == pairs[0].b) g.best_b = i;
        }
    }
    return count;
}

/* Measure a rule's thickness by probing columns along its trace: vertical
 * dark run at the centerline. Probes whose run is far taller than typical
 * (text crossings) are discarded; result is the 90th percentile of the
 * rest plus padding for the anti-aliased skirt. */
static int probe_thickness(const img_u8 *im, const int16_t *trace, int dark,
                           int max_t) {
    int w = im->w, h = im->h;
    int step = w / 128 > 1 ? w / 128 : 1;
    int cap = max_t * 3 + 4;
    int lens[256];
    int n = 0;
    for (int x = step / 2; x < w && n < 256; x += step) {
        int yc = -1;
        for (int d = 0; d <= 2 && yc < 0; d++) {
            if (img_get(im, x, trace[x] + d) < dark) yc = trace[x] + d;
            else if (d && img_get(im, x, trace[x] - d) < dark) yc = trace[x] - d;
        }
        if (yc < 0) continue;
        int y0 = yc, y1 = yc;
        while (y0 > 0 && yc - y0 < cap && img_get(im, x, y0 - 1) < dark) y0--;
        while (y1 < h - 1 && y1 - yc < cap && img_get(im, x, y1 + 1) < dark) y1++;
        lens[n++] = y1 - y0 + 1;
    }
    if (n < 8) return 0;
    for (int i = 1; i < n; i++) {
        int v = lens[i], j = i;
        while (j > 0 && lens[j - 1] > v) { lens[j] = lens[j - 1]; j--; }
        lens[j] = v;
    }
    int med = lens[n / 2];
    /* discard crossing-inflated probes, take 90th percentile of the rest */
    int kept = 0;
    for (int i = 0; i < n; i++)
        if (lens[i] <= med * 2 + 2) kept++;
    int t = lens[(int)(0.9f * (kept - 1))] + 2; /* +2 anti-aliased skirt */
    return clampi(t, 1, max_t);
}

/* Center-weighted thick energy: triangle-weighted vertical average of the
 * (text-suppressed) opened energy over the measured rule thickness, so the
 * re-trace locks onto the rule's centerline instead of its darkest edge. */
static img_u8 weighted_energy(const img_u8 *E, int thick) {
    int w = E->w, h = E->h;
    img_u8 out = img_new(w, h);
    if (!out.data) return out;
    int r = thick / 2 > 1 ? thick / 2 : 1;
    int norm = 0;
    for (int o = -r; o <= r; o++) norm += r + 1 - (o < 0 ? -o : o);
    for (int y = 0; y < h; y++) {
        uint8_t *dst = out.data + (size_t)y * w;
        for (int o = -r; o <= r; o++) {
            int yy = clampi(y + o, 0, h - 1);
            const uint8_t *src = E->data + (size_t)yy * w;
            int wt = r + 1 - (o < 0 ? -o : o);
            if (o == -r)
                for (int x = 0; x < w; x++) dst[x] = 0;
            for (int x = 0; x < w; x++)
                dst[x] = (uint8_t)(dst[x] + src[x] * wt / norm);
        }
    }
    return out;
}

int stage_rules(void) {
    if (!g.flat.data) return 1;
    int w = g.flat.w;
    int kernel = clampi((int)PRM(P_RULE_KERNEL), 9, 301) | 1;
    float thresh = clampf(PRM(P_RULE_THRESH), 0.01f, 0.99f);
    int band = clampi((int)PRM(P_RULE_BAND), 2, 100);
    int slope = clampi((int)PRM(P_RULE_SLOPE), 1, 20);
    int skew = clampi((int)PRM(P_RULE_SKEW), 1, 40);
    int max_rules = clampi((int)PRM(P_RULE_MAX), 1, 200);
    int dark = clampi((int)PRM(P_LINE_DARK), 1, 254);
    int max_thick = clampi((int)PRM(P_LINE_MAX_THICK), 1, 40);

    g.n_rules = 0;
    g.n_vrules = 0;
    g.best_a = g.best_b = -1;
    g.best_ea = g.best_eb = 0;
    g.line_height = 0;

    /* rule spacing bounds: estimated from the page itself, or manual */
    int min_gap = clampi((int)PRM(P_RULE_MIN_GAP), 2, 200);
    int max_gap = clampi((int)PRM(P_RULE_MAX_GAP), min_gap + 2, 400);
    if (PRM(P_RULE_AUTO_GAP) > 0.5f) {
        float lh = estimate_line_height(&g.flat, dark);
        if (lh > 4.f) {
            g.line_height = lh;
            min_gap = clampi((int)(lh * 0.5f), 4, 200);
            max_gap = clampi((int)(lh * 1.5f), min_gap + 2, 400);
        }
    }

    img_u8 E = energy_h(&g.flat, kernel);
    if (!E.data) return 2;

    /* pass 1: detect rules on the plain opened energy */
    int16_t *rules1 = NULL;
    int n1 = pair_pass(&E, kernel, thresh, min_gap, max_gap, band, slope,
                       skew, max_rules, 0, &rules1);

    if (n1 > 0) {
        /* measure typical thickness from pass-1 traces, then re-trace on
         * center-weighted thick energy so seams sit on rule centerlines */
        int tsum = 0, tn = 0;
        for (int i = 0; i < n1; i++) {
            int t = probe_thickness(&g.flat, rules1 + (size_t)i * w, dark,
                                    max_thick);
            if (t > 0) { tsum += t; tn++; }
        }
        int t_global = tn > 0 ? (tsum + tn / 2) / tn : 3;

        img_u8 Ew = weighted_energy(&E, t_global);
        if (Ew.data) {
            g.n_rules = pair_pass(&Ew, kernel, thresh, min_gap, max_gap,
                                  band, slope, skew, max_rules, 1, &g.rule_y);
        }
        if (g.n_rules == 0) { /* re-trace failed: keep pass-1 result */
            g.rule_y = rules1;
            g.n_rules = n1;
        }

        /* final per-rule thickness for the removal stage */
        g.rule_thick = (int16_t *)arena_alloc(sizeof(int16_t) * g.n_rules);
        if (!g.rule_thick) return 2;
        for (int i = 0; i < g.n_rules; i++) {
            int t = probe_thickness(&g.flat, g.rule_y + (size_t)i * w, dark,
                                    max_thick);
            g.rule_thick[i] = (int16_t)(t > 0 ? t : t_global);
        }
    }
    /* NOTE: no single-seam fallback for horizontal rules — rules are only
     * ever accepted as members of a parallel pair. */

    if (PRM(P_VRULE_ENABLE) > 0.5f) {
        img_u8 t = transpose_u8(&g.flat);
        if (t.data) {
            int16_t *vtrace = NULL;
            int vthick = 0;
            if (trace_vertical(&t, kernel, thresh, band, slope, max_thick,
                               HW_VLINE_DARK, &vtrace, &vthick)) {
                g.vrule_x = vtrace;
                g.n_vrules = 1;
                g.vrule_thick = (int16_t *)arena_alloc(sizeof(int16_t));
                if (!g.vrule_thick) return 2;
                g.vrule_thick[0] = (int16_t)vthick;
            }
        }
    }
    return 0;
}
