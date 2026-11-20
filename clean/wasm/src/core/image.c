#include "image.h"
#include <stdlib.h>
#include <string.h>

/* Chunked bump arena. One reset per pipeline run; no per-image frees. */

typedef struct chunk {
    struct chunk *next;
    size_t used, cap;
} chunk;

#define CHUNK_MIN ((size_t)16 << 20)

static chunk *head = NULL;
static size_t total_used = 0;

void *arena_alloc(size_t n) {
    n = (n + 15) & ~(size_t)15;
    if (!head || head->used + n > head->cap) {
        size_t cap = n > CHUNK_MIN ? n : CHUNK_MIN;
        chunk *nc = (chunk *)malloc(sizeof(chunk) + cap);
        if (!nc) return NULL;
        nc->next = head;
        nc->used = 0;
        nc->cap = cap;
        head = nc;
    }
    void *p = (uint8_t *)(head + 1) + head->used;
    head->used += n;
    total_used += n;
    return p;
}

void arena_reset(void) {
    /* Keep the newest (largest-lived) chunk to avoid re-mallocing every run. */
    chunk *keep = head;
    if (keep) {
        chunk *c = keep->next;
        while (c) {
            chunk *nx = c->next;
            free(c);
            c = nx;
        }
        keep->next = NULL;
        keep->used = 0;
    }
    total_used = 0;
}

size_t arena_used(void) { return total_used; }

img_u8 img_new(int w, int h) {
    img_u8 im;
    im.w = w;
    im.h = h;
    im.data = (uint8_t *)arena_alloc((size_t)w * h);
    if (im.data) memset(im.data, 0, (size_t)w * h);
    return im;
}

img_u8 img_clone(const img_u8 *src) {
    img_u8 im = img_new(src->w, src->h);
    if (im.data) memcpy(im.data, src->data, (size_t)src->w * src->h);
    return im;
}
