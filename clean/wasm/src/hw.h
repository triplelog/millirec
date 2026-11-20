#pragma once
#include "core/image.h"

/* Tunable parameters. Index order MUST match src/params.ts on the JS side. */
enum {
    P_WORK_MAXDIM = 0, /* working-image long edge, px */
    P_PAGE_ENABLE,     /* 0/1: detect paper boundary */
    P_PAGE_BLUR,       /* blur radius before paper threshold (detect scale) */
    P_PAGE_MORPH,      /* mask close radius (detect scale) */
    P_PAGE_MIN_AREA,   /* min quad area as fraction of frame */
    P_ILLUM_DOWN,      /* background estimated at 1/N scale */
    P_ILLUM_KERNEL,    /* close kernel at small scale, px (odd) */
    P_ILLUM_STRENGTH,  /* 0..1 blend of flattening */
    P_RULE_KERNEL,     /* min horizontal run length considered a rule, px */
    P_RULE_THRESH,     /* rule peak threshold, relative to strongest rule */
    P_RULE_AUTO_GAP,   /* 0/1: derive min/max spacing from estimated line height */
    P_RULE_MIN_GAP,    /* min vertical spacing between rules, px (manual) */
    P_RULE_MAX_GAP,    /* max gap between rules considered a pair (manual) */
    P_RULE_BAND,       /* max total vertical drift from left-edge start, px */
    P_RULE_SLOPE,      /* max vertical movement (px) per 20 horizontal px */
    P_RULE_SKEW,       /* max drift of a pair's gap from its left-edge value */
    P_RULE_MAX,        /* max number of rules */
    P_VRULE_ENABLE,    /* 0/1: also trace vertical divider lines */
    P_LINE_DARK,       /* pixels below this (post-flatten) count as ink */
    P_LINE_MAX_THICK,  /* cap on measured rule thickness, px */
    P_LINE_DELTA,      /* darker than expected seam color by this = text */
    P_LINE_WINDOW,     /* half-width of expected-color median window, px */
    P_LINE_EXTEND,     /* run must reach this far past the band = text */
    P_LINE_INPAINT,    /* diffusion iterations over erased pixels */
    P_BIN_WINDOW,      /* Sauvola window, px */
    P_BIN_K,           /* Sauvola k */
    P_SPECKLE_MIN,     /* remove ink blobs smaller than this area (0 = off) */
    P_BORDER_MARGIN,   /* remove components lying entirely within this many
                          px of an image edge (0 = off) */
    P_PAGE_MANUAL,     /* 0/1: skip auto page detection, trust g.quad as
                          already written by the caller via hw_quad() */
    P_PAGE_INSET,      /* shrink the detected quad toward its centre by this
                          fraction before warping, so sampling stays strictly
                          inside the paper and the desk cannot bleed in */
    P_PAGE_EDGE_COVER, /* fraction of an image border the paper mask may cover
                          before that border counts as "the sheet runs off the
                          picture here". Three such borders, or an opposite
                          pair, means no page rectangle is in frame. */
    HW_NPARAMS
};

/* Why stage_page declined to report a quad. Reported for diagnosis only —
 * every value except HW_QUAD_OK leaves the full frame in g.quad, which is
 * what every later stage then works on. */
enum {
    HW_QUAD_OK = 0,
    HW_QUAD_DISABLED,   /* P_PAGE_ENABLE off */
    HW_QUAD_NO_PAPER,   /* nothing bright enough to be paper */
    HW_QUAD_OVERFLOW,   /* the sheet runs past the frame: no edge to find */
    HW_QUAD_NO_HULL,    /* the component has no 4-sided outline */
    HW_QUAD_TOO_SMALL,  /* below P_PAGE_MIN_AREA */
    HW_QUAD_BAD_SHAPE   /* corner angles outside 45-135 deg, or degenerate */
};

typedef struct {
    /* input (owned via malloc, survives arena resets) */
    uint8_t *input; /* RGBA */
    int in_w, in_h;
    size_t in_cap;

    /* stage outputs (arena-owned, valid for one run) */
    img_u8 gray;       /* 1: downscaled grayscale working image */
    float quad[8];     /* 2: TL,TR,BR,BL in gray coords */
    int quad_found;
    float quad_score;  /* 2: 0..1 confidence — how strong and how complete the
                          intensity step across the four fitted edges was. A
                          quad fitted to a mask with no real paper edge under
                          it scores near 0 even though quad_found is 1. */
    int quad_reject;   /* 2: HW_QUAD_* — why no quad, when quad_found is 0 */
    int quad_overflow; /* 2: 0/1 — the paper covers three image borders, or an
                          opposite pair, so THE SHEET RUNS PAST THE PICTURE and
                          no page rectangle is in frame. Advisory, not a
                          rejection: the quad reported in that case is the
                          bright region's outline, which is still a better crop
                          than the raw frame, and the caller decides. */
    img_u8 warped;     /* 3: perspective-corrected page */
    img_u8 flat;       /* 4: illumination-flattened */
    int n_rules;       /* 5: traced horizontal rules */
    int16_t *rule_y;   /*    [n_rules][warped.w] y per column (centerline) */
    int16_t *rule_thick;   /* [n_rules] measured thickness, px */
    int n_vrules;
    int16_t *vrule_x;  /*    [n_vrules][warped.h] x per row */
    int16_t *vrule_thick;  /* [n_vrules] measured thickness, px */
    img_u8 nolines;    /* 6: rules removed */
    uint8_t *line_mask;    /* 6: per px: 0 untouched, 1 removed, 2 protected text */
    img_u8 binary;     /* 7: Sauvola binarized (0=ink, 255=paper) */
    img_u8 clean;      /* 8: despeckled */

    /* best (lowest-cost) traced pair, for debugging pair quality */
    int best_a, best_b;      /* indices into rule_y, or -1 */
    float best_ea, best_eb;  /* per-seam mean energy of the best pair */
    float line_height;       /* auto-estimated line height, px (0 = none) */

    float params[HW_NPARAMS];
} hw_ctx;

extern hw_ctx g;

#define PRM(i) (g.params[(i)])

/* Vertical (margin) lines are often fainter than horizontal rules after
 * grayscale flattening; they get their own, laxer ink threshold. */
#define HW_VLINE_DARK 225

int stage_gray(void);
int stage_page(void);
int stage_warp(void);
int stage_illum(void);
int stage_rules(void);
int stage_lines(void);
int stage_binarize(void);
int stage_despeckle(void);
