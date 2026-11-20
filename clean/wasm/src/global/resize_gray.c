#include "../hw.h"

/* RGBA input -> grayscale working image, area-averaged down to
 * P_WORK_MAXDIM on the long edge. */
int stage_gray(void) {
    if (!g.input) return 1;
    int w = g.in_w, h = g.in_h;
    int maxdim = clampi((int)PRM(P_WORK_MAXDIM), 200, 4000);
    int side = w > h ? w : h;

    int ow = w, oh = h;
    if (side > maxdim) {
        if (w >= h) {
            ow = maxdim;
            oh = (int)((int64_t)h * maxdim / w);
        } else {
            oh = maxdim;
            ow = (int)((int64_t)w * maxdim / h);
        }
        if (ow < 1) ow = 1;
        if (oh < 1) oh = 1;
    }

    g.gray = img_new(ow, oh);
    if (!g.gray.data) return 2;

    for (int oy = 0; oy < oh; oy++) {
        int y0 = (int)((int64_t)oy * h / oh);
        int y1 = (int)((int64_t)(oy + 1) * h / oh);
        if (y1 <= y0) y1 = y0 + 1;
        for (int ox = 0; ox < ow; ox++) {
            int x0 = (int)((int64_t)ox * w / ow);
            int x1 = (int)((int64_t)(ox + 1) * w / ow);
            if (x1 <= x0) x1 = x0 + 1;
            uint32_t sum = 0;
            for (int y = y0; y < y1; y++) {
                const uint8_t *px = g.input + ((size_t)y * w + x0) * 4;
                for (int x = x0; x < x1; x++, px += 4)
                    sum += (uint32_t)(px[0] * 77 + px[1] * 150 + px[2] * 29) >> 8;
            }
            g.gray.data[(size_t)oy * ow + ox] =
                (uint8_t)(sum / (uint32_t)((y1 - y0) * (x1 - x0)));
        }
    }
    return 0;
}
