#include "../hw.h"
#include "../core/utils.h"
#include <string.h>

/* Rule removal over thick seams with dual-test text preservation.
 *
 * Each traced rule carries a measured thickness; the removal band is that
 * many rows centered on the traced centerline. Every band pixel is
 * classified by TWO tests, and only pixels passing BOTH are kept as text:
 *
 *  1. color test  — the pixel is radically darker than the rule's expected
 *     value at its band row. Expectation = running MEDIAN of that band row
 *     over a +-P_LINE_WINDOW px window along the seam (median, so the text
 *     we're detecting doesn't drag its own expectation), compared
 *     one-sided: only darker-than-expected counts.
 *  2. run test    — the vertical dark run through the pixel extends at
 *     least P_LINE_EXTEND px beyond the band edge (a crossing stroke
 *     continues above/below the rule; rule pixels don't).
 *
 * Everything else in the band is erased and blended to the background:
 * vertical interpolation from clean pixels outside the band, then a few
 * diffusion iterations. The classification is recorded per pixel
 * (1 = removed, 2 = protected text) for the stage-6 debug preview. */

/* Sliding-window median along the seam, O(1) per column: the histogram was
 * already incremental, but the median search restarted at bin 0 for every
 * column, so each band row cost W x 256. The median moves by a bin or two
 * between neighbouring windows, so it is carried along with the count of
 * samples strictly below it. Same answer by construction: both forms pick the
 * smallest value whose cumulative count exceeds half the window (seen*2 >
 * count  <=>  seen >= count/2 + 1). The JS twins (clean/passB/pipeline.ts
 * runningMedian, clean/trainImport.ts rowRunningMedian) already do this. */
static void expected_row(const img_u8 *im, const int16_t *trace, int off,
                         int winhw, uint8_t *out) {
    int w = im->w;
    uint16_t hist[256];
    memset(hist, 0, sizeof(hist));
    int count = 0;

    /* seed window [0, winhw] */
    for (int x = 0; x <= winhw && x < w; x++) {
        hist[img_get(im, x, trace[x] + off)]++;
        count++;
    }
    int med = 0, below = 0; /* below = samples strictly under med */
    for (int x = 0; x < w; x++) {
        if (x > 0) {
            int add = x + winhw, del = x - winhw - 1;
            if (add < w) {
                uint8_t v = img_get(im, add, trace[add] + off);
                hist[v]++;
                count++;
                if (v < med) below++;
            }
            if (del >= 0) {
                uint8_t v = img_get(im, del, trace[del] + off);
                hist[v]--;
                count--;
                if (v < med) below--;
            }
        }
        int k = count / 2 + 1;
        while (below + hist[med] < k) { below += hist[med]; med++; }
        while (below >= k) { med--; below -= hist[med]; }
        out[x] = (uint8_t)med;
    }
}

/* Fill mask==1 pixels by vertical interpolation from mask==0 pixels, then
 * diffusion-blend the filled pixels. mask==2 (protected text) is neither
 * filled nor used as a fill source. */
static void fill_and_blend(img_u8 *im, const uint8_t *mask, int reach,
                           int iters) {
    int w = im->w, h = im->h;
    /* Row order, not column order: the interpolation reads only mask-0 pixels
     * and writes only mask-1 pixels, so the result does not depend on the
     * order of the walk, and a row walk is the one the memory likes. */
    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            if (mask[(size_t)y * w + x] != 1) continue;
            int ya = -1, yb = -1;
            for (int d = 1; d <= reach; d++) {
                if (ya < 0 && y - d >= 0 && !mask[(size_t)(y - d) * w + x])
                    ya = y - d;
                if (yb < 0 && y + d < h && !mask[(size_t)(y + d) * w + x])
                    yb = y + d;
                if (ya >= 0 && yb >= 0) break;
            }
            uint8_t v;
            if (ya >= 0 && yb >= 0) {
                float t = (float)(y - ya) / (yb - ya);
                v = (uint8_t)(im->data[(size_t)ya * w + x] * (1 - t) +
                              im->data[(size_t)yb * w + x] * t + 0.5f);
            } else if (ya >= 0) v = im->data[(size_t)ya * w + x];
            else if (yb >= 0) v = im->data[(size_t)yb * w + x];
            else v = 250;
            im->data[(size_t)y * w + x] = v;
        }
    }

    if (iters > 0) {
        img_u8 tmp = img_clone(im);
        if (!tmp.data) return;
        uint8_t *a = im->data, *b = tmp.data;
        for (int it = 0; it < iters; it++) {
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    if (mask[(size_t)y * w + x] != 1) continue;
                    int x0 = clampi(x - 1, 0, w - 1), x1 = clampi(x + 1, 0, w - 1);
                    int y0 = clampi(y - 1, 0, h - 1), y1 = clampi(y + 1, 0, h - 1);
                    uint32_t sum = a[(size_t)y0 * w + x] + a[(size_t)y1 * w + x] +
                                   a[(size_t)y * w + x0] + a[(size_t)y * w + x1] +
                                   a[(size_t)y0 * w + x0] + a[(size_t)y0 * w + x1] +
                                   a[(size_t)y1 * w + x0] + a[(size_t)y1 * w + x1];
                    b[(size_t)y * w + x] = (uint8_t)(sum / 8);
                }
            }
            uint8_t *t = a;
            a = b;
            b = t;
        }
        if (a != im->data)
            memcpy(im->data, a, (size_t)w * h);
    }
}

static void remove_rules_dir(img_u8 *im, uint8_t *mask, int n_rules,
                             const int16_t *rules, const int16_t *thick,
                             int dark) {
    int w = im->w, h = im->h;
    int delta = clampi((int)PRM(P_LINE_DELTA), 1, 200);
    int winhw = clampi((int)PRM(P_LINE_WINDOW), 10, 400);
    int extend = clampi((int)PRM(P_LINE_EXTEND), 1, 20);
    int max_t = clampi((int)PRM(P_LINE_MAX_THICK), 1, 40);

    uint8_t *med = (uint8_t *)arena_alloc((size_t)w);
    if (!med) return;

    for (int r = 0; r < n_rules; r++) {
        const int16_t *rule = rules + (size_t)r * w;
        int hb = thick[r] / 2;
        if (hb < 1) hb = 1;

        for (int off = -hb; off <= hb; off++) {
            expected_row(im, rule, off, winhw, med);
            for (int x = 0; x < w; x++) {
                int y = rule[x] + off;
                if (y < 0 || y >= h) continue;
                size_t idx = (size_t)y * w + x;
                if (mask[idx] == 2) continue; /* claimed by another rule */
                uint8_t v = im->data[idx];

                /* test 1: radically darker than the expected rule color */
                int is_text = v + delta < med[x];

                /* test 2: dark run extends beyond the band (crossing) */
                if (is_text) {
                    int y_top = rule[x] - hb, y_bot = rule[x] + hb;
                    int up = y, down = y;
                    int reach = hb * 2 + extend + max_t;
                    while (up > 0 && y - up < reach &&
                           img_get(im, x, up - 1) < dark)
                        up--;
                    while (down < h - 1 && down - y < reach &&
                           img_get(im, x, down + 1) < dark)
                        down++;
                    is_text = (y_top - up >= extend) || (down - y_bot >= extend);
                }

                mask[idx] = is_text ? 2 : 1;
            }
        }
    }

    /* fill erased pixels from outside the band (protected text is dark —
     * never a fill source), then blend */
    fill_and_blend(im, mask, max_t * 4 + 4,
                   clampi((int)PRM(P_LINE_INPAINT), 0, 30));
}

int stage_lines(void) {
    if (!g.flat.data) return 1;
    int w = g.flat.w, h = g.flat.h;
    g.nolines = img_clone(&g.flat);
    if (!g.nolines.data) return 2;

    g.line_mask = (uint8_t *)arena_alloc((size_t)w * h);
    if (!g.line_mask) return 2;
    memset(g.line_mask, 0, (size_t)w * h);

    if (g.n_rules > 0)
        remove_rules_dir(&g.nolines, g.line_mask, g.n_rules, g.rule_y,
                         g.rule_thick, clampi((int)PRM(P_LINE_DARK), 1, 254));

    if (g.n_vrules > 0) {
        img_u8 t = transpose_u8(&g.nolines);
        img_u8 mt = {(uint8_t *)arena_alloc((size_t)w * h), h, w};
        if (!t.data || !mt.data) return 2;
        /* transpose the mask so cross-rule "claimed" checks stay coherent */
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
                mt.data[(size_t)x * h + y] = g.line_mask[(size_t)y * w + x];
        remove_rules_dir(&t, mt.data, g.n_vrules, g.vrule_x, g.vrule_thick,
                         HW_VLINE_DARK);
        img_u8 back = transpose_u8(&t);
        if (!back.data) return 2;
        g.nolines = back;
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
                g.line_mask[(size_t)y * w + x] = mt.data[(size_t)x * h + y];
    }

    /* rule intersections: where a horizontal band crosses a vertical band,
     * dark pixels are almost certainly the two printed lines meeting, not a
     * stroke — remove unconditionally, overriding text protection. */
    if (g.n_rules > 0 && g.n_vrules > 0) {
        uint8_t *m2 = (uint8_t *)arena_alloc((size_t)w * h);
        if (!m2) return 2;
        for (size_t i = 0; i < (size_t)w * h; i++)
            m2[i] = g.line_mask[i] == 2 ? 2 : 0; /* keep text out of sources */
        int any = 0;
        for (int v = 0; v < g.n_vrules; v++) {
            const int16_t *vtr = g.vrule_x + (size_t)v * h;
            int wv = g.vrule_thick[v] / 2 + 1;
            for (int r = 0; r < g.n_rules; r++) {
                const int16_t *htr = g.rule_y + (size_t)r * w;
                int hb = g.rule_thick[r] / 2 + 1;
                for (int x = 0; x < w; x++) {
                    int yc = htr[x];
                    int vx = vtr[clampi(yc, 0, h - 1)];
                    if (x < vx - wv || x > vx + wv) continue;
                    for (int y = yc - hb; y <= yc + hb; y++) {
                        if (y < 0 || y >= h) continue;
                        m2[(size_t)y * w + x] = 1;
                        g.line_mask[(size_t)y * w + x] = 1;
                        any = 1;
                    }
                }
            }
        }
        if (any) {
            int max_t = clampi((int)PRM(P_LINE_MAX_THICK), 1, 40);
            fill_and_blend(&g.nolines, m2, max_t * 4 + 4,
                           clampi((int)PRM(P_LINE_INPAINT), 0, 30));
        }
    }
    return 0;
}
