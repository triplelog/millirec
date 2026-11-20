#include "../hw.h"
#include <math.h>

/* Sauvola adaptive thresholding via integral images (O(1) per pixel).
 * t = mean * (1 + k * (std/R - 1)), R = 128. */

int stage_binarize(void) {
    if (!g.nolines.data) return 1;
    int w = g.nolines.w, h = g.nolines.h;
    int win = clampi((int)PRM(P_BIN_WINDOW), 7, 201) | 1;
    int r = win / 2;
    double k = clampf(PRM(P_BIN_K), 0.01f, 1.0f);
    const double R = 128.0;

    size_t iw = (size_t)w + 1, ih = (size_t)h + 1;
    uint32_t *isum = (uint32_t *)arena_alloc(iw * ih * sizeof(uint32_t));
    double *isq = (double *)arena_alloc(iw * ih * sizeof(double));
    g.binary = img_new(w, h);
    if (!isum || !isq || !g.binary.data) return 2;

    for (size_t x = 0; x < iw; x++) {
        isum[x] = 0;
        isq[x] = 0;
    }
    for (int y = 1; y <= h; y++) {
        uint32_t rowsum = 0;
        double rowsq = 0;
        isum[(size_t)y * iw] = 0;
        isq[(size_t)y * iw] = 0;
        const uint8_t *src = g.nolines.data + (size_t)(y - 1) * w;
        for (int x = 1; x <= w; x++) {
            uint32_t v = src[x - 1];
            rowsum += v;
            rowsq += (double)v * v;
            isum[(size_t)y * iw + x] = isum[(size_t)(y - 1) * iw + x] + rowsum;
            isq[(size_t)y * iw + x] = isq[(size_t)(y - 1) * iw + x] + rowsq;
        }
    }

    for (int y = 0; y < h; y++) {
        int y0 = clampi(y - r, 0, h - 1), y1 = clampi(y + r, 0, h - 1);
        const uint8_t *src = g.nolines.data + (size_t)y * w;
        uint8_t *dst = g.binary.data + (size_t)y * w;
        for (int x = 0; x < w; x++) {
            int x0 = clampi(x - r, 0, w - 1), x1 = clampi(x + r, 0, w - 1);
            double n = (double)(x1 - x0 + 1) * (y1 - y0 + 1);
            size_t a = (size_t)y0 * iw + x0, b = (size_t)y0 * iw + x1 + 1;
            size_t c = (size_t)(y1 + 1) * iw + x0, d = (size_t)(y1 + 1) * iw + x1 + 1;
            double sum = (double)isum[d] - isum[b] - isum[c] + isum[a];
            double sq = isq[d] - isq[b] - isq[c] + isq[a];
            double mean = sum / n;
            double var = sq / n - mean * mean;
            double std = var > 0 ? sqrt(var) : 0;
            double t = mean * (1.0 + k * (std / R - 1.0));
            dst[x] = src[x] < t ? 0 : 255;
        }
    }
    return 0;
}
