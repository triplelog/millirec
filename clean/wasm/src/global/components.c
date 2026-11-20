#include "../hw.h"
#include <string.h>

/* Despeckle: two-pass 8-connected component labeling (union-find) over ink
 * pixels; components smaller than P_SPECKLE_MIN are flipped to paper.
 * Components lying ENTIRELY within P_BORDER_MARGIN px of an image edge
 * (page-edge shadow ring) are also removed; anything extending into the
 * interior — including text chained to a leftover line — is never touched. */

static int32_t uf_find(int32_t *parent, int32_t i) {
    while (parent[i] != i) {
        parent[i] = parent[parent[i]]; /* path halving */
        i = parent[i];
    }
    return i;
}

static void uf_union(int32_t *parent, int32_t a, int32_t b) {
    a = uf_find(parent, a);
    b = uf_find(parent, b);
    if (a != b) parent[b > a ? b : a] = b > a ? a : b;
}

int stage_despeckle(void) {
    if (!g.binary.data) return 1;
    g.clean = img_clone(&g.binary);
    if (!g.clean.data) return 2;

    int min_area = (int)PRM(P_SPECKLE_MIN);
    int margin = clampi((int)PRM(P_BORDER_MARGIN), 0, 200);
    if (min_area < 1 && margin < 1) return 0;

    int w = g.clean.w, h = g.clean.h;
    size_t n = (size_t)w * h;
    int32_t *label = (int32_t *)arena_alloc(n * sizeof(int32_t));
    /* worst case: checkerboard -> n/2 labels; +1 for 1-based indexing */
    int32_t *parent = (int32_t *)arena_alloc((n / 2 + 2) * sizeof(int32_t));
    if (!label || !parent) return 2;
    memset(label, 0, n * sizeof(int32_t));

    int32_t next = 0;
    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            size_t i = (size_t)y * w + x;
            if (g.clean.data[i] != 0) continue; /* ink only */
            int32_t nb[4] = {0, 0, 0, 0};
            int cnt = 0;
            if (x > 0 && label[i - 1]) nb[cnt++] = label[i - 1];
            if (y > 0) {
                size_t up = i - w;
                if (label[up]) nb[cnt++] = label[up];
                if (x > 0 && label[up - 1]) nb[cnt++] = label[up - 1];
                if (x < w - 1 && label[up + 1]) nb[cnt++] = label[up + 1];
            }
            if (cnt == 0) {
                next++;
                parent[next] = next;
                label[i] = next;
            } else {
                int32_t m = nb[0];
                for (int j = 1; j < cnt; j++)
                    if (nb[j] < m) m = nb[j];
                label[i] = m;
                for (int j = 0; j < cnt; j++) uf_union(parent, m, nb[j]);
            }
        }
    }

    int32_t *area = (int32_t *)arena_alloc((size_t)(next + 1) * sizeof(int32_t));
    uint8_t *in_ring = (uint8_t *)arena_alloc((size_t)next + 1);
    if (!area || !in_ring) return 2;
    memset(area, 0, (size_t)(next + 1) * sizeof(int32_t));
    /* a component is "in the ring" only if EVERY pixel is near an edge */
    memset(in_ring, margin > 0 ? 1 : 0, (size_t)next + 1);
    for (size_t i = 0; i < n; i++) {
        if (!label[i]) continue;
        int32_t root = uf_find(parent, label[i]);
        area[root]++;
        int x = (int)(i % w), y = (int)(i / w);
        if (x >= margin && y >= margin && x < w - margin && y < h - margin)
            in_ring[root] = 0;
    }
    for (size_t i = 0; i < n; i++) {
        if (!label[i]) continue;
        int32_t root = uf_find(parent, label[i]);
        if ((min_area > 0 && area[root] < min_area) || in_ring[root])
            g.clean.data[i] = 255;
    }
    return 0;
}
