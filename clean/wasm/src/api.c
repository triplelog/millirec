#include "hw.h"
#include "core/utils.h"
#include <stdlib.h>
#include <string.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

hw_ctx g;

/* Preview buffer lives outside the arena so previews of a finished run can
 * be re-rendered without re-running stages. */
static uint8_t *pv = NULL;
static size_t pv_cap = 0;
static int pvw = 0, pvh = 0;

static uint8_t *pv_alloc(int w, int h) {
    size_t need = (size_t)w * h * 4;
    if (need > pv_cap) {
        free(pv);
        pv = (uint8_t *)malloc(need);
        pv_cap = pv ? need : 0;
    }
    pvw = w;
    pvh = h;
    return pv;
}

EXPORT int hw_nparams(void) { return HW_NPARAMS; }
EXPORT float *hw_params(void) { return g.params; }

EXPORT uint8_t *hw_set_input(int w, int h) {
    size_t need = (size_t)w * h * 4;
    if (need > g.in_cap) {
        free(g.input);
        g.input = (uint8_t *)malloc(need);
        g.in_cap = g.input ? need : 0;
    }
    if (!g.input) return NULL;
    g.in_w = w;
    g.in_h = h;
    return g.input;
}

static void clear_outputs(void) {
    memset(&g.gray, 0, (uint8_t *)&g.params - (uint8_t *)&g.gray);
}

EXPORT int hw_run_stage(int stage) {
    switch (stage) {
    case 1:
        arena_reset();
        clear_outputs();
        return stage_gray();
    case 2: return stage_page();
    case 3: return stage_warp();
    case 4: return stage_illum();
    case 5: return stage_rules();
    case 6: return stage_lines();
    case 7: return stage_binarize();
    case 8: return stage_despeckle();
    default: return 100;
    }
}

EXPORT int hw_preview_w(void) { return pvw; }
EXPORT int hw_preview_h(void) { return pvh; }
EXPORT int hw_quad_found(void) { return g.quad_found; }
EXPORT float *hw_quad(void) { return g.quad; }
/* 0..1 — how much of a real paper edge sits under the reported quad. The
 * detector reports success on any four corners it can fit, so `quad_found`
 * alone has never been enough to decide whether to trust the dewarp. */
EXPORT float hw_quad_score(void) { return g.quad_score; }
/* HW_QUAD_* — why there is no quad, for diagnosis. */
EXPORT int hw_quad_reject(void) { return g.quad_reject; }
/* 0/1 — the sheet runs past the picture, so the reported quad is the bright
 * region's outline rather than the paper's corners. Advisory: the crop is still
 * worth having, and only the caller knows whether a perspective correction it
 * cannot justify is acceptable. */
EXPORT int hw_quad_overflow(void) { return g.quad_overflow; }
EXPORT int hw_rule_count(void) { return g.n_rules; }
EXPORT int hw_vrule_count(void) { return g.n_vrules; }

EXPORT int hw_rule_y_at(int rule, int x) {
    if (!g.warped.data || rule < 0 || rule >= g.n_rules) return -1;
    return g.rule_y[(size_t)rule * g.warped.w + clampi(x, 0, g.warped.w - 1)];
}

EXPORT float hw_line_height(void) { return g.line_height; }

/* The page (stage 4, flattened) dimensions — what every rule trace is indexed
 * by. A caller that skips the stage-4 preview still needs them. */
EXPORT int hw_page_w(void) { return g.flat.data ? g.flat.w : 0; }
EXPORT int hw_page_h(void) { return g.flat.data ? g.flat.h : 0; }
/* The working-gray (stage 1) dimensions — the frame the page quad is in. */
EXPORT int hw_gray_w(void) { return g.gray.data ? g.gray.w : 0; }
EXPORT int hw_gray_h(void) { return g.gray.data ? g.gray.h : 0; }

EXPORT int hw_rule_thick(int rule) {
    if (rule < 0 || rule >= g.n_rules || !g.rule_thick) return -1;
    return g.rule_thick[rule];
}

EXPORT int hw_vrule_thick(int rule) {
    if (rule < 0 || rule >= g.n_vrules || !g.vrule_thick) return -1;
    return g.vrule_thick[rule];
}

EXPORT int hw_vrule_x_at(int rule, int y) {
    if (!g.warped.data || rule < 0 || rule >= g.n_vrules) return -1;
    return g.vrule_x[(size_t)rule * g.warped.h + clampi(y, 0, g.warped.h - 1)];
}
EXPORT int hw_best_pair_a(void) { return g.best_a; }
EXPORT int hw_best_pair_b(void) { return g.best_b; }
EXPORT float hw_best_pair_ea(void) { return g.best_ea; }
EXPORT float hw_best_pair_eb(void) { return g.best_eb; }

static uint8_t *render_gray(const img_u8 *im) {
    if (!im->data) return NULL;
    uint8_t *buf = pv_alloc(im->w, im->h);
    if (buf) gray_to_rgba(im, buf);
    return buf;
}

EXPORT uint8_t *hw_preview(int stage) {
    switch (stage) {
    case 1:
        return render_gray(&g.gray);
    case 2: {
        uint8_t *buf = render_gray(&g.gray);
        if (!buf) return NULL;
        /* green quad = detected page; orange = full-frame fallback */
        uint8_t r = g.quad_found ? 60 : 255;
        uint8_t gg = g.quad_found ? 220 : 140;
        uint8_t b = g.quad_found ? 60 : 40;
        for (int i = 0; i < 4; i++) {
            int j = (i + 1) & 3;
            draw_line_rgba(buf, pvw, pvh, g.quad[i * 2], g.quad[i * 2 + 1],
                           g.quad[j * 2], g.quad[j * 2 + 1], r, gg, b, 3);
        }
        return buf;
    }
    case 3:
        return render_gray(&g.warped);
    case 4:
        return render_gray(&g.flat);
    case 5: {
        uint8_t *buf = render_gray(&g.flat);
        if (!buf) return NULL;
        for (int rl = 0; rl < g.n_rules; rl++) {
            const int16_t *row = g.rule_y + (size_t)rl * g.flat.w;
            /* best (lowest-cost) pair in green, all other rules red */
            int best = (rl == g.best_a || rl == g.best_b);
            uint8_t r = best ? 40 : 255, gg = best ? 220 : 60, b = best ? 90 : 60;
            for (int x = 0; x < g.flat.w; x++)
                for (int d = -1; d <= 1; d++)
                    set_px_rgba(buf, pvw, pvh, x, row[x] + d, r, gg, b);
        }
        for (int rl = 0; rl < g.n_vrules; rl++) {
            const int16_t *col = g.vrule_x + (size_t)rl * g.flat.h;
            for (int y = 0; y < g.flat.h; y++)
                for (int d = -1; d <= 1; d++)
                    set_px_rgba(buf, pvw, pvh, col[y] + d, y, 70, 130, 255);
        }
        return buf;
    }
    case 6: {
        uint8_t *buf = render_gray(&g.nolines);
        if (!buf || !g.line_mask) return buf;
        /* classification tint: removed = red, protected text = green */
        size_t n = (size_t)g.nolines.w * g.nolines.h;
        for (size_t i = 0; i < n; i++) {
            uint8_t m = g.line_mask[i];
            if (!m) continue;
            uint8_t v = g.nolines.data[i];
            if (m == 1) {
                buf[i * 4 + 0] = (uint8_t)(v + (255 - v) * 45 / 100);
                buf[i * 4 + 1] = (uint8_t)(v * 62 / 100);
                buf[i * 4 + 2] = (uint8_t)(v * 62 / 100);
            } else {
                buf[i * 4 + 0] = (uint8_t)(v * 62 / 100);
                buf[i * 4 + 1] = (uint8_t)(v + (255 - v) * 55 / 100);
                buf[i * 4 + 2] = (uint8_t)(v * 62 / 100);
            }
        }
        return buf;
    }
    case 7:
        return render_gray(&g.binary);
    case 8:
        return render_gray(&g.clean);
    default:
        return NULL;
    }
}
