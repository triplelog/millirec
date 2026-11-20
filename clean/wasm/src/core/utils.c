#include "utils.h"
#include <string.h>
#include <math.h>

img_u8 downscale_area(const img_u8 *src, int ow, int oh) {
    img_u8 out = img_new(ow, oh);
    if (!out.data) return out;
    for (int oy = 0; oy < oh; oy++) {
        int y0 = (int)((int64_t)oy * src->h / oh);
        int y1 = (int)((int64_t)(oy + 1) * src->h / oh);
        if (y1 <= y0) y1 = y0 + 1;
        if (y1 > src->h) y1 = src->h;
        for (int ox = 0; ox < ow; ox++) {
            int x0 = (int)((int64_t)ox * src->w / ow);
            int x1 = (int)((int64_t)(ox + 1) * src->w / ow);
            if (x1 <= x0) x1 = x0 + 1;
            if (x1 > src->w) x1 = src->w;
            uint32_t sum = 0;
            for (int y = y0; y < y1; y++) {
                const uint8_t *row = src->data + (size_t)y * src->w;
                for (int x = x0; x < x1; x++) sum += row[x];
            }
            out.data[(size_t)oy * ow + ox] =
                (uint8_t)(sum / (uint32_t)((y1 - y0) * (x1 - x0)));
        }
    }
    return out;
}

void box_blur_u8(img_u8 *im, int radius) {
    if (radius < 1) return;
    int w = im->w, h = im->h;
    img_u8 tmp = img_new(w, h);
    if (!tmp.data) return;
    /* horizontal */
    for (int y = 0; y < h; y++) {
        const uint8_t *row = im->data + (size_t)y * w;
        uint8_t *out = tmp.data + (size_t)y * w;
        for (int x = 0; x < w; x++) {
            int x0 = clampi(x - radius, 0, w - 1);
            int x1 = clampi(x + radius, 0, w - 1);
            /* naive inner loop is fine: only used on small images */
            uint32_t sum = 0;
            for (int i = x0; i <= x1; i++) sum += row[i];
            out[x] = (uint8_t)(sum / (uint32_t)(x1 - x0 + 1));
        }
    }
    /* vertical */
    for (int x = 0; x < w; x++) {
        for (int y = 0; y < h; y++) {
            int y0 = clampi(y - radius, 0, h - 1);
            int y1 = clampi(y + radius, 0, h - 1);
            uint32_t sum = 0;
            for (int i = y0; i <= y1; i++) sum += tmp.data[(size_t)i * w + x];
            im->data[(size_t)y * w + x] = (uint8_t)(sum / (uint32_t)(y1 - y0 + 1));
        }
    }
}

/* Sliding-window extrema by van Herk / Gil-Werman: the window [i-r, i+r] is
 * covered by a suffix of one block of 2r+1 and a prefix of the next, so three
 * linear passes (block prefix extrema, block suffix extrema, combine) give
 * every window with no data-dependent branching. The monotone deque this
 * replaces was O(n) too, but ran a branchy loop per element over strided
 * memory and capped the sequence at 8192 elements silently; this has no cap.
 *
 * Border handling is the deque's exactly: the window is truncated at both
 * ends of the sequence (a virtual pad of +inf for the min, -inf for the max),
 * and a window of L even is the same 2*(L/2)+1 wide window it was. */
#define SW_SCRATCH 16384
static uint8_t sw_g[SW_SCRATCH], sw_h[SW_SCRATCH];

static void sliding_ext_u8(const uint8_t *src, uint8_t *dst, int n, int stride,
                           int L, int want_max) {
    if (n <= 0) return;
    if (L < 1) L = 1;
    int r = L / 2;
    if (r == 0) {
        for (int i = 0; i < n; i++) dst[(size_t)i * stride] = src[(size_t)i * stride];
        return;
    }
    int B = 2 * r + 1;
    uint8_t pad = want_max ? 0 : 255;
    uint8_t *g = sw_g, *h = sw_h;
    if (n > SW_SCRATCH) {
        g = (uint8_t *)arena_alloc((size_t)n * 2);
        if (!g) return;
        h = g + n;
    }
    /* prefix extrema within each block */
    for (int i = 0; i < n; i++) {
        uint8_t a = src[(size_t)i * stride];
        if (i % B == 0) g[i] = a;
        else {
            uint8_t p = g[i - 1];
            g[i] = want_max ? (a > p ? a : p) : (a < p ? a : p);
        }
    }
    /* suffix extrema within each block (the last block ends at n-1) */
    for (int i = n - 1; i >= 0; i--) {
        uint8_t a = src[(size_t)i * stride];
        if (i == n - 1 || i % B == B - 1) h[i] = a;
        else {
            uint8_t p = h[i + 1];
            h[i] = want_max ? (a > p ? a : p) : (a < p ? a : p);
        }
    }
    /* combine: window [s, e] = suffix from s + prefix to e */
    int lastBlock = (n - 1) / B;
    for (int j = 0; j < n; j++) {
        int s = j - r, e = j + r;
        uint8_t hs = s < 0 ? pad : h[s];
        uint8_t ge = e < n ? g[e] : (e / B == lastBlock ? g[n - 1] : pad);
        dst[(size_t)j * stride] = want_max ? (hs > ge ? hs : ge) : (hs < ge ? hs : ge);
    }
}

void sliding_min_u8(const uint8_t *src, uint8_t *dst, int n, int stride, int L) {
    sliding_ext_u8(src, dst, n, stride, L, 0);
}

void sliding_max_u8(const uint8_t *src, uint8_t *dst, int n, int stride, int L) {
    sliding_ext_u8(src, dst, n, stride, L, 1);
}

void open_horizontal(const img_u8 *src, img_u8 *dst, int L) {
    img_u8 tmp = img_new(src->w, src->h);
    if (!tmp.data || !dst->data) return;
    for (int y = 0; y < src->h; y++) {
        sliding_min_u8(src->data + (size_t)y * src->w,
                       tmp.data + (size_t)y * src->w, src->w, 1, L);
        sliding_max_u8(tmp.data + (size_t)y * src->w,
                       dst->data + (size_t)y * src->w, src->w, 1, L);
    }
}

void max_filter_sq(img_u8 *im, int r) {
    if (r < 1) return;
    int L = 2 * r + 1;
    img_u8 tmp = img_new(im->w, im->h);
    if (!tmp.data) return;
    for (int y = 0; y < im->h; y++)
        sliding_max_u8(im->data + (size_t)y * im->w,
                       tmp.data + (size_t)y * im->w, im->w, 1, L);
    for (int x = 0; x < im->w; x++)
        sliding_max_u8(tmp.data + x, im->data + x, im->h, im->w, L);
}

void min_filter_sq(img_u8 *im, int r) {
    if (r < 1) return;
    int L = 2 * r + 1;
    img_u8 tmp = img_new(im->w, im->h);
    if (!tmp.data) return;
    for (int y = 0; y < im->h; y++)
        sliding_min_u8(im->data + (size_t)y * im->w,
                       tmp.data + (size_t)y * im->w, im->w, 1, L);
    for (int x = 0; x < im->w; x++)
        sliding_min_u8(tmp.data + x, im->data + x, im->h, im->w, L);
}

img_u8 transpose_u8(const img_u8 *src) {
    img_u8 out = img_new(src->h, src->w);
    if (!out.data) return out;
    for (int y = 0; y < src->h; y++)
        for (int x = 0; x < src->w; x++)
            out.data[(size_t)x * src->h + y] = src->data[(size_t)y * src->w + x];
    return out;
}

int otsu_threshold(const img_u8 *im) {
    uint32_t hist[256] = {0};
    size_t n = (size_t)im->w * im->h;
    for (size_t i = 0; i < n; i++) hist[im->data[i]]++;
    double total = (double)n, sum = 0;
    for (int i = 0; i < 256; i++) sum += (double)i * hist[i];
    double sumB = 0, wB = 0, best = -1;
    int thr = 127;
    for (int t = 0; t < 256; t++) {
        wB += hist[t];
        if (wB == 0) continue;
        double wF = total - wB;
        if (wF == 0) break;
        sumB += (double)t * hist[t];
        double mB = sumB / wB, mF = (sum - sumB) / wF;
        double between = wB * wF * (mB - mF) * (mB - mF);
        if (between > best) { best = between; thr = t; }
    }
    return thr;
}

void gray_to_rgba(const img_u8 *im, uint8_t *rgba) {
    size_t n = (size_t)im->w * im->h;
    for (size_t i = 0; i < n; i++) {
        uint8_t v = im->data[i];
        rgba[i * 4 + 0] = v;
        rgba[i * 4 + 1] = v;
        rgba[i * 4 + 2] = v;
        rgba[i * 4 + 3] = 255;
    }
}

void set_px_rgba(uint8_t *rgba, int w, int h, int x, int y,
                 uint8_t r, uint8_t g, uint8_t b) {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    size_t i = ((size_t)y * w + x) * 4;
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = 255;
}

void draw_line_rgba(uint8_t *rgba, int w, int h,
                    float x0, float y0, float x1, float y1,
                    uint8_t r, uint8_t g, uint8_t b, int thick) {
    float dx = x1 - x0, dy = y1 - y0;
    float len = sqrtf(dx * dx + dy * dy);
    int steps = (int)len + 1;
    int t0 = -(thick / 2), t1 = thick - 1 + t0;
    for (int s = 0; s <= steps; s++) {
        float fx = x0 + dx * s / steps, fy = y0 + dy * s / steps;
        for (int oy = t0; oy <= t1; oy++)
            for (int ox = t0; ox <= t1; ox++)
                set_px_rgba(rgba, w, h, (int)(fx + 0.5f) + ox, (int)(fy + 0.5f) + oy,
                            r, g, b);
    }
}
