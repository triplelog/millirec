#pragma once
#include "image.h"

/* Area-average downscale to exactly ow x oh. */
img_u8 downscale_area(const img_u8 *src, int ow, int oh);

/* In-place separable box blur, clamped window, radius in px. */
void box_blur_u8(img_u8 *im, int radius);

/* Sliding window min/max over a strided 1D sequence (monotonic deque, O(n)).
 * Window of length L centered on each element, truncated at the borders. */
void sliding_min_u8(const uint8_t *src, uint8_t *dst, int n, int stride, int L);
void sliding_max_u8(const uint8_t *src, uint8_t *dst, int n, int stride, int L);

/* Grayscale morphology with a horizontal 1xL structuring element. */
void open_horizontal(const img_u8 *src, img_u8 *dst, int L);

/* Grayscale morphology with a (2r+1)^2 square structuring element, in place. */
void max_filter_sq(img_u8 *im, int r);
void min_filter_sq(img_u8 *im, int r);

img_u8 transpose_u8(const img_u8 *src);

int otsu_threshold(const img_u8 *im);

/* Preview helpers (RGBA byte buffers, w*h*4). */
void gray_to_rgba(const img_u8 *im, uint8_t *rgba);
void draw_line_rgba(uint8_t *rgba, int w, int h,
                    float x0, float y0, float x1, float y1,
                    uint8_t r, uint8_t g, uint8_t b, int thick);
void set_px_rgba(uint8_t *rgba, int w, int h, int x, int y,
                 uint8_t r, uint8_t g, uint8_t b);
