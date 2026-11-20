#include "../hw.h"
#include <math.h>
#include <string.h>

/* Solve the 8x8 linear system for the homography h (h33 = 1) mapping
 * destination rect corners to the detected source quad, then inverse-map
 * with bilinear sampling. */

static int solve8(double A[8][9], double out[8]) {
    for (int col = 0; col < 8; col++) {
        int piv = col;
        for (int r = col + 1; r < 8; r++)
            if (fabs(A[r][col]) > fabs(A[piv][col])) piv = r;
        if (fabs(A[piv][col]) < 1e-12) return 1;
        if (piv != col)
            for (int c = 0; c < 9; c++) {
                double t = A[col][c];
                A[col][c] = A[piv][c];
                A[piv][c] = t;
            }
        for (int r = 0; r < 8; r++) {
            if (r == col) continue;
            double f = A[r][col] / A[col][col];
            for (int c = col; c < 9; c++) A[r][c] -= f * A[col][c];
        }
    }
    for (int i = 0; i < 8; i++) out[i] = A[i][8] / A[i][i];
    return 0;
}

static float edge_len(const float *q, int a, int b) {
    float dx = q[b * 2] - q[a * 2], dy = q[b * 2 + 1] - q[a * 2 + 1];
    return sqrtf(dx * dx + dy * dy);
}

static uint8_t bilinear(const img_u8 *im, float fx, float fy) {
    int x0 = (int)floorf(fx), y0 = (int)floorf(fy);
    float ax = fx - x0, ay = fy - y0;
    uint8_t p00 = img_get(im, x0, y0), p10 = img_get(im, x0 + 1, y0);
    uint8_t p01 = img_get(im, x0, y0 + 1), p11 = img_get(im, x0 + 1, y0 + 1);
    float top = p00 + (p10 - p00) * ax;
    float bot = p01 + (p11 - p01) * ax;
    return (uint8_t)(top + (bot - top) * ay + 0.5f);
}

int stage_warp(void) {
    if (!g.gray.data) return 1;
    if (!g.quad_found) {
        g.warped = img_clone(&g.gray);
        return g.warped.data ? 0 : 2;
    }

    /* Shrink the quad toward its centre before sampling.
     *
     * The detected corners sit ON the paper edge, so a sample taken exactly
     * there straddles the boundary and bilinear interpolation mixes in
     * whatever the paper is lying on. That left a one-pixel rim of desk around
     * every warped page — measured at 15% of the outermost ring being dark on
     * the synthetic fixture, against a clean interior one pixel further in.
     *
     * A fraction of a percent is enough to move every sample inside the paper.
     * It is a parameter because a photo with a soft or shadowed page edge may
     * want more, and one with writing running to the very edge may want less. */
    float qi[8];
    {
        const float *s0 = g.quad; /* TL,TR,BR,BL */
        float cx = (s0[0] + s0[2] + s0[4] + s0[6]) * 0.25f;
        float cy = (s0[1] + s0[3] + s0[5] + s0[7]) * 0.25f;
        float k = PRM(P_PAGE_INSET) * 0.01f;
        if (k < 0.f) k = 0.f;
        if (k > 0.25f) k = 0.25f;
        for (int i = 0; i < 4; i++) {
            qi[i * 2]     = s0[i * 2]     + (cx - s0[i * 2])     * k;
            qi[i * 2 + 1] = s0[i * 2 + 1] + (cy - s0[i * 2 + 1]) * k;
        }
    }
    const float *q = qi;
    int maxdim = clampi((int)PRM(P_WORK_MAXDIM), 200, 4000);
    int W = (int)((edge_len(q, 0, 1) + edge_len(q, 3, 2)) / 2.f + 0.5f);
    int H = (int)((edge_len(q, 0, 3) + edge_len(q, 1, 2)) / 2.f + 0.5f);
    W = clampi(W, 50, maxdim * 5 / 4);
    H = clampi(H, 50, maxdim * 5 / 4);

    /* dst corners -> src corners */
    double dst[4][2] = {{0, 0}, {W - 1, 0}, {W - 1, H - 1}, {0, H - 1}};
    double A[8][9];
    for (int i = 0; i < 4; i++) {
        double x = dst[i][0], y = dst[i][1];
        double u = q[i * 2], v = q[i * 2 + 1];
        double *r0 = A[i * 2], *r1 = A[i * 2 + 1];
        r0[0] = x; r0[1] = y; r0[2] = 1; r0[3] = 0; r0[4] = 0; r0[5] = 0;
        r0[6] = -x * u; r0[7] = -y * u; r0[8] = u;
        r1[0] = 0; r1[1] = 0; r1[2] = 0; r1[3] = x; r1[4] = y; r1[5] = 1;
        r1[6] = -x * v; r1[7] = -y * v; r1[8] = v;
    }
    double hm[8];
    if (solve8(A, hm)) {
        g.warped = img_clone(&g.gray);
        return g.warped.data ? 0 : 2;
    }

    g.warped = img_new(W, H);
    if (!g.warped.data) return 2;
    for (int y = 0; y < H; y++) {
        uint8_t *row = g.warped.data + (size_t)y * W;
        for (int x = 0; x < W; x++) {
            double den = hm[6] * x + hm[7] * y + 1.0;
            float sx = (float)((hm[0] * x + hm[1] * y + hm[2]) / den);
            float sy = (float)((hm[3] * x + hm[4] * y + hm[5]) / den);
            row[x] = bilinear(&g.gray, sx, sy);
        }
    }
    return 0;
}
