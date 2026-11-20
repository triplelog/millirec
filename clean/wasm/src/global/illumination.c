#include "../hw.h"
#include "../core/utils.h"

/* Estimate the smooth paper+lighting background at 1/N scale with a
 * grayscale close (removes dark ink, keeps shading), blur, upsample,
 * then DIVIDE the image by it. Division cancels multiplicative lighting
 * falloff, so any paper color/shadow normalizes to uniform near-white. */

int stage_illum(void) {
    if (!g.warped.data) return 1;
    int w = g.warped.w, h = g.warped.h;
    float strength = clampf(PRM(P_ILLUM_STRENGTH), 0.f, 1.f);

    g.flat = img_clone(&g.warped);
    if (!g.flat.data) return 2;
    if (strength <= 0.f) return 0;

    int D = clampi((int)PRM(P_ILLUM_DOWN), 2, 32);
    int sw = w / D > 4 ? w / D : 4;
    int sh = h / D > 4 ? h / D : 4;
    img_u8 bg = downscale_area(&g.warped, sw, sh);
    if (!bg.data) return 2;

    int k = clampi((int)PRM(P_ILLUM_KERNEL), 3, 63) | 1;
    max_filter_sq(&bg, k / 2); /* close: dilate then erode removes dark ink */
    min_filter_sq(&bg, k / 2);
    box_blur_u8(&bg, 2);

    for (int y = 0; y < h; y++) {
        float fy = ((float)y + 0.5f) * sh / h - 0.5f;
        int y0 = clampi((int)fy, 0, sh - 1);
        int y1 = clampi(y0 + 1, 0, sh - 1);
        float ay = clampf(fy - y0, 0.f, 1.f);
        uint8_t *row = g.flat.data + (size_t)y * w;
        const uint8_t *src = g.warped.data + (size_t)y * w;
        for (int x = 0; x < w; x++) {
            float fx = ((float)x + 0.5f) * sw / w - 0.5f;
            int x0 = clampi((int)fx, 0, sw - 1);
            int x1 = clampi(x0 + 1, 0, sw - 1);
            float ax = clampf(fx - x0, 0.f, 1.f);
            float top = bg.data[(size_t)y0 * sw + x0] * (1 - ax) +
                        bg.data[(size_t)y0 * sw + x1] * ax;
            float bot = bg.data[(size_t)y1 * sw + x0] * (1 - ax) +
                        bg.data[(size_t)y1 * sw + x1] * ax;
            float b = top + (bot - top) * ay;
            if (b < 10.f) b = 10.f;
            float v = src[x] * 255.f / b;
            if (v > 255.f) v = 255.f;
            row[x] = (uint8_t)(src[x] * (1.f - strength) + v * strength + 0.5f);
        }
    }
    return 0;
}
