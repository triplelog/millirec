#pragma once
#include <stdint.h>
#include <stddef.h>

/* Single-channel 8-bit image. All pixel memory lives in the arena and is
 * invalidated by arena_reset() at the start of each pipeline run. */
typedef struct {
    uint8_t *data;
    int w, h;
} img_u8;

void *arena_alloc(size_t n);
void arena_reset(void);
size_t arena_used(void);

img_u8 img_new(int w, int h);          /* zero-filled */
img_u8 img_clone(const img_u8 *src);

static inline int clampi(int v, int lo, int hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}
static inline float clampf(float v, float lo, float hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

/* Clamped pixel read (edge replicate). */
static inline uint8_t img_get(const img_u8 *im, int x, int y) {
    x = clampi(x, 0, im->w - 1);
    y = clampi(y, 0, im->h - 1);
    return im->data[(size_t)y * im->w + x];
}
static inline uint8_t *img_px(const img_u8 *im, int x, int y) {
    return &im->data[(size_t)y * im->w + x];
}
