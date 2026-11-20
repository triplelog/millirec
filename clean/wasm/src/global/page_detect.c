#include "../hw.h"
#include "../core/utils.h"
#include <math.h>
#include <string.h>

/* Paper boundary detection.
 *
 *   ~400px thumbnail -> blur -> Otsu bright mask -> morphological close
 *   -> largest connected component
 *   -> does the sheet RUN PAST the picture?      (border coverage, advisory)
 *   -> convex hull -> maximum-area inscribed quadrilateral
 *   -> per-side least-squares refit on the hull
 *   -> per-side gradient snap at FULL working resolution
 *   -> validated quad + a confidence score (else full frame)
 *
 * THREE THINGS CHANGED HERE. The first is the interesting one, because the
 * obvious version of it was wrong.
 *
 * 1. THE DETECTOR REPORTS SUCCESS ON THE IMAGE BORDER, and there was no way to
 *    know. It takes the outline of the bright component and validates area and
 *    angles, and a close-up photo of paper — where the sheet runs past all four
 *    edges of the frame — passes both with a "quad" that is the frame itself.
 *    On two of five corpus photos that warped a square, evenly-lit page into a
 *    ~13 degree keystone (`clean/README.md`), silently, because the detector is
 *    confident. `cleanPage` learned to catch it afterwards by measuring whether
 *    the ruled lines got flatter — which works, costs a second Pass A, and is
 *    useless on unruled paper.
 *
 *    So: measure how much of each image border the paper covers. Three borders,
 *    or an opposite pair, and the paper's edge is not in the picture.
 *
 *    THE OBVIOUS THING TO DO WITH THAT IS DECLINE, AND IT MEASURES WORSE.
 *    Refusing the quad cost five words on the six-page photo corpus (2.84% ->
 *    4.12% WER) and the errors were phantom words — an inserted "rococo." on
 *    page A, an inserted "it's" on page C — read out of the frame's rim. The
 *    "bogus" quad had been earning its keep by accident: the bright component
 *    stops short of the dark rim, so warping to its outline CROPPED the rim
 *    away. A trim reconstructed from the mask's bounding box recovered most of
 *    that (4.12% -> 3.35%) and not all of it, because the real crop follows the
 *    page's rotation and a bounding box does not; a rim detector on top of it
 *    was worse again (5.15%), because this runs BEFORE illumination flattening
 *    and a shadowed edge is indistinguishable from a dark rim.
 *
 *    The quad is therefore still reported, and `quad_overflow` says it is the
 *    bright region's outline rather than the paper's corners. The crop is worth
 *    having; it is the PERSPECTIVE CORRECTION that is unjustified, and only a
 *    caller knows whether it has another way to check one. Photo corpus with
 *    the flag advisory: 2.84%, byte-identical to before this file changed.
 *
 * 2. CORNER EXTREMES ARE NOT CORNERS. min/max of x+y and x-y find the corners of
 *    an axis-aligned rectangle and drift off them as soon as the page is
 *    rotated, its corners are rounded, or a shadow puts a spur on the mask —
 *    each of which moves ONE corner and shears the whole page. Fitting the four
 *    SIDES and intersecting them uses every boundary pixel instead of four of
 *    them, so a rounded corner (which has no extreme point to find) and an
 *    occluded one (a thumb over the edge) both come out right.
 *
 * 3. THE ANSWER WAS QUANTISED TO THE THUMBNAIL. Corners were found at 400px and
 *    scaled up to the ~1500px working image, so one detection pixel is nearly
 *    four working pixels of error before anything else goes wrong. The final
 *    snap re-finds each edge at full resolution by looking for the intensity
 *    step across it, which is where the accuracy actually comes from — and its
 *    mean strength is `quad_score`, the confidence `quad_found` never was.
 *
 * (2) and (3) are not yet scored against ground truth: `/edgelab.html` collects
 * hand-annotated corners and `scripts/edgescore.mjs` measures against them. The
 * corpus number above says only that they cost nothing.
 *
 * Corner extremes assumed the page is roughly upright (rotation well under
 * 45 deg). The hull fit does not, but the TL/TR/BR/BL ordering at the end still
 * does, and that assumption holds for photos of notes. */

#define DETECT_DIM 400
#define MAX_HULL 2048
#define SNAP_SAMPLES 32

typedef struct { float x, y; } pt;

static double quad_area(const float *q) {
    double a = 0;
    for (int i = 0; i < 4; i++) {
        int j = (i + 1) & 3;
        a += (double)q[i * 2] * q[j * 2 + 1] - (double)q[j * 2] * q[i * 2 + 1];
    }
    return fabs(a) / 2.0;
}

static int quad_angles_ok(const float *q) {
    for (int i = 0; i < 4; i++) {
        int p = (i + 3) & 3, n = (i + 1) & 3;
        float ax = q[p * 2] - q[i * 2], ay = q[p * 2 + 1] - q[i * 2 + 1];
        float bx = q[n * 2] - q[i * 2], by = q[n * 2 + 1] - q[i * 2 + 1];
        float la = sqrtf(ax * ax + ay * ay), lb = sqrtf(bx * bx + by * by);
        if (la < 1 || lb < 1) return 0;
        float c = (ax * bx + ay * by) / (la * lb);
        float deg = acosf(clampf(c, -1.f, 1.f)) * 57.2958f;
        if (deg < 45.f || deg > 135.f) return 0;
    }
    return 1;
}

/* ---- convex hull (Andrew's monotone chain) ------------------------------- */

static float cross_z(pt o, pt a, pt b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

static int cmp_pt(const void *pa, const void *pb) {
    const pt *a = (const pt *)pa, *b = (const pt *)pb;
    if (a->x < b->x) return -1;
    if (a->x > b->x) return 1;
    if (a->y < b->y) return -1;
    if (a->y > b->y) return 1;
    return 0;
}

/* Insertion sort — the point set is the component's per-row and per-column
 * extremes, so it is at most 2*(dw+dh) ~ 1600 entries and mostly sorted
 * already. Avoids pulling qsort's comparator indirection into the wasm. */
static void sort_pts(pt *p, int n) {
    for (int i = 1; i < n; i++) {
        pt v = p[i];
        int j = i;
        while (j > 0 && cmp_pt(&p[j - 1], &v) > 0) { p[j] = p[j - 1]; j--; }
        p[j] = v;
    }
}

static int convex_hull(pt *p, int n, pt *out, int cap) {
    if (n < 3) return 0;
    sort_pts(p, n);
    int k = 0;
    for (int i = 0; i < n; i++) {
        while (k >= 2 && cross_z(out[k - 2], out[k - 1], p[i]) <= 0) k--;
        if (k >= cap) return 0;
        out[k++] = p[i];
    }
    int lower = k + 1;
    for (int i = n - 2; i >= 0; i--) {
        while (k >= lower && cross_z(out[k - 2], out[k - 1], p[i]) <= 0) k--;
        if (k >= cap) return 0;
        out[k++] = p[i];
    }
    return k - 1; /* last point repeats the first */
}

/* ---- maximum-area inscribed quadrilateral -------------------------------- */

static float tri_area(pt a, pt b, pt c) {
    return fabsf((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) * 0.5f;
}

/*
 * For each DIAGONAL (i, k) of the hull, the best quadrilateral through it is the
 * farthest point on each side — so the search is over diagonals, not over
 * 4-tuples. Both inner scans advance monotonically as k advances (the farthest
 * point from a lengthening chord cannot move backwards), which is what keeps
 * this O(n^2) instead of O(n^4).
 *
 * The maximum-area quad is the right objective because the mask's boundary is
 * the paper's outline plus noise: the four extreme SIDES of that outline are the
 * page, and every spur, notch and shadow bite is interior to them.
 */
static int max_area_quad(const pt *h, int n, int *idx) {
    if (n < 4) return 0;
    float best = -1;
    for (int i = 0; i < n; i++) {
        int a = (i + 1) % n, b = (i + 3) % n;
        for (int k = i + 2; k < n; k++) {
            /* farthest hull point on the (i..k) side */
            while (a % n != k) {
                int na = (a + 1) % n;
                if (tri_area(h[i], h[k], h[na]) <= tri_area(h[i], h[k], h[a % n])) break;
                a = na;
            }
            /* farthest hull point on the (k..i) side */
            if (b < k + 1) b = k + 1;
            while (b % n != i) {
                int nb = (b + 1) % n;
                if (tri_area(h[i], h[k], h[nb % n]) <= tri_area(h[i], h[k], h[b % n])) break;
                b = nb;
            }
            float area = tri_area(h[i], h[k], h[a % n]) + tri_area(h[i], h[k], h[b % n]);
            if (area > best) {
                best = area;
                idx[0] = i; idx[1] = a % n; idx[2] = k; idx[3] = b % n;
            }
        }
    }
    return best > 0;
}

/* ---- line fitting -------------------------------------------------------- */

/* A line as a unit normal and offset: n.x*x + n.y*y = c. Kept in this form
 * rather than as y = mx + b because two of a page's four sides are vertical and
 * a slope form has no way to say so. */
typedef struct { float nx, ny, c; } line;

/* Total least squares over a point set (the principal axis through the
 * centroid). Ordinary least squares would be wrong here for the same reason:
 * it minimises error in one axis, and two of the four sides are near-vertical
 * in it. */
static int fit_line(const pt *p, const int *sel, int n, line *out) {
    if (n < 2) return 0;
    double mx = 0, my = 0;
    for (int i = 0; i < n; i++) { mx += p[sel[i]].x; my += p[sel[i]].y; }
    mx /= n; my /= n;
    double sxx = 0, syy = 0, sxy = 0;
    for (int i = 0; i < n; i++) {
        double dx = p[sel[i]].x - mx, dy = p[sel[i]].y - my;
        sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    double theta = 0.5 * atan2(2 * sxy, sxx - syy);   /* major axis direction */
    double dirx = cos(theta), diry = sin(theta);
    out->nx = (float)-diry;
    out->ny = (float)dirx;
    out->c = (float)(out->nx * mx + out->ny * my);
    return 1;
}

static int intersect(line a, line b, pt *out) {
    float det = a.nx * b.ny - a.ny * b.nx;
    if (fabsf(det) < 1e-6f) return 0;
    out->x = (a.c * b.ny - a.ny * b.c) / det;
    out->y = (a.nx * b.c - a.c * b.nx) / det;
    return 1;
}

/* Refit each side of the quad to the hull points that lie along it, then
 * re-derive the corners as the intersections. This is what makes a rounded or
 * occluded corner harmless: the corner is inferred from two SIDES, and neither
 * side needs a point anywhere near it. */
static int refine_sides(const pt *h, int n, const int *idx, float *quad) {
    line L[4];
    int sel[MAX_HULL];
    for (int s = 0; s < 4; s++) {
        int i0 = idx[s], i1 = idx[(s + 1) & 3];
        pt A = h[i0], B = h[i1];
        float ex = B.x - A.x, ey = B.y - A.y;
        float len = sqrtf(ex * ex + ey * ey);
        if (len < 4) return 0;
        /* hull points within a small band of the side's chord, excluding the
         * corner neighbourhoods where the outline turns */
        float tol = len * 0.03f + 1.5f;
        int m = 0;
        for (int k = 0; k < n; k++) {
            float dx = h[k].x - A.x, dy = h[k].y - A.y;
            float t = (dx * ex + dy * ey) / (len * len);
            if (t < 0.08f || t > 0.92f) continue;
            float d = fabsf(dx * ey - dy * ex) / len;
            if (d > tol) continue;
            sel[m++] = k;
        }
        if (m >= 4) {
            if (!fit_line(h, sel, m, &L[s])) return 0;
        } else {
            /* too few points along this side (a corner-to-corner straight edge
             * contributes nothing between its endpoints): use the chord */
            L[s].nx = -ey / len; L[s].ny = ex / len;
            L[s].c = L[s].nx * A.x + L[s].ny * A.y;
        }
    }
    for (int s = 0; s < 4; s++) {
        pt c;
        if (!intersect(L[(s + 3) & 3], L[s], &c)) return 0;
        quad[s * 2] = c.x;
        quad[s * 2 + 1] = c.y;
    }
    return 1;
}

/* ---- full-resolution edge snap ------------------------------------------- */

/*
 * The thumbnail says roughly where each edge is; the gray image says exactly.
 *
 * At each sample along a side, walk the inward normal and find where the
 * intensity step is steepest — the paper edge is a step from desk to paper, and
 * it is the only step within a few pixels of where the mask put it. Points that
 * find no real step (an edge lost in shadow, a sample that fell on a hand) are
 * dropped by a median-absolute-deviation cut before the refit, so one bad
 * sample cannot rotate a side.
 *
 * Returns the mean step strength, which is the raw material for the confidence
 * score: an edge that IS there produces a strong consistent step at every
 * sample, and an edge invented by the mask does not.
 */
static float snap_side(const img_u8 *im, pt A, pt B, pt C, line *out) {
    float ex = B.x - A.x, ey = B.y - A.y;
    float len = sqrtf(ex * ex + ey * ey);
    if (len < 8) return 0;
    ex /= len; ey /= len;
    /* inward normal: toward the quad's centroid */
    float nx = -ey, ny = ex;
    float mx = (A.x + B.x) * 0.5f, my = (A.y + B.y) * 0.5f;
    if (nx * (C.x - mx) + ny * (C.y - my) < 0) { nx = -nx; ny = -ny; }

    int R = clampi((int)(len * 0.02f), 4, 24);   /* search radius, px */
    pt found[SNAP_SAMPLES];
    float strength[SNAP_SAMPLES];
    int m = 0;
    for (int s = 0; s < SNAP_SAMPLES; s++) {
        float t = (s + 0.5f) / SNAP_SAMPLES;
        /* skip the corner tenth at each end: a corner is where two edges meet
         * and the profile across it is neither of them */
        if (t < 0.1f || t > 0.9f) continue;
        float px = A.x + ex * len * t, py = A.y + ey * len * t;
        float bestg = 0, bestd = 0;
        for (int d = -R; d <= R; d++) {
            /* central difference over +-2px along the normal, which is wide
             * enough to survive the edge's own anti-aliasing */
            float ax = px + nx * (d - 2), ay = py + ny * (d - 2);
            float bx = px + nx * (d + 2), by = py + ny * (d + 2);
            int a = img_get(im, (int)(ax + 0.5f), (int)(ay + 0.5f));
            int b = img_get(im, (int)(bx + 0.5f), (int)(by + 0.5f));
            float gval = (float)(b - a);   /* inward = brighter at a paper edge */
            if (gval > bestg) { bestg = gval; bestd = (float)d; }
        }
        if (bestg < 12) continue;          /* no step here worth calling an edge */
        found[m].x = px + nx * bestd;
        found[m].y = py + ny * bestd;
        strength[m] = bestg;
        m++;
    }
    if (m < 6) return 0;

    /* Drop outliers by distance from the chord through the found points, using a
     * median absolute deviation so a few samples that latched onto a shadow line
     * cannot drag the fit. */
    int sel[SNAP_SAMPLES];
    for (int i = 0; i < m; i++) sel[i] = i;
    line L0;
    if (!fit_line(found, sel, m, &L0)) return 0;
    float dev[SNAP_SAMPLES];
    for (int i = 0; i < m; i++)
        dev[i] = fabsf(L0.nx * found[i].x + L0.ny * found[i].y - L0.c);
    float sorted[SNAP_SAMPLES];
    memcpy(sorted, dev, sizeof(float) * m);
    for (int i = 1; i < m; i++) {
        float v = sorted[i];
        int j = i;
        while (j > 0 && sorted[j - 1] > v) { sorted[j] = sorted[j - 1]; j--; }
        sorted[j] = v;
    }
    float mad = sorted[m / 2];
    float cut = mad * 3.f + 1.5f;
    int keep = 0;
    float ssum = 0;
    for (int i = 0; i < m; i++)
        if (dev[i] <= cut) { sel[keep++] = i; ssum += strength[i]; }
    if (keep < 5) return 0;
    if (!fit_line(found, sel, keep, out)) return 0;
    return ssum / keep;
}

/* ---- stage --------------------------------------------------------------- */

int stage_page(void) {
    if (!g.gray.data) return 1;
    int gw = g.gray.w, gh = g.gray.h;

    /* manual override: caller already wrote the quad via hw_quad() — trust
     * it verbatim and skip detection entirely. */
    if (PRM(P_PAGE_MANUAL) >= 0.5f) {
        g.quad_found = 1;
        g.quad_score = 1.f;
        return 0;
    }

    /* default: full frame */
    float full[8] = {0, 0, (float)(gw - 1), 0,
                     (float)(gw - 1), (float)(gh - 1), 0, (float)(gh - 1)};
    memcpy(g.quad, full, sizeof(full));
    g.quad_found = 0;
    g.quad_score = 0;
    g.quad_reject = HW_QUAD_OK;
    if (PRM(P_PAGE_ENABLE) < 0.5f) { g.quad_reject = HW_QUAD_DISABLED; return 0; }

    /* thumbnail */
    int side = gw > gh ? gw : gh;
    int dw = gw, dh = gh;
    if (side > DETECT_DIM) {
        if (gw >= gh) { dw = DETECT_DIM; dh = gh * DETECT_DIM / gw; }
        else          { dh = DETECT_DIM; dw = gw * DETECT_DIM / gh; }
        if (dw < 1) dw = 1;
        if (dh < 1) dh = 1;
    }
    img_u8 d = downscale_area(&g.gray, dw, dh);
    if (!d.data) return 2;
    box_blur_u8(&d, clampi((int)PRM(P_PAGE_BLUR), 0, 16));

    /* bright mask (paper is the bright region) */
    int thr = otsu_threshold(&d);
    img_u8 mask = img_new(dw, dh);
    if (!mask.data) return 2;
    size_t n = (size_t)dw * dh;
    for (size_t i = 0; i < n; i++) mask.data[i] = d.data[i] > thr ? 255 : 0;

    int morph = clampi((int)PRM(P_PAGE_MORPH), 0, 20);
    if (morph > 0) {
        max_filter_sq(&mask, morph);
        min_filter_sq(&mask, morph);
    }

    /* largest 4-connected component via BFS labeling */
    int32_t *label = (int32_t *)arena_alloc(n * sizeof(int32_t));
    int32_t *stack = (int32_t *)arena_alloc(n * sizeof(int32_t));
    if (!label || !stack) return 2;
    memset(label, 0, n * sizeof(int32_t));
    int32_t next_label = 0, best_label = 0;
    size_t best_size = 0;
    for (size_t start = 0; start < n; start++) {
        if (!mask.data[start] || label[start]) continue;
        int32_t lab = ++next_label;
        size_t size = 0;
        int sp = 0;
        stack[sp++] = (int32_t)start;
        label[start] = lab;
        while (sp > 0) {
            int32_t idx = stack[--sp];
            size++;
            int x = idx % dw, y = idx / dw;
            const int nx[4] = {x - 1, x + 1, x, x};
            const int ny[4] = {y, y, y - 1, y + 1};
            for (int k = 0; k < 4; k++) {
                if (nx[k] < 0 || ny[k] < 0 || nx[k] >= dw || ny[k] >= dh) continue;
                int32_t ni = ny[k] * dw + nx[k];
                if (mask.data[ni] && !label[ni]) {
                    label[ni] = lab;
                    stack[sp++] = ni;
                }
            }
        }
        if (size > best_size) { best_size = size; best_label = lab; }
    }
    if (best_label == 0) { g.quad_reject = HW_QUAD_NO_PAPER; return 0; }

    /* IS THE PAPER EDGE IN FRAME AT ALL?
     *
     * Measure how much of each image border the component occupies. A sheet
     * photographed close up runs off the picture, and then there is no page
     * rectangle to find — but the mask is a big bright blob whose extremes are
     * the frame's own corners, so every geometric test downstream passes. This
     * is the check that was missing, and it is the cheapest one in the file. */
    float cover = clampf(PRM(P_PAGE_EDGE_COVER), 0.5f, 1.f);
    int cnt[4] = {0, 0, 0, 0};   /* top, right, bottom, left */
    for (int x = 0; x < dw; x++) {
        if (label[x] == best_label) cnt[0]++;
        if (label[(size_t)(dh - 1) * dw + x] == best_label) cnt[2]++;
    }
    for (int y = 0; y < dh; y++) {
        if (label[(size_t)y * dw + dw - 1] == best_label) cnt[1]++;
        if (label[(size_t)y * dw] == best_label) cnt[3]++;
    }
    float f[4] = {(float)cnt[0] / dw, (float)cnt[1] / dh,
                  (float)cnt[2] / dw, (float)cnt[3] / dh};
    int full_borders = 0;
    for (int k = 0; k < 4; k++) if (f[k] >= cover) full_borders++;
    /* Three borders covered means at most one edge is visible, which cannot make
     * a quad. An opposite PAIR covered means the sheet is wider (or taller) than
     * the frame, which cannot either — and that case can show only two. */
    g.quad_overflow = (full_borders >= 3 || (f[0] >= cover && f[2] >= cover)
                       || (f[1] >= cover && f[3] >= cover)) ? 1 : 0;

    /* boundary points: per-row and per-column extremes of the component. A
     * superset of the hull, at O(dw + dh) points instead of O(dw * dh). */
    pt *bp = (pt *)arena_alloc(sizeof(pt) * (size_t)(2 * (dw + dh) + 8));
    if (!bp) return 2;
    int nb = 0;
    for (int y = 0; y < dh; y++) {
        int lo = -1, hi = -1;
        for (int x = 0; x < dw; x++)
            if (label[(size_t)y * dw + x] == best_label) { if (lo < 0) lo = x; hi = x; }
        if (lo < 0) continue;
        bp[nb].x = (float)lo; bp[nb].y = (float)y; nb++;
        bp[nb].x = (float)hi; bp[nb].y = (float)y; nb++;
    }
    for (int x = 0; x < dw; x++) {
        int lo = -1, hi = -1;
        for (int y = 0; y < dh; y++)
            if (label[(size_t)y * dw + x] == best_label) { if (lo < 0) lo = y; hi = y; }
        if (lo < 0) continue;
        bp[nb].x = (float)x; bp[nb].y = (float)lo; nb++;
        bp[nb].x = (float)x; bp[nb].y = (float)hi; nb++;
    }

    pt *hull = (pt *)arena_alloc(sizeof(pt) * MAX_HULL);
    if (!hull) return 2;
    int nh = convex_hull(bp, nb, hull, MAX_HULL);
    if (nh < 4) { g.quad_reject = HW_QUAD_NO_HULL; return 0; }

    int idx[4];
    if (!max_area_quad(hull, nh, idx)) {
        g.quad_reject = HW_QUAD_NO_HULL;
       
        return 0;
    }

    float best[8];
    for (int i = 0; i < 4; i++) {
        best[i * 2] = hull[idx[i]].x;
        best[i * 2 + 1] = hull[idx[i]].y;
    }
    float refined[8];
    if (refine_sides(hull, nh, idx, refined)) {
        /* Accept the refit only if it stayed near the quad it refined. A side
         * with almost no support can fit the wrong thing, and a corner that
         * jumped a tenth of the page is that, not a correction. */
        float lim = 0.1f * (float)(dw > dh ? dw : dh);
        int ok = 1;
        for (int i = 0; i < 4; i++) {
            float dx = refined[i * 2] - best[i * 2];
            float dy = refined[i * 2 + 1] - best[i * 2 + 1];
            if (dx * dx + dy * dy > lim * lim) ok = 0;
            if (refined[i * 2] < -dw * 0.2f || refined[i * 2] > dw * 1.2f) ok = 0;
            if (refined[i * 2 + 1] < -dh * 0.2f || refined[i * 2 + 1] > dh * 1.2f) ok = 0;
        }
        if (ok) memcpy(best, refined, sizeof(best));
    }

    /* order TL, TR, BR, BL — the contract every later stage reads */
    {
        float cx = 0, cy = 0;
        for (int i = 0; i < 4; i++) { cx += best[i * 2]; cy += best[i * 2 + 1]; }
        cx /= 4; cy /= 4;
        float ord[8];
        int placed[4] = {0, 0, 0, 0};
        for (int i = 0; i < 4; i++) {
            int slot = (best[i * 2 + 1] < cy)
                ? (best[i * 2] < cx ? 0 : 1)
                : (best[i * 2] < cx ? 3 : 2);
            if (placed[slot]) {
                g.quad_reject = HW_QUAD_BAD_SHAPE;
               
                return 0;
            }
            placed[slot] = 1;
            ord[slot * 2] = best[i * 2];
            ord[slot * 2 + 1] = best[i * 2 + 1];
        }
        memcpy(best, ord, sizeof(ord));
    }

    /* validate at detection scale */
    double area = quad_area(best);
    double min_area = (double)PRM(P_PAGE_MIN_AREA) * dw * dh;
    if (area < min_area) { g.quad_reject = HW_QUAD_TOO_SMALL; return 0; }
    if (!quad_angles_ok(best)) { g.quad_reject = HW_QUAD_BAD_SHAPE; return 0; }

    /* scale to working-gray coordinates */
    float sx = (float)gw / dw, sy = (float)gh / dh;
    float q[8];
    for (int i = 0; i < 4; i++) {
        q[i * 2] = best[i * 2] * sx;
        q[i * 2 + 1] = best[i * 2 + 1] * sy;
    }

    /* SNAP TO THE REAL EDGES at working resolution, and score them. This is
     * where the accuracy is: everything above happened on a 400px thumbnail. */
    pt centre = {0, 0};
    for (int i = 0; i < 4; i++) { centre.x += q[i * 2] / 4; centre.y += q[i * 2 + 1] / 4; }
    line S[4];
    float str[4];
    int snapped = 0;
    for (int i = 0; i < 4; i++) {
        pt A = {q[i * 2], q[i * 2 + 1]};
        pt B = {q[((i + 1) & 3) * 2], q[((i + 1) & 3) * 2 + 1]};
        str[i] = snap_side(&g.gray, A, B, centre, &S[i]);
        if (str[i] > 0) snapped++;
    }
    /* All four or none: three snapped sides plus one chord gives a quad whose
     * fourth corner is a blend of two coordinate systems, which is worse than
     * the un-snapped quad it replaced. */
    if (snapped == 4) {
        float snapq[8];
        int ok = 1;
        for (int i = 0; i < 4; i++) {
            pt c;
            if (!intersect(S[(i + 3) & 3], S[i], &c)) { ok = 0; break; }
            snapq[i * 2] = c.x;
            snapq[i * 2 + 1] = c.y;
        }
        /* the snap corrects a thumbnail's worth of error, not a page's worth */
        float lim = 0.06f * (float)(gw > gh ? gw : gh);
        for (int i = 0; ok && i < 4; i++) {
            float dx = snapq[i * 2] - q[i * 2], dy = snapq[i * 2 + 1] - q[i * 2 + 1];
            if (dx * dx + dy * dy > lim * lim) ok = 0;
        }
        if (ok && quad_angles_ok(snapq)) memcpy(q, snapq, sizeof(q));
    }

    /* Confidence: how strong the four edge steps were, and how many of them were
     * found at all. A quad fitted to a mask with no real edges under it scores
     * near zero, which is what lets a caller decline it without re-deriving the
     * whole detection. 60 grey levels is a clean desk-to-paper step. */
    float mean_str = 0;
    for (int i = 0; i < 4; i++) mean_str += str[i];
    mean_str /= 4;
    g.quad_score = clampf(mean_str / 60.f, 0.f, 1.f) * ((float)snapped / 4.f);

    for (int i = 0; i < 4; i++) {
        g.quad[i * 2] = clampf(q[i * 2], 0, (float)(gw - 1));
        g.quad[i * 2 + 1] = clampf(q[i * 2 + 1], 0, (float)(gh - 1));
    }
    g.quad_found = 1;
    return 0;
}
