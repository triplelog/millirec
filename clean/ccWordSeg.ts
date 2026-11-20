// Tesseract-free word segmentation for the editor import, ported from the tuned
// word-segmenter lab (packages/word-segmenter). Runs on a rule-removed grayscale
// page (see index.ts): connected components with the training-tool darkness-strength
// gate → per-blob CHARACTER boxes, where a small mark is kept only if it has a STEM
// BELOW it (i/j dot, accent) or hugs a letter on the baseline (period/comma), else it's
// a stray speck → dropped → blobs that OVERLAP in x on the same line merge into one
// character box (a dot rides its stem; touching letters fuse) → lines from the rule
// baselines → per-char CORE x-extent (thin horizontals ignored) → within-line gaps →
// 2-group split (with a line-height fallback) → WORD boxes. The word boxes feed Pass B
// (baseline / rule removal / normalize / SDF) exactly as the Tesseract boxes did.
//
// Also here: rule-finder refinements that complement Pass A's WASM tracer —
// detectRulesByRowInk (catch a rule the tracer missed as a long horizontal dark run),
// refineRuleTrace (snap a flat row-ink rule onto the real line via a band seam),
// mergeHRules, measureRuleThickness. `improveRules` bundles them.

import type { RuleTrace, BoxesJson, WordBox } from './types';
import { splitStrokes, resolveUnitLines } from './strokeSplit';
import { PAINT_ADD, PAINT_DARKISH } from './inkPaint';
import { cleanDebugOn } from './log';

// ── small helpers ─────────────────────────────────────────────────────────────

function medianOf(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
}

function ruleMedianY(r: RuleTrace): number {
  const s = r.y.slice().sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
}

/** Separable Chebyshev dilation of a binary mask by r px (bridge tiny stroke gaps). */
/** Binary dilation by a (2r+1) square, separable, via running window COUNTS —
 *  a pixel is on when its window holds any set pixel, and a count says that in
 *  O(1) whatever r is. The pass is the same as the two nested `!v` scans it
 *  replaces (same separable square, same border clamping), just without
 *  re-reading the window per pixel.
 *
 *  NOTE r <= 0 returns `src` ITSELF, not a copy — callers must treat the result
 *  as read-only (the one caller does; `bridgePx` 0 makes `bridged === ink`). */
function dilateMask(src: Uint8Array, W: number, H: number, r: number): Uint8Array {
  if (r <= 0) return src;
  const tmp = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let n = 0;
    for (let x = 0; x <= r && x < W; x++) n += src[row + x];
    for (let x = 0; x < W; x++) {
      if (x > 0) {
        const add = x + r, del = x - r - 1;
        if (add < W) n += src[row + add];
        if (del >= 0) n -= src[row + del];
      }
      tmp[row + x] = n > 0 ? 1 : 0;
    }
  }
  // The vertical pass walks ROWS with one running count per column: the same
  // window sums, read in memory order instead of striding down each column.
  const out = new Uint8Array(W * H);
  const n = new Int32Array(W);
  for (let y = 0; y <= r && y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) n[x] += tmp[row + x];
  }
  for (let y = 0; y < H; y++) {
    if (y > 0) {
      const add = y + r, del = y - r - 1;
      if (add < H) { const row = add * W; for (let x = 0; x < W; x++) n[x] += tmp[row + x]; }
      if (del >= 0) { const row = del * W; for (let x = 0; x < W; x++) n[x] -= tmp[row + x]; }
    }
    const row = y * W;
    for (let x = 0; x < W; x++) out[row + x] = n[x] > 0 ? 1 : 0;
  }
  return out;
}

// ── rule-finder refinements (complement Pass A) ───────────────────────────────

const SEAM_VMOVE_PENALTY = 40;

function paper85(gray: Uint8Array, W: number, H: number): number {
  const hist = new Int32Array(256);
  for (let i = 0; i < W * H; i++) hist[gray[i]]++;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= 0.85 * W * H) return v;
  }
  return 255;
}

/** Detect horizontal rules by ROW INK: a printed line is a long contiguous dark run
 *  spanning ≥ `minRunFrac` of the width — catches a rule the WASM tracer missed. */
export function detectRulesByRowInk(gray: Uint8Array, W: number, H: number, minRunFrac: number): RuleTrace[] {
  const darkT = Math.max(0, paper85(gray, W, H) - 30);
  const need = Math.round(minRunFrac * W);
  const ruley = new Uint8Array(H);
  for (let y = 0; y < H; y++) {
    const base = y * W;
    let run = 0;
    let best = 0;
    for (let x = 0; x < W; x++) {
      if (gray[base + x] < darkT) {
        run++;
        if (run > best) best = run;
      } else run = 0;
    }
    if (best >= need) ruley[y] = 1;
  }
  const rules: RuleTrace[] = [];
  let top = -1;
  for (let y = 0; y <= H; y++) {
    const on = y < H && ruley[y] === 1;
    if (on && top < 0) top = y;
    if (!on && top >= 0) {
      const bottom = y - 1;
      const center = Math.round((top + bottom) / 2);
      rules.push({ thickness: Math.max(2, bottom - top + 1), y: new Array<number>(W).fill(center) });
      top = -1;
    }
  }
  return rules;
}

/** Refine a flat row-ink rule into a per-column trace via a slope-capped seam within
 *  ±`bandHalf` px — follows the rule where it drifts and bridges its gaps. */
export function refineRuleTrace(gray: Uint8Array, W: number, H: number, centerY: number, bandHalf: number): number[] {
  const half = Math.max(0, Math.round(bandHalf));
  const cy = Math.round(centerY);
  if (half === 0) return new Array<number>(W).fill(cy);
  const y0 = Math.max(0, cy - half);
  const y1 = Math.min(H - 1, cy + half);
  const nY = y1 - y0 + 1;
  if (nY <= 1 || W < 1) return new Array<number>(W).fill(cy);
  const P = SEAM_VMOVE_PENALTY;
  const prev = new Float64Array(nY);
  for (let r = 0; r < nY; r++) prev[r] = gray[(y0 + r) * W];
  const cur = new Float64Array(nY);
  const back = new Int16Array(W * nY);
  for (let r = 0; r < nY; r++) back[r] = r;
  for (let x = 1; x < W; x++) {
    const col = x * nY;
    for (let r = 0; r < nY; r++) {
      let bR = r;
      let bV = prev[r];
      if (r > 0) {
        const v = prev[r - 1] + P;
        if (v < bV) {
          bV = v;
          bR = r - 1;
        }
      }
      if (r < nY - 1) {
        const v = prev[r + 1] + P;
        if (v < bV) {
          bV = v;
          bR = r + 1;
        }
      }
      cur[r] = gray[(y0 + r) * W + x] + bV;
      back[col + r] = bR;
    }
    prev.set(cur);
  }
  let bestR = 0;
  let bestV = Infinity;
  for (let r = 0; r < nY; r++) {
    if (prev[r] < bestV) {
      bestV = prev[r];
      bestR = r;
    }
  }
  const path = new Array<number>(W);
  let r = bestR;
  path[W - 1] = y0 + r;
  for (let x = W - 1; x >= 1; x--) {
    r = back[x * nY + r];
    path[x - 1] = y0 + r;
  }
  return path;
}

/** Merge two rule sets, dropping any extra rule within `minSpacing` of a primary one
 *  (primary wins — pass the WASM-traced rules first). Sorted top→bottom. */
export function mergeHRules(primary: RuleTrace[], extra: RuleTrace[], minSpacing: number): RuleTrace[] {
  const out = [...primary];
  for (const r of extra) {
    const my = ruleMedianY(r);
    if (out.some((o) => Math.abs(ruleMedianY(o) - my) < minSpacing)) continue;
    out.push(r);
  }
  out.sort((a, b) => ruleMedianY(a) - ruleMedianY(b));
  return out;
}

/** Measure each rule's actual vertical thickness (median dark run), so the removal
 *  band covers the whole rule. Runs > maxRun (crossing strokes) are ignored. */
export function measureRuleThickness(gray: Uint8Array, W: number, H: number, rules: RuleTrace[]): RuleTrace[] {
  const darkT = Math.max(0, paper85(gray, W, H) - 40);
  const maxRun = 20;
  const step = Math.max(1, Math.floor(W / 300));
  return rules.map((r) => {
    const runs: number[] = [];
    for (let x = 0; x < W; x += step) {
      const ry = Math.round(r.y[Math.min(x, r.y.length - 1)]);
      if (ry < 0 || ry >= H || gray[ry * W + x] >= darkT) continue;
      let up = ry;
      let down = ry;
      while (up - 1 >= 0 && gray[(up - 1) * W + x] < darkT) up--;
      while (down + 1 < H && gray[(down + 1) * W + x] < darkT) down++;
      const run = down - up + 1;
      if (run <= maxRun) runs.push(run);
    }
    runs.sort((a, b) => a - b);
    const th = runs.length ? runs[runs.length >> 1] : r.thickness;
    return { thickness: Math.max(2, Math.min(12, th)), y: r.y };
  });
}

export interface ImproveRulesOptions {
  /** Row-ink coverage fraction (a rule spans ≥ this of the width). Default 0.5. */
  ruleCoverage?: number;
  /** Seam band (px) to snap a flat row-ink rule onto the real line. Default 5. */
  snapBand?: number;
  /** Min spacing (px) between rules for the merge dedup. Default = 0.4·lineHeight. */
  minSpacing?: number;
}

/**
 * Complement the WASM-traced rules with row-ink detection (catch missed rules),
 * refine those onto the real line, merge, and measure real thickness. Returns the
 * improved rule set for both Pass B and the page-level rule removal.
 */
export function improveRules(
  gray: Uint8Array,
  W: number,
  H: number,
  traced: RuleTrace[],
  lineHeight: number,
  opts?: ImproveRulesOptions,
): RuleTrace[] {
  const cov = opts?.ruleCoverage ?? 0.5;
  const snap = opts?.snapBand ?? 5;
  const minSpacing = opts?.minSpacing ?? Math.max(6, Math.round(lineHeight * 0.4));
  const rowRules = detectRulesByRowInk(gray, W, H, cov).map((r) =>
    snap > 0 ? { thickness: r.thickness, y: refineRuleTrace(gray, W, H, ruleMedianY(r), snap) } : r,
  );
  const merged = mergeHRules(traced, rowRules, minSpacing);
  return measureRuleThickness(gray, W, H, merged);
}

export interface RuleGridResult {
  rules: RuleTrace[];
  /** median pitch used, 0 when the traced set was too irregular to extend */
  pitch: number;
  /** seeds added above the first traced rule / below the last / inside a gap */
  above: number;
  below: number;
  filled: number;
  /** seeds that were snapped but failed the darkness check */
  rejected: number;
}

/**
 * COMPLETE THE RULE GRID. Printed ruling is periodic; a tracer's output is not.
 *
 * Both mechanisms that find rules here score a candidate by how much clean
 * line-energy it carries — the WASM pair tracer against a fraction of the BEST
 * pair's mean (`seams.c` pair_pass), `detectRulesByRowInk` against an unbroken
 * dark run of half the FRAME width. Neither is a statement about where rules
 * ARE; both are statements about where a rule is easiest to see. So the rules
 * that go missing are systematically the ones under dense writing, in the
 * illumination-flattener's weakest corner, or wherever the sheet stops short of
 * the frame — and on a page written at the top and blank at the bottom that is
 * exactly the half that needed removing (warehouse1 lost its top 3 rules,
 * risks1 its top 8; both traced a clean grid over the empty paper below).
 *
 * Periodicity is the evidence the detectors throw away. Given a pitch the
 * traced set agrees on, every missing rule's position is KNOWN, so the question
 * stops being "can this rule be found" and becomes "is there faint print where
 * one is predicted" — a much easier question, asked at `paper - darkDelta`
 * rather than at the detector's bar. Seeds are snapped with the same banded
 * seam the faint-rules rescue uses and kept only when they run dark; a page
 * whose grid is already complete generates no seeds and is untouched.
 *
 * ADDITIVE BY CONSTRUCTION: a traced rule is never dropped or moved, so the
 * worst case is an extra rule the removal stage then erases.
 */
export function completeRuleGrid(
  gray: Uint8Array,
  W: number,
  H: number,
  rules: RuleTrace[],
  opts?: {
    /** how dark a predicted rule must run, below the page's paper level */
    darkDelta?: number;
    /** fraction of sampled interior columns that must be that dark */
    minCoverage?: number;
    /** columns nearer than this fraction of W to an edge are not sampled — a
     *  sheet that stops short of the frame, or a shadow the lift did not
     *  fully clear, lives there and no real rule can be dark in it */
    edgeMargin?: number;
    /** the traced gaps must agree this well (max relative MAD) to extend at all */
    maxPitchSpread?: number;
  },
): RuleGridResult {
  const darkDelta = opts?.darkDelta ?? 8;
  const minCoverage = opts?.minCoverage ?? 0.8;
  const edgeMargin = opts?.edgeMargin ?? 0.08;
  const maxSpread = opts?.maxPitchSpread ?? 0.12;
  const none: RuleGridResult = { rules, pitch: 0, above: 0, below: 0, filled: 0, rejected: 0 };
  if (rules.length < 4) return none;

  const sorted = rules.map((r) => ({ r, my: ruleMedianY(r) })).sort((a, b) => a.my - b.my);
  const gaps = sorted.slice(1).map((s, i) => s.my - sorted[i].my).filter((gp) => gp > 2);
  if (gaps.length < 3) return none;
  const sg = gaps.slice().sort((a, b) => a - b);
  const med0 = sg[sg.length >> 1];
  if (med0 <= 4) return none;
  // A gap is one pitch or an integer multiple of it; fold multiples down before
  // taking the pitch, so a page with three missing rules in a row does not
  // report a pitch of four.
  const unit = gaps.map((gp) => gp / Math.max(1, Math.round(gp / med0)));
  const su = unit.slice().sort((a, b) => a - b);
  const pitch = su[su.length >> 1];
  if (pitch <= 4) return none;
  // Spread test: the grid is only predictable if the traced gaps really are
  // multiples of one pitch. Median absolute deviation, relative.
  const dev = unit.map((u) => Math.abs(u - pitch)).sort((a, b) => a - b);
  if (dev[dev.length >> 1] / pitch > maxSpread) return none;

  const paper = paper85(gray, W, H);
  const darkT = Math.max(0, paper - darkDelta);
  const x0 = Math.round(W * edgeMargin);
  const x1 = Math.round(W * (1 - edgeMargin));
  const coverageOf = (y: number[]): number => {
    let dark = 0;
    let n = 0;
    for (let x = x0; x < x1; x += 3) {
      const yy = Math.round(y[Math.min(x, y.length - 1)] ?? 0);
      if (yy < 2 || yy >= H - 2) continue;
      n++;
      let v = 255;
      for (let dy = -2; dy <= 2; dy++) v = Math.min(v, gray[(yy + dy) * W + x]);
      if (v < darkT) dark++;
    }
    return n > 20 ? dark / n : 0;
  };

  const out = rules.slice();
  const res: RuleGridResult = { rules: out, pitch, above: 0, below: 0, filled: 0, rejected: 0 };

  // A PREDICTED RULE IS SHAPED LIKE ITS NEIGHBOURS, NOT RE-SEAMED FROM THE INK.
  // Snapping a seed with `refineRuleTrace` is right in the faint-rules rescue,
  // where nothing else is known — but here the neighbours are already traced,
  // and inside written text the darkest thing within a snap band is the
  // WRITING: the seam climbs onto letters, the removal then erases along that
  // wandering path, and the page comes back with the real rule still in place
  // and bites taken out of the words (measured on risks1's top seven lines,
  // where every line kept a rule fragment beside the text it had chewed).
  // Printed rules are parallel and share the sheet's warp, so the neighbour's
  // own per-column profile IS the prediction: copy it and shift, or, between
  // two traced rules, interpolate the two column by column.
  const shifted = (src: RuleTrace, dy: number): number[] => {
    const y = new Array<number>(W);
    for (let x = 0; x < W; x++) y[x] = (src.y[Math.min(x, src.y.length - 1)] ?? 0) + dy;
    return y;
  };
  const blended = (a: RuleTrace, b: RuleTrace, t: number): number[] => {
    const y = new Array<number>(W);
    for (let x = 0; x < W; x++) {
      const ya = a.y[Math.min(x, a.y.length - 1)] ?? 0;
      const yb = b.y[Math.min(x, b.y.length - 1)] ?? 0;
      y[x] = ya * (1 - t) + yb * t;
    }
    return y;
  };
  // …but the sheet's warp is not a pure translation, so a copied profile can sit
  // a few px off the rule it predicts — and a trace that is off by 3px does not
  // remove the rule, it removes the paper beside it (risks1's first four lines
  // came back with the rule intact and a second, fainter line drawn under it).
  // The correction is deliberately LOW-ORDER — one offset and one tilt across
  // the page, chosen to maximise how much of the trace runs dark — so it can
  // find the rule without being able to climb onto a letter the way a free
  // seam can.
  const fitOffset = (y: number[]): { y: number[]; cov: number } => {
    let best = y;
    let bestCov = -1;
    const cand = new Array<number>(W);
    for (let d = -8; d <= 8; d++) {
      for (let tilt = -3; tilt <= 3; tilt++) {
        for (let x = 0; x < W; x++) cand[x] = y[x] + d + (tilt * (x - W / 2)) / W;
        const cov = coverageOf(cand);
        if (cov > bestCov) { bestCov = cov; best = cand.slice(); }
      }
    }
    return { y: best, cov: bestCov };
  };
  const accept = (y0: number[], which: 'above' | 'below' | 'filled'): boolean => {
    const { y, cov } = fitOffset(y0);
    const my = ruleMedianY({ thickness: 2, y });
    if (my < 2 || my > H - 3) return false;
    if (out.some((o) => Math.abs(ruleMedianY(o) - my) < pitch * 0.5)) return false;
    if (cov < minCoverage) { res.rejected++; return false; }
    out.push({ thickness: 2, y });
    res[which]++;
    return true;
  };

  // interior gaps first — a missing rule between two traced ones is the most
  // certain prediction on the page, and both its neighbours constrain its shape
  for (let i = 1; i < sorted.length; i++) {
    const gp = sorted[i].my - sorted[i - 1].my;
    const k = Math.round(gp / pitch);
    if (k < 2 || k > 12) continue;
    for (let j = 1; j < k; j++) accept(blended(sorted[i - 1].r, sorted[i].r, j / k), 'filled');
  }
  // …then extend past both ends, each new rule shaped like the outermost traced
  // one. One miss does not stop the walk (a rule can be covered by a photo
  // artefact or crossed out); two consecutive do.
  for (const dir of [-1, 1] as const) {
    const edge = dir < 0 ? sorted[0] : sorted[sorted.length - 1];
    let misses = 0;
    for (let k = 1; k <= 60; k++) {
      const dy = dir * pitch * k;
      if (edge.my + dy < 0 || edge.my + dy >= H) break;
      if (accept(shifted(edge.r, dy), dir < 0 ? 'above' : 'below')) misses = 0;
      else if (++misses >= 2) break;
    }
  }
  out.sort((a, b) => ruleMedianY(a) - ruleMedianY(b));
  return res;
}

/**
 * Drop rules that BISECT a text band — a spurious line traced straight through the
 * middle of writing rather than a real baseline. A genuine baseline has ink resting on
 * it (letters ABOVE) and mostly paper below (only sparse descenders); a rule crossing a
 * line of x-height text has ink both above AND below along most of its length. So for
 * each rule we sample columns and keep it unless a large fraction have ink on BOTH sides
 * of the band. Kept rules keep their order. Descender-heavy real baselines survive
 * because descenders touch only a minority of columns.
 *
 * This is applied by the word trainer (`runTrainingWordSeg`) after `improveRules`; a
 * stray mid-line rule otherwise becomes an extra baseline that steals letters onto the
 * wrong line (so they never join their neighbours' word, whatever the gap).
 */
export function pruneTextCrossingRules(
  gray: Uint8Array,
  W: number,
  H: number,
  rules: RuleTrace[],
  lineHeight: number,
): RuleTrace[] {
  if (rules.length <= 1 || lineHeight <= 0) return rules;
  const darkT = Math.max(0, paper85(gray, W, H) - 30);
  const near = Math.max(2, Math.round(lineHeight * 0.18)); // skip the rule's own band
  const reach = Math.max(near + 2, Math.round(lineHeight * 0.45)); // how far above/below to look
  const step = Math.max(1, Math.floor(W / 400));
  return rules.filter((r) => {
    let cols = 0;
    let above = 0;
    let below = 0;
    for (let x = 0; x < W; x += step) {
      const ry = Math.round(r.y[Math.min(x, r.y.length - 1)]);
      let a = false;
      let b = false;
      for (let dy = near; dy <= reach; dy++) {
        if (!a && ry - dy >= 0 && gray[(ry - dy) * W + x] < darkT) a = true;
        if (!b && ry + dy < H && gray[(ry + dy) * W + x] < darkT) b = true;
        if (a && b) break;
      }
      cols++;
      if (a) above++;
      if (b) below++;
    }
    if (!cols) return true;
    // Crossing = lots of ink on BOTH sides. A real baseline has little below.
    return !(below / cols > 0.5 && above / cols > 0.5);
  });
}

/** Robust straight-line fit y = a·x + b (Theil–Sen: median pairwise slope, median
 *  intercept) — ignores the minority of points that jumped off the line (e.g. a rule
 *  trace that briefly followed text ink). */
function robustLine(xs: number[], ys: number[]): { a: number; b: number } {
  const n = xs.length;
  if (n < 2) return { a: 0, b: n ? ys[0] : 0 };
  const slopes: number[] = [];
  const stride = Math.max(1, Math.floor(n / 160));
  for (let i = 0; i < n; i += stride) {
    for (let j = i + stride; j < n; j += stride) {
      const dx = xs[j] - xs[i];
      if (Math.abs(dx) < 1e-6) continue;
      slopes.push((ys[j] - ys[i]) / dx);
    }
  }
  slopes.sort((p, q) => p - q);
  const a = slopes.length ? slopes[slopes.length >> 1] : 0;
  const res = xs.map((x, i) => ys[i] - a * x).sort((p, q) => p - q);
  const b = res[res.length >> 1];
  return { a, b };
}

/**
 * Detect the ruled lines of lined paper as a consistent, smooth GRID — the robust
 * alternative to tracing (which follows text ink and jags up through words). A printed
 * rule is a nearly-full-width dark run; text never is. So:
 *   1. per row, the longest dark run (small faint breaks bridged, word-sized gaps not)
 *      → rows that are printed lines score near W,
 *   2. group contiguous high-scoring rows into bands (one per rule),
 *   3. drop a band within half the median spacing of a stronger one (a text baseline
 *      hugging the real rule),
 *   4. fit each surviving band to a STRAIGHT, gently-sloped line by taking the darkest
 *      row per column WITHIN the band only (so it can't wander into the text above),
 *   5. fill a single missing line where a gap is ~2× the spacing, so spacing stays even.
 * Returns [] if the page has no clear ruling (caller falls back to the traced rules).
 */
export function detectGridRules(gray: Uint8Array, W: number, H: number): RuleTrace[] {
  const paper = paper85(gray, W, H);
  const darkT = Math.max(0, paper - 26);
  // Longest dark run per row, bridging small faint breaks (a printed rule can fade in
  // spots) but NOT word-sized gaps (so a text row never adds up to a full-width run).
  const gapTol = Math.max(2, Math.round(0.008 * W));
  const runLen = new Int32Array(H);
  for (let y = 0; y < H; y++) {
    const base = y * W;
    let run = 0;
    let best = 0;
    let sinceDark = 0;
    for (let x = 0; x < W; x++) {
      if (gray[base + x] < darkT) {
        run += 1 + Math.min(sinceDark, gapTol);
        sinceDark = 0;
        if (run > best) best = run;
      } else if (++sinceDark > gapTol) {
        run = 0;
      }
    }
    runLen[y] = best;
  }
  const minRun = Math.round(0.4 * W);
  interface Band { center: number; y0: number; y1: number; strength: number }
  const bands: Band[] = [];
  for (let y = 0; y < H; ) {
    if (runLen[y] >= minRun) {
      const y0 = y;
      let sumw = 0;
      let sumwy = 0;
      let maxr = 0;
      while (y < H && runLen[y] >= minRun) {
        sumw += runLen[y];
        sumwy += runLen[y] * y;
        if (runLen[y] > maxr) maxr = runLen[y];
        y++;
      }
      bands.push({ center: sumw ? sumwy / sumw : (y0 + y - 1) / 2, y0, y1: y - 1, strength: maxr });
    } else y++;
  }
  if (bands.length < 2) return [];

  // Median spacing → drop a weaker band too close to a neighbour (text baseline vs rule).
  bands.sort((a, b) => a.center - b.center);
  const centers0 = bands.map((b) => b.center);
  const gaps0: number[] = [];
  for (let i = 1; i < centers0.length; i++) gaps0.push(centers0[i] - centers0[i - 1]);
  gaps0.sort((a, b) => a - b);
  const spacing = gaps0.length ? gaps0[gaps0.length >> 1] : 0;
  const kept: Band[] = [];
  for (const b of bands) {
    const last = kept[kept.length - 1];
    if (last && spacing > 0 && b.center - last.center < spacing * 0.5) {
      if (b.strength > last.strength) kept[kept.length - 1] = b; // keep the stronger line
      continue;
    }
    kept.push(b);
  }

  // Fill a single obviously-missing line so the grid stays evenly spaced.
  const filled: Band[] = [];
  for (let i = 0; i < kept.length; i++) {
    filled.push(kept[i]);
    if (spacing > 0 && i + 1 < kept.length) {
      const gap = kept[i + 1].center - kept[i].center;
      if (gap > spacing * 1.6 && gap < spacing * 2.5) {
        const c = (kept[i].center + kept[i + 1].center) / 2;
        filled.push({ center: c, y0: Math.round(c - 1), y1: Math.round(c + 1), strength: 0 });
      }
    }
  }

  const rules: RuleTrace[] = filled.map((band) => {
    const pad = 3;
    const yLo = Math.max(0, Math.floor(band.y0) - pad);
    const yHi = Math.min(H - 1, Math.ceil(band.y1) + pad);
    const xs: number[] = [];
    const ys: number[] = [];
    const step = Math.max(1, Math.floor(W / 600));
    for (let x = 0; x < W; x += step) {
      let by = -1;
      let bv = 256;
      for (let yy = yLo; yy <= yHi; yy++) {
        const v = gray[yy * W + x];
        if (v < bv) {
          bv = v;
          by = yy;
        }
      }
      if (by >= 0 && bv < darkT) {
        xs.push(x);
        ys.push(by);
      }
    }
    let { a, b } = robustLine(xs, ys);
    a = Math.max(-0.05, Math.min(0.05, a)); // rules are near-horizontal after dewarp
    if (!xs.length) b = band.center;
    const yArr = new Array<number>(W);
    for (let x = 0; x < W; x++) yArr[x] = Math.max(0, Math.min(H - 1, Math.round(a * x + b)));
    return { thickness: Math.max(2, band.y1 - band.y0 + 1), y: yArr };
  });
  return measureRuleThickness(gray, W, H, rules);
}

// ── connected-component word segmentation ─────────────────────────────────────

export interface CCWordOptions {
  inkDark: number;
  minStrength: number;
  darkPower: number;
  bridgePx: number;
  coreHeightFrac: number;
  gapSeparation: number;
  /** Manual word-break gap (px). 0 = automatic (2-group split, line-height fallback). */
  wordGap: number;
  /** Multiplier on the AUTO word-gap threshold (ignored when wordGap > 0). < 1 splits
   *  more aggressively (more words), > 1 splits less (fewer words). Lets the auto split
   *  be nudged without leaving auto mode. Default 0.7 (split slightly aggressively — the
   *  OCR aligner can merge back over a near-threshold gap; see `ambiguousJoins`). */
  autoScale: number;
  /**
   * Hand-painted ink override, `W * H` of PAINT_NONE / PAINT_ADD / PAINT_CUT
   * (clean/inkPaint.ts). Inside a PAINT_ADD stroke the darkness bar drops to
   * `paintDark` and every component that touches the stroke is exempt from the
   * acceptance gate — the writer has looked at the pixels and said they are
   * text, which is better evidence than any threshold this file owns.
   *
   * PAINT_CUT is handled by `applyInkPaint` whitening the page BEFORE this
   * runs, so nothing here has to know about it.
   */
  inkPaint?: Uint8Array;
  /** Darkness below paper that counts as ink inside a PAINT_ADD stroke.
   *  Default `PAINT_DARKISH`. Only read when `inkPaint` is set. */
  paintDark?: number;
  /** For a RIGHT-hand margin: components lying entirely to the right of this x
   *  are inside the margin strip and are dropped — the mirror of the
   *  `marginRightX` argument. 0 / unset = no right-hand margin. */
  marginLeftX?: number;
}

/** Widest body a SUB-FLOOR dot may be rescued over, as a fraction of the
 *  measured letter height — an i/j/l/t ascender, not an o or an m. */
const WEAK_DOT_STEM = 0.5;
/** A stem must be at least this many times the height of the dot it carries. */
const STEM_DOT_RATIO = 2;
/** How much taller than wide a component must be to be a STROKE rather than a
 *  dot-sized mark, whatever box it fits in — the same "tall and thin" ratio the
 *  border-sliver veto uses. See the `small` test. */
const DOT_ASPECT = 3;

// Calibrated for pa.gray — Pass A's DOWNSCALED working image (same scale admin/train
// runs on), NOT the full-res raw photo the word-segmenter lab uses. So the absolute
// gates (inkDark, minStrength, bridgePx) match the training tool's proven defaults
// (INK_DARK_DEF 50 / MIN_STRENGTH_DEF 8 / BRIDGE_DEF 3); the lab's 60 strength was for
// full-res images and drops most letters at this scale. coreHeightFrac / gapSeparation
// / wordGap are scale-invariant (relative to line height / ratios) and kept as tuned.
const DEFAULT_CC_WORD_OPTIONS: CCWordOptions = {
  inkDark: 50,
  minStrength: 8,
  darkPower: 1.3,
  bridgePx: 3,
  coreHeightFrac: 0.1,
  gapSeparation: 0.38,
  wordGap: 0,
  autoScale: 0.7,
};

interface Comp {
  root: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  strength: number;
  strong: boolean;
  /** Admitted only by the sub-floor dot rescue — it must earn its place with a
   *  letter body BELOW it, never with the baseline-hug route. See the rescue. */
  weakDot?: boolean;
  /** Some of this component's ink lies under a PAINT_ADD stroke: the writer
   *  said it is text, so it skips every acceptance test below. */
  painted?: boolean;
}

function coreExtent(
  label: Int32Array,
  root: number,
  ink: Uint8Array,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  W: number,
  minCore: number,
): { cx0: number; cx1: number; thin: boolean } {
  const w = x1 - x0 + 1;
  const colH = new Int32Array(w);
  for (let y = y0; y <= y1; y++) {
    const base = y * W;
    for (let x = x0; x <= x1; x++) {
      const i = base + x;
      if (label[i] === root && ink[i]) colH[x - x0]++;
    }
  }
  let cx0 = -1;
  let cx1 = -1;
  for (let x = 0; x < w; x++) {
    if (colH[x] >= minCore) {
      if (cx0 < 0) cx0 = x;
      cx1 = x;
    }
  }
  if (cx0 < 0) return { cx0: x0, cx1: x1, thin: true };
  return { cx0: x0 + cx0, cx1: x0 + cx1, thin: false };
}

function twoMeans(values: number[]): { thr: number; sep: number } {
  if (values.length < 2) return { thr: Infinity, sep: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  let lo = sorted[0];
  let hi = sorted[sorted.length - 1];
  if (hi <= lo) return { thr: Infinity, sep: 0 };
  for (let iter = 0; iter < 60; iter++) {
    let loSum = 0;
    let loN = 0;
    let hiSum = 0;
    let hiN = 0;
    for (const v of sorted) {
      if (Math.abs(v - lo) <= Math.abs(v - hi)) {
        loSum += v;
        loN++;
      } else {
        hiSum += v;
        hiN++;
      }
    }
    const nlo = loN ? loSum / loN : lo;
    const nhi = hiN ? hiSum / hiN : hi;
    if (Math.abs(nlo - lo) < 0.01 && Math.abs(nhi - hi) < 0.01) {
      lo = nlo;
      hi = nhi;
      break;
    }
    lo = nlo;
    hi = nhi;
  }
  const sep = hi > 0 ? (hi - lo) / hi : 0;
  return { thr: (lo + hi) / 2, sep };
}

// ── cross-line component separation (descenders touching the line below) ──────
// A descender ('g', 'y', 'p', 'j') that reaches down and TOUCHES — or comes within
// `bridgePx` of — ink on the next line fuses both lines' letters into ONE connected
// component. Left alone that blob is a single character box two lines tall: its x-span
// then swallows every character it overlaps (so both lines' words come out wrong), or it
// trips the `maxCharH` gate and both lines lose their letters outright.
//
// Fix: find each component whose ink genuinely sits in TWO lines' x-height bands, cut it
// along a MINIMUM-COST SEAM through the inter-line gap — a left→right path that threads
// the white space the component leaves and crosses its thinnest ink where it must — and
// re-flood the component with that seam blocking connectivity. Each half then lands on
// its own line through the normal `assignLine` path. Only components that really do span
// two lines are touched, so nothing else about the segmentation changes.

/** How far below a mark its own letter may sit, in x-heights, when nothing of
 *  the mark's own line lies beside it — the i-dot's reach. (With a neighbour
 *  beside it the mark is a trailing one and the reach stays 0.35.) */
const MARK_STEM_REACH = 1.2;

/** …and how far the bottom of the ink BESIDE a mark may differ from its own
 *  before they stop counting as resting alike (a trailing comma dips ~1.1
 *  x-heights below its letters; a dot rides ~1.6 above them). */
const MARK_TRAIL_LEVEL = 1.2;

/** A line's x-height band = [baseline − XBAND_FRAC·lineHeight, baseline]. Ink in two
 *  bands = characters from two lines in one component. */
const XBAND_FRAC = 0.55;
/** Ink a component must have inside a line's x-band to count as being ON that line
 *  (fraction of the component's own ink, with an absolute floor). */
const CROSS_MIN_FRAC = 0.08;
const CROSS_MIN_PIX = 8;
/** Seam costs. Crossing real ink is what the path is trying to avoid; a pixel that only
 *  exists because of the bridging dilation is nearly free; white is free. Each vertical
 *  step costs a little so the cut stays as straight as the ink allows. */

/**
 * Split every component that holds characters from two (or more) lines. Components that
 * sit on a single line are returned untouched. Split halves are relabelled in `label`
 * (so `coreExtent` still works per piece) and replace the original in the returned list.
 */
function separateCrossLine(
  all: Comp[],
  label: Int32Array,
  ink: Uint8Array,
  gray: Uint8Array,
  /** `strengthOf[g]` = the strength one pixel of gray `g` contributes, tabulated
   *  once by the caller. The re-flood below re-sums it for each split half, and
   *  a `Math.pow` per pixel here is the same measurable cost the main labeller
   *  tabulated the table to avoid. Same values, so the sums are bit-identical. */
  strengthOf: Float64Array,
  W: number,
  mys: number[],
  lineHeight: number,
): { comps: Comp[]; splits: number } {
  const xband = lineHeight * XBAND_FRAC;
  const out: Comp[] = [];
  let splits = 0;

  for (const c of all) {
    // Two x-bands plus the gap between them can't fit in less than ~1.5 line heights.
    if (c.y1 - c.y0 + 1 < lineHeight * 1.2) {
      const t = (globalThis as { __sepTrace?: [number, number, number, number] }).__sepTrace;
      if (t && c.x1 >= t[0] && c.x0 <= t[2] && c.y1 >= t[1] && c.y0 <= t[3] && c.y1 - c.y0 + 1 > lineHeight * 0.8) {
        console.log(`[sep] SKIP(short) comp x${c.x0}-${c.x1} y${c.y0}-${c.y1} h=${c.y1 - c.y0 + 1} (${((c.y1 - c.y0 + 1) / lineHeight).toFixed(2)} LH < 1.2)`);
      }
      out.push(c);
      continue;
    }

    // How much of this component's ink sits in each line's x-height band.
    const counts = new Map<number, number>();
    let total = 0;
    for (let y = c.y0; y <= c.y1; y++) {
      let li = -1;
      for (let k = 0; k < mys.length; k++) {
        if (y <= mys[k] && y >= mys[k] - xband) {
          li = k;
          break;
        }
      }
      const row = y * W;
      for (let x = c.x0; x <= c.x1; x++) {
        const i = row + x;
        if (label[i] !== c.root || !ink[i]) continue;
        total++;
        if (li >= 0) counts.set(li, (counts.get(li) ?? 0) + 1);
      }
    }
    const need = Math.max(CROSS_MIN_PIX, total * CROSS_MIN_FRAC);
    const hit = [...counts.entries()]
      .filter(([, n]) => n >= need)
      .map(([k]) => k)
      .sort((a, b) => a - b);
    {
      const t = (globalThis as { __sepTrace?: [number, number, number, number] }).__sepTrace;
      if (t && c.x1 >= t[0] && c.x0 <= t[2] && c.y1 >= t[1] && c.y0 <= t[3]) {
        console.log(`[sep] comp x${c.x0}-${c.x1} y${c.y0}-${c.y1} h=${c.y1 - c.y0 + 1} (${((c.y1 - c.y0 + 1) / lineHeight).toFixed(2)} LH) total=${total} bands=${JSON.stringify([...counts.entries()])} need=${need.toFixed(0)} hit=${JSON.stringify(hit)}`);
      }
    }
    if (hit.length < 2) {
      out.push(c);
      continue;
    }

    // One seam per crossed line boundary, each confined to that inter-line gap: below the
    // upper line's baseline (its bodies stay whole) and above the lower line's x-height
    // (ditto). Within that zone the cost decides where the cut falls — normally the thin
    // junction where the descender meets the letter below.
    // WHERE A STROKE CAME FROM, not a row seam. The seam was a minimum-cost
    // path through the gutter, and it crossed a welded stroke wherever crossing
    // was CHEAPEST — for a hooked descender that is the thin vertical stem
    // near the top, not the wide hook at the bottom, so warehouse2's `Parking`
    // lost its g's tail to `new` on the line below (traced: the raw g+new
    // component is 72 px / 1.41 LH with both bands hit, and the seam sliced the
    // tail off the bowl; downstream the tail rendered inside line 9's
    // characters and the word read `Parkina`). Plain geodesic competition
    // between the two lines' bodies is no better: equal-speed fronts meet at
    // the MIDPOINT of a bridge, so half the tail still goes below.
    //
    // A stroke in the gutter is separated by TOPOLOGY. Take the gutter between
    // two lines — below the upper baseline, above the lower x-height top —
    // and its connected pieces. A piece that connects UP to the upper line's
    // body is a descender and belongs above, however far down it reaches; a
    // piece that connects only DOWN is an ascender of the lower line; a piece
    // that connects both ways (a tail touching an ascender) is the one
    // genuinely ambiguous case, and there the two contact sets compete, ties
    // to the upper line (a descender belongs to the letter it hangs from).
    // Then the tail's HOOK: a descender curls left INSIDE the lower line's
    // x-height band, lying over the lower letter's top. The pen overlapped
    // there and both letters own those pixels; a component can carry one
    // label, so within `hookReach` of the tail's contact the ink stays with
    // the tail — a notch in the lower letter's top edge costs less than a
    // foreign hook painted across it.
    const cw = c.x1 - c.x0 + 1;
    const ch = c.y1 - c.y0 + 1;
    const bandLab = new Int16Array(cw * ch).fill(-1);
    const L = (x: number, y: number): number => (y - c.y0) * cw + (x - c.x0);
    const inComp = (x: number, y: number): boolean =>
      x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1 && label[y * W + x] === c.root;
    // provisional: the zone the pixel sits in, by the hit lines' baselines
    const bases = hit.map((k) => mys[k]);
    for (let y = c.y0; y <= c.y1; y++) {
      let b = 0;
      while (b + 1 < bases.length && y > bases[b]) b++;
      for (let x = c.x0; x <= c.x1; x++) if (label[y * W + x] === c.root) bandLab[L(x, y)] = b;
    }
    const N8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
    for (let hi = 0; hi + 1 < hit.length; hi++) {
      const baseU = Math.round(mys[hit[hi]]);
      const topL = Math.round(mys[hit[hi + 1]] - xband);
      const deepL = Math.round(mys[hit[hi + 1]] - xband / 2);
      const uy0 = Math.max(c.y0, baseU + 1);
      const uy1 = Math.min(c.y1, topL - 1);
      if (uy1 < uy0) continue;                        // no gutter: the zones stand
      // THE LOWER LINE'S BODY: flood from the deep half of its x-height band
      // through rows at/below the band top. A descender's hook dips only a
      // few pixels past that top, so it is never reached; the lower letters
      // (and any ascender's root) are. Unmarked ink below the band top is
      // therefore a tail's hook — pen overlap — and stays with the tail.
      const body = new Uint8Array(cw * ch);
      {
        const q: number[] = [];
        for (let y = Math.max(c.y0, deepL); y <= c.y1; y++) {
          for (let x = c.x0; x <= c.x1; x++) {
            if (!inComp(x, y) || !ink[y * W + x]) continue;
            body[L(x, y)] = 1;
            q.push(L(x, y));
          }
        }
        for (let head = 0; head < q.length; head++) {
          const l = q[head];
          const ly = (l / cw) | 0, lx = l - ly * cw;
          for (const [dx, dy] of N8) {
            const qx = lx + dx, qy = ly + dy;
            if (qx < 0 || qx >= cw || qy < 0 || qy >= ch) continue;
            if (qy + c.y0 < topL) continue;             // the body stops at its band top
            const ql = qy * cw + qx;
            if (body[ql] || !inComp(qx + c.x0, qy + c.y0)) continue;
            body[ql] = 1;
            q.push(ql);
          }
        }
      }
      // gutter pieces
      const seen = new Uint8Array(cw * ch);
      const pieceOwner = new Int16Array(cw * ch).fill(-1);   // band per gutter pixel
      for (let sy = uy0; sy <= uy1; sy++) {
        for (let sx = c.x0; sx <= c.x1; sx++) {
          if (seen[L(sx, sy)] || !inComp(sx, sy)) continue;
          const piece: number[] = [];
          const stack = [L(sx, sy)];
          seen[L(sx, sy)] = 1;
          let above = false, below = false;
          const upSeeds: number[] = [], downSeeds: number[] = [];
          while (stack.length) {
            const l = stack.pop() as number;
            piece.push(l);
            const ly = (l / cw) | 0, lx = l - ly * cw;
            const px = lx + c.x0, py = ly + c.y0;
            let touchUp = false, touchDown = false;
            for (const [dx, dy] of N8) {
              const qx = px + dx, qy = py + dy;
              if (!inComp(qx, qy)) continue;
              if (qy < uy0) { touchUp = true; continue; }
              if (qy > uy1) { if (body[L(qx, qy)]) touchDown = true; continue; }
              const ql = L(qx, qy);
              if (!seen[ql]) { seen[ql] = 1; stack.push(ql); }
            }
            if (touchUp) { above = true; upSeeds.push(l); }
            if (touchDown) { below = true; downSeeds.push(l); }
          }
          let assign: (l: number) => number;
          if (above && !below) assign = () => hi;
          else if (below && !above) assign = () => hi + 1;
          else if (above && below) {
            // both ways (a tail touching an ascender): the contact sets compete, upper first
            const inPiece = new Uint8Array(cw * ch);
            for (const l of piece) inPiece[l] = 1;
            const owner = new Int8Array(cw * ch).fill(-1);
            const q: number[] = [];
            for (const l of upSeeds) { owner[l] = 0; q.push(l); }
            for (const l of downSeeds) if (owner[l] < 0) { owner[l] = 1; q.push(l); }
            for (let head = 0; head < q.length; head++) {
              const l = q[head];
              const ly = (l / cw) | 0, lx = l - ly * cw;
              for (const [dx, dy] of N8) {
                const qx = lx + dx, qy = ly + dy;
                if (qx < 0 || qx >= cw || qy < 0 || qy >= ch) continue;
                const ql = qy * cw + qx;
                if (!inPiece[ql] || owner[ql] >= 0) continue;
                owner[ql] = owner[l];
                q.push(ql);
              }
            }
            assign = (l) => (owner[l] === 1 ? hi + 1 : hi);
          } else assign = (l) => bandLab[l];             // an isolated gutter speck keeps its zone
          for (const l of piece) { const b = assign(l); bandLab[l] = b; pieceOwner[l] = b; }
        }
      }
      // ink below the band top that is NOT the lower body — a hook, or a tail
      // running on — belongs to the gutter piece it hangs from
      {
        const q: number[] = [];
        for (let x = c.x0; x <= c.x1; x++) if (inComp(x, uy1) && pieceOwner[L(x, uy1)] >= 0) q.push(L(x, uy1));
        const done = new Uint8Array(cw * ch);
        for (let head = 0; head < q.length; head++) {
          const l = q[head];
          const b = bandLab[l];
          const ly = (l / cw) | 0, lx = l - ly * cw;
          for (const [dx, dy] of N8) {
            const qx = lx + dx, qy = ly + dy;
            if (qx < 0 || qx >= cw || qy < 0 || qy >= ch) continue;
            if (qy + c.y0 <= uy1) continue;
            const ql = qy * cw + qx;
            if (done[ql] || body[ql] || !inComp(qx + c.x0, qy + c.y0)) continue;
            done[ql] = 1;
            bandLab[ql] = b;
            q.push(ql);
          }
        }
      }
    }
    {
      const t = (globalThis as { __sepTrace?: [number, number, number, number] }).__sepTrace;
      if (t && c.x1 >= t[0] && c.x0 <= t[2] && c.y1 >= t[1] && c.y0 <= t[3]) {
        const cnt = new Map<number, number>();
        const rows = new Map<number, Map<number, number>>();
        for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
          if (!inComp(x, y)) continue;
          const b = bandLab[L(x, y)];
          cnt.set(b, (cnt.get(b) || 0) + 1);
          if (y % 8 === 0) { let r = rows.get(y); if (!r) rows.set(y, r = new Map()); r.set(b, (r.get(b) || 0) + 1); }
        }
        console.log(`[sep] bands after rule: ${JSON.stringify([...cnt.entries()])} baselines=${JSON.stringify(hit.map((k) => Math.round(mys[k])))} xband=${xband.toFixed(0)}`);
        for (const [y, r] of [...rows.entries()].sort((a, b) => a[0] - b[0])) console.log(`[sep]   row ${y}: ${JSON.stringify([...r.entries()])}`);
      }
    }
    // THE STROKES DECIDE where the zones cannot (two lines only — the common
    // case; a three-line weld keeps the zone rule above). See strokeSplit.ts:
    // the raw component's skeleton is read as cycles and chains, a unit whose
    // top reaches the upper line's zone hangs from it, one starting inside the
    // lower x-height band is the lower line's, the rest follow their
    // attachments. Only ink pixels are relabelled; the dilation halo keeps the
    // zone rule's answer.
    if (hit.length === 2) {
      const baseU = Math.round(mys[hit[0]]);
      const Lt = Math.round(mys[hit[1]] - xband);
      const mask = new Uint8Array(cw * ch);
      let nMask = 0;
      for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
        const i = y * W + x;
        if (label[i] === c.root && ink[i]) { mask[L(x, y)] = 1; nMask++; }
      }
      const penW = Math.max(2, Math.round(0.12 * xband));
      const sp = nMask > 8 ? splitStrokes(mask, cw, ch, penW) : null;
      if (sp) {
        const lines = resolveUnitLines(sp,
          (u) => ((u.y0 + c.y0) <= baseU + 2 ? 0 : (u.y0 + c.y0) >= Lt ? 1 : -1),
          (u) => ((u.y0 + c.y0) - baseU < Lt - (u.y0 + c.y0) ? 0 : 1));
        for (let l = 0; l < cw * ch; l++) {
          const u = sp.unitOf[l];
          if (u >= 0) bandLab[l] = lines[u];
        }
        {
          const t = (globalThis as { __sepTrace?: [number, number, number, number] }).__sepTrace;
          if (t && c.x1 >= t[0] && c.x0 <= t[2] && c.y1 >= t[1] && c.y0 <= t[3]) {
            console.log(`[sep] STROKES: ` + sp.units.map((u) => `${u.kind}#${u.id}(${u.pixels.length}px top${u.y0 + c.y0})→${lines[u.id]}`).join(' '));
          }
        }
      }
    }
    const bandOf = (x: number, y: number): number => {
      const b = bandLab[L(x, y)];
      return b >= 0 ? b : 0;
    };

    const bw = c.x1 - c.x0 + 1;
    const seen = new Uint8Array(bw * (c.y1 - c.y0 + 1));
    const parts: Comp[] = [];
    const stack: number[] = [];
    const pix: number[] = [];
    for (let sy = c.y0; sy <= c.y1; sy++) {
      for (let sx = c.x0; sx <= c.x1; sx++) {
        const sl = (sy - c.y0) * bw + (sx - c.x0);
        if (seen[sl] || label[sy * W + sx] !== c.root) continue;
        const band = bandOf(sx, sy);
        seen[sl] = 1;
        stack.length = 0;
        pix.length = 0;
        stack.push(sy * W + sx);
        pix.push(sy * W + sx);
        let x0 = W;
        let y0 = c.y1;
        let x1 = -1;
        let y1 = -1;
        let strength = 0;
        while (stack.length) {
          const i = stack.pop() as number;
          const y = (i / W) | 0;
          const x = i - y * W;
          if (ink[i]) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
            strength += strengthOf[gray[i]];
          }
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < c.y0 || yy > c.y1) continue;
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              const xx = x + dx;
              if (xx < c.x0 || xx > c.x1) continue;
              const ql = (yy - c.y0) * bw + (xx - c.x0);
              if (seen[ql] || label[yy * W + xx] !== c.root) continue;
              if (bandOf(xx, yy) !== band) continue;
              seen[ql] = 1;
              stack.push(yy * W + xx);
              pix.push(yy * W + xx);
            }
          }
        }
        if (x1 < 0) continue; // dilation halo only — no ink to keep
        const root = pix[0];
        for (const p of pix) label[p] = root;
        parts.push({ root, x0, y0, x1, y1, strength, strong: false });
      }
    }
    if (parts.length > 1) splits++;
    {
      const t = (globalThis as { __sepTrace?: [number, number, number, number] }).__sepTrace;
      if (t && c.x1 >= t[0] && c.x0 <= t[2] && c.y1 >= t[1] && c.y0 <= t[3]) {
        console.log(`[sep] parts: ${parts.map((p) => `x${p.x0}-${p.x1} y${p.y0}-${p.y1} band=${bandOf(p.x0, p.y0)}`).join(' | ')}`);
      }
    }
    out.push(...(parts.length ? parts : [c]));
  }
  return { comps: out, splits };
}

/** Optional debug out-param for `ccWordBoxes`: the kept CHARACTER boxes (with their
 *  skip flag) + the final WORD boxes, all in page coordinates. Passed by the word
 *  trainer to draw overlays; production editor callers omit it. */
export interface CCWordDebug {
  chars: { x0: number; y0: number; x1: number; y1: number; skip: boolean }[];
  words: { x: number; y: number; w: number; h: number; line: number; mergeNext?: boolean }[];
  lineHeight: number;
  /** The word-break gap (px) actually used this run — the manual `wordGap`, or the
   *  auto value (2-means × autoScale, clamped). Surfaced so a good value can be read
   *  off and pinned manually. */
  gapThreshold: number;
  /** How many connected components held characters from two lines and were cut apart
   *  (`separateCrossLine`) — i.e. how many descenders were resting on the line below. */
  crossSplits: number;
  /** How many mark-sized components were reassigned to a different line (hanging
   *  trailing marks pulled back up; diacritics returned to their letter's line). */
  markLineMoves?: number;
}

// ── per-character cleaning / thresholding / darkness normalization ────────────
// One threshold for a whole page (or even a whole line) can only ever suit the average
// character on it: a lightly-written one falls apart and a heavy one blooms, because pen
// pressure, ink flow and residual shading all vary stroke to stroke. So the clean render
// is built CHARACTER BY CHARACTER — each block gets its OWN Otsu split, measured on its
// own pixels, and is then re-rendered at ONE page-wide ink darkness (the median of every
// character's ink level). Faint characters come up, heavy ones come down, and the page
// ends up evenly weighted with a single well-defined ink level — so any downstream
// threshold is correct for every character, everywhere on the page.

/** Paper margin (px) around a character box when measuring its local Otsu — the split is
 *  best conditioned with some real paper in the histogram. */
const CHAR_PAD = 2;
/** A block whose ink and paper levels are this close has no real split — skip it rather
 *  than amplify paper noise into a character. */
const CHAR_MIN_CONTRAST = 25;
/** The normalized ink level is the page median, held in a sensibly dark band. */
const INK_TARGET_MIN = 0;
const INK_TARGET_MAX = 90;

/** Otsu's threshold from a 256-bin histogram. (Local copy — this module is shared with
 *  the editor and must not depend on the training-only helpers.) */
function otsuOf(hist: Int32Array, total: number): number {
  if (total <= 0) return 128;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  return thr;
}

/** Out-params for `ccWordBoxes`. All optional — the editor passes none. */
export interface CCWordOut {
  /** The kept CHARACTER boxes (with their skip flag) + the final WORD boxes, in page
   *  coordinates. Passed by the trainers to draw overlays. */
  debug?: CCWordDebug;
  /** Per-pixel line ownership (SEGMENTER line index + 1; 0 = unclaimed), for cropping
   *  whole-line bands without a neighbour's descender. See `cropGrayRegion`.
   *  NOTE the id space: these are indices into the BASELINES array, not into the
   *  returned BoxesJson lines — a rule with no words on it makes the two diverge.
   *  `lineIds` is the bridge. */
  lineMask?: Int16Array;
  /** For each returned BoxesJson line, the SEGMENTER line index its words carry in
   *  `lineMask` — filled whenever `lineMask` is requested. A consumer whose line ids
   *  are BoxesJson indices (Pass B's `WordRec.line`) MUST translate through this, or
   *  on any page with a wordless rule it whitens its own ink as foreign. */
  lineIds?: number[];
  /** The cleaned page: every character block re-thresholded with its own Otsu and
   *  re-rendered at the page's normalized ink darkness, on pure paper. Ink outside any
   *  character (specks, bleed-through, rule residue) is dropped. */
  clean?: Uint8Array;
  /** Faint marks the dot rule RESCUED because a letter body sits under them — i/j
   *  dots and accents written with a light touch. Each carries the body it was
   *  matched to, so a later stage can darken the dot to the darkness of the very
   *  character it belongs to. Without this the decision dies here: Pass B builds
   *  its SDF from intensity alone, and a dot below the ink surface is erased even
   *  though the segmenter already established it is part of a letter. */
  faintDots?: FaintDot[];
  /** Dot-sized marks the rules REJECTED. Not in any character box and not in the
   *  cleaned page — recorded so `restoreDots` can put back the ones recognition
   *  later vouches for. See DotCandidate. */
  dotCandidates?: DotCandidate[];
}

/** A dot-sized mark the keep rules REJECTED, kept as metadata so a later stage
 *  can put it back when recognition says the character under it wants a dot.
 *  `pixels` are page coords, so restoring is exact and costs no re-derivation. */
export interface DotCandidate {
  x0: number; y0: number; x1: number; y1: number;
  pixels: [number, number][];
  /** Darkest gray in the mark — how confident we are it is ink at all. */
  dark: number;
}

/**
 * Put back the dots the segmenter refused, for characters RECOGNITION says want
 * one.
 *
 * The segmenter has to commit to a set of pixels before anything reads them, so
 * it can only ever guess whether a faint mark is an i-dot or a speck — and
 * measured four ways (docs/faint-dots.md and the project notes), guessing generously costs
 * words: a speck kept becomes a character, then a word (`mother` -> `i`). The
 * recognizer is the first stage that knows the character underneath is an `i`,
 * and an `i` drawn without a dot is exactly the evidence that a dot was lost.
 *
 * So the decision is deferred rather than improved: rejected marks ride along as
 * `dotCandidates`, and this puts back only those sitting above a character the
 * decode named `i`/`j`. It touches the RENDER, never the segmentation — nothing
 * downstream of here re-reads the page, so this cannot change a reading.
 *
 * `targets` are page-space boxes of undotted i/j characters. Returns how many
 * marks were restored.
 */
export function restoreDots(
  gray: Uint8Array,
  W: number,
  H: number,
  candidates: DotCandidate[],
  targets: { x0: number; y0: number; x1: number; y1: number }[],
  opts?: {
    maxRiseXh?: number; xh?: number;
    /** Filled with one entry per restored mark: which target took it, the
     *  mark's box/pixels (page coords) and the ink level it was stamped at —
     *  so a caller keeping its own per-word renders (the editor's
     *  mattes) can apply the identical restoration there. */
    placedOut?: { target: number; x0: number; y0: number; x1: number; y1: number;
                  pixels: [number, number][]; ink: number }[];
  },
): number {
  if (!candidates?.length || !targets?.length) return 0;
  const xh = opts?.xh ?? 20;
  const maxRise = (opts?.maxRiseXh ?? 1.6) * xh;
  // One mark can only crown one character, so a claimed candidate is held in a
  // LOCAL set. It used to be a `_used` property stamped onto the caller's own
  // DotCandidate objects, which made the function single-shot: `clean.dotCandidates`
  // outlives the call, so a second run over the same clean result (a re-decode,
  // a re-import) found every mark already flagged and restored nothing.
  const used = new Set<DotCandidate>();
  let n = 0;
  for (let ti = 0; ti < targets.length; ti++) {
    const t = targets[ti];
    const cx0 = t.x0, cx1 = t.x1;
    let best: DotCandidate | null = null, bestD = Infinity;
    for (const d of candidates) {
      if (used.has(d)) continue;
      const dcx = (d.x0 + d.x1) / 2;
      // over the character's own column, and ABOVE it — an i-dot is neither
      // beside its stem nor below it
      if (dcx < cx0 - 2 || dcx > cx1 + 2) continue;
      // The mark may sit ABOVE the character's box or INSIDE its upper region:
      // when the decoder was handed the same dot (the dot layer), the character
      // it reported already spans the dot's rows, and demanding "strictly above"
      // rejects exactly the characters this exists to fix. Upper half or higher,
      // and no further above than a dot can reasonably sit.
      const h = t.y1 - t.y0 + 1;
      const rise = t.y0 - d.y1;
      if (rise > maxRise) continue;
      if (d.y1 > t.y0 + h * 0.5) continue;   // in the lower half: not a dot for this char
      if (Math.abs(rise) < bestD) { bestD = Math.abs(rise); best = d; }
    }
    if (!best) continue;
    // DARKEN TO THE CHARACTER'S OWN INK, not to the mark's original gray. The
    // same argument liftFaintDots makes: a dot should be as dark as the stem it
    // crowns, and that comparison needs no page statistics. Restoring at the
    // original 195 next to a stem rendered at 90 reads as a smudge, not a dot.
    let charInk = 255;
    for (let y = t.y0; y <= t.y1; y++) {
      for (let x = t.x0; x <= t.x1; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const g = gray[y * W + x];
        if (g < charInk) charInk = g;
      }
    }
    const want = charInk < 255 ? charInk : best.dark;
    for (const [x, y] of best.pixels) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      if (want < gray[i]) gray[i] = want;   // never lighten what is already there
    }
    used.add(best);
    opts?.placedOut?.push({ target: ti, x0: best.x0, y0: best.y0, x1: best.x1, y1: best.y1,
                            pixels: best.pixels, ink: want });
    n++;
  }
  return n;
}

/**
 * Close the gaps recognition implies, by GROWING existing ink into the faint
 * strokes the cleaner's one global threshold cut.
 *
 * A single ink threshold has to serve a whole page, and a stroke drawn lightly
 * falls under it in places — doubledia's `plums` loses the top arc of its `p`'s
 * bowl, which measures 214-231 against a local paper of 244-255 and a stem of
 * 135. The loop renders open. Nothing is wrong with the threshold; it simply
 * cannot be right everywhere at once.
 *
 * Hysteresis is the standard answer and it fits here exactly: the strong
 * threshold has already chosen the seeds (they are in the render), so this only
 * GROWS them, 8-connected, into source pixels that are dark relative to THIS
 * character's own contrast. Isolated faint ink is never admitted — it has to
 * touch a stroke that survived — which is what keeps paper texture and
 * bleed-through out.
 *
 * Per CHARACTER, using that character's own ink and paper levels, because the
 * whole point is that one global level was wrong. Render only: it runs after
 * the decode and nothing re-reads the page, so it cannot change a reading.
 * `growCap` bounds the damage if a box does flood — a character that gains more
 * than that fraction of ink is reverted rather than trusted.
 *
 * `dst` is the cleaned page (mutated); `src` is the page it was thresholded
 * from. Returns the number of pixels added.
 */
/**
 * The pixels `refineInk` WOULD add for one box at one threshold, without
 * touching anything. Exposed because the decoder needs to compare several
 * thresholds against each other — and against the original — before any of them
 * is committed to the page. Returns page-space indices, plus the levels used.
 */
export function growInkSet(
  dst: Uint8Array,
  src: Uint8Array,
  W: number,
  H: number,
  box: { x0: number; y0: number; x1: number; y1: number },
  weakFrac: number,
  pad = 1,
  /** `ruleCls` from removeHRulesPage: 1 = a pixel it ERASED as printed rule.
   *  Growth must refuse those. `src` is the page BEFORE rule removal, so the
   *  rules are all still in it — a character resting on a ruled line grows
   *  straight down into the rule and puts it back, which is worse than the gap
   *  it was fixing. The classifier already decided that ink is print; this is
   *  not the place to overturn it. */
  ruleMask: Uint8Array | null = null,
): { grown: number[]; seeds: number; ink: number; paper: number; weakT: number } {
  const x0 = Math.max(0, box.x0 - pad), y0 = Math.max(0, box.y0 - pad);
  const x1 = Math.min(W - 1, box.x1 + pad), y1 = Math.min(H - 1, box.y1 + pad);
  const empty = { grown: [] as number[], seeds: 0, ink: 255, paper: 0, weakT: 0 };
  if (x1 <= x0 || y1 <= y0) return empty;
  let ink = 255, paper = 0, seeds = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const v = dst[y * W + x];
    if (v < 200) { seeds++; if (v < ink) ink = v; }
    const sv = src[y * W + x];
    if (sv > paper) paper = sv;
  }
  if (!seeds || ink === 255) return empty;
  const weakT = paper - weakFrac * (paper - ink);
  if (!(weakT < paper)) return { grown: [], seeds, ink, paper, weakT };
  const stack: number[] = [];
  const grown: number[] = [];
  const seen = new Set<number>();
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (dst[y * W + x] < 200) stack.push(y * W + x);
  }
  while (stack.length) {
    const i = stack.pop() as number;
    const y = (i / W) | 0, x = i - y * W;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const xx = x + dx, yy = y + dy;
      if (xx < x0 || yy < y0 || xx > x1 || yy > y1) continue;
      const j = yy * W + xx;
      if (seen.has(j) || dst[j] < 200) continue;
      if (ruleMask && ruleMask[j] === 1) continue;   // erased rule — never regrow it
      if (src[j] >= weakT) continue;
      seen.add(j);
      grown.push(j);
      stack.push(j);
    }
  }
  return { grown, seeds, ink, paper, weakT };
}

export function refineInk(
  dst: Uint8Array,
  src: Uint8Array,
  W: number,
  H: number,
  boxes: { x0: number; y0: number; x1: number; y1: number }[],
  opts?: { weakFrac?: number; growCap?: number; pad?: number; ruleMask?: Uint8Array | null },
): number {
  // 0.2 measured on doubledia's `plums`: its `p` grows 69 px against 157 seeds
  // (ratio 0.44, inside growCap) and the bowl closes. 0.15 grows 92 — ratio
  // 0.59, OVER the cap — so the whole character is reverted and the loop stays
  // open, which is the failure this was written for. The cap is doing its job
  // in both cases; the threshold has to be strict enough to stay under it.
  const weakFrac = opts?.weakFrac ?? 0.2;
  const growCap = opts?.growCap ?? 0.5;
  const pad = opts?.pad ?? 1;
  let added = 0;
  for (const b of boxes) {
    const g = growInkSet(dst, src, W, H, b, weakFrac, pad, opts?.ruleMask ?? null);
    if (!g.grown.length) continue;
    if (g.grown.length > growCap * g.seeds) continue;   // flooded — do not trust it
    for (const j of g.grown) { dst[j] = g.ink; added++; }
  }
  return added;
}

/** A rescued faint dot and the letter body that vouched for it, page coords. */
export interface FaintDot {
  x0: number; y0: number; x1: number; y1: number;
  /** The body found beneath it — the darkness reference. */
  bodyX0: number; bodyY0: number; bodyX1: number; bodyY1: number;
}

/**
 * Segment WORD boxes on a rule-removed grayscale page, using the rule baselines for
 * lines. Returns a BoxesJson in the same page coordinates Pass B expects. Character
 * boxes are used internally for grouping; only word boxes are emitted (plus, via `out`,
 * the overlay boxes / line mask / cleaned page).
 */
/** The `q` quantile of the gray values inside a box (0 = darkest). */
function boxQuantile(
  gray: Uint8Array, W: number, H: number,
  x0: number, y0: number, x1: number, y1: number, q: number,
): number {
  const v: number[] = [];
  for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++)
    for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) v.push(gray[y * W + x]);
  if (!v.length) return 255;
  v.sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))))];
}

/** Hard ceiling on the lift. A dot barely above the paper would otherwise have
 *  its own sensor noise amplified along with it. */
const FAINT_LIFT_MAX = 4;

/**
 * Darken each rescued faint dot to the darkness of the letter it belongs to.
 *
 * A dot written with a light touch is real ink, but downstream stages decide
 * what is ink by INTENSITY: Pass B estimates one ink/paper pair for the whole
 * word and builds its signed distance field from a coverage surface between
 * them. A dot that never reaches that surface contributes nothing to the field
 * and simply disappears — measured on the test photo, the dot over "will" sat at
 * gray 189 against ink 95 and paper 252, or 40% coverage, and vanished at the
 * SDF stage while the segmenter had already accepted it.
 *
 * The reference is the dot's OWN letter body rather than a page-wide ink level,
 * because that is the comparison that means something: a dot should be as dark
 * as the stem it sits above. Contrast is stretched about the local paper level,
 * so the mark keeps its shape and its soft rim — only its depth changes.
 */
export function liftFaintDots(
  gray: Uint8Array, W: number, H: number, dots: FaintDot[],
): number {
  let lifted = 0;
  for (const d of dots) {
    const bodyInk = boxQuantile(gray, W, H, d.bodyX0, d.bodyY0, d.bodyX1, d.bodyY1, 0.1);
    // The dot's own extremes. Paper comes from the same box: a component bbox is
    // tight around its ink, so its lightest pixels are the paper it sits on.
    const paper = boxQuantile(gray, W, H, d.x0, d.y0, d.x1, d.y1, 0.9);
    const darkest = boxQuantile(gray, W, H, d.x0, d.y0, d.x1, d.y1, 0);
    const span = paper - darkest;
    if (span <= 0 || paper <= bodyInk) continue; // already at least as dark as its letter
    const k = Math.min(FAINT_LIFT_MAX, (paper - bodyInk) / span);
    if (k <= 1) continue; // no lift needed
    for (let y = Math.max(0, d.y0); y <= Math.min(H - 1, d.y1); y++)
      for (let x = Math.max(0, d.x0); x <= Math.min(W - 1, d.x1); x++) {
        const i = y * W + x;
        const g = gray[i];
        if (g >= paper) continue;
        gray[i] = Math.max(0, Math.round(paper - (paper - g) * k));
      }
    lifted++;
  }
  return lifted;
}

/**
 * Erase rule RESIDUE from a rule-removed page, in place.
 *
 * The rule remover keeps any pixel meaningfully darker than the rule, which is
 * right for strokes crossing the rule but occasionally leaves a thin dark
 * fragment of the rule itself. Measured on the test photo: a 123x5 px streak on
 * the line-0 rule survived, and because the component pass bridges gaps of a
 * few px it FUSED with the first word's letters — so no component-level filter
 * can catch it (the merged blob is letter-sized), and the recognizer then had
 * to explain extra baseline ink ("All" read as "Allan"/"Allah").
 *
 * At the PIXEL level, before any bridging, residue is provable: a connected run
 * that is thin (a few px), several times wider than tall, and lies entirely
 * within a traced rule's band. Real horizontal strokes do not qualify — a
 * t-crossbar is a fraction of the width and sits in the letter zone; a
 * descender crosses the band but extends beyond it, so its bbox fails the
 * fully-inside test.
 *
 * Returns the number of runs erased.
 */
export function eraseRuleResidue(
  gray: Uint8Array, W: number, H: number,
  ruleBaselines: number[], lineHeight: number,
  // removeHRulesPage's verdicts (2 = kept stroke): a component the classifier
  // argued into existence — structure, run shape, connectivity — must not be
  // re-deleted here as a sliver; the user-visible symptom was green (kept)
  // pixels missing from the rule-removed page anyway.
  ruleCls: Uint8Array | null = null,
): number {
  // Band half-height: rules slope, so the page-wide median can sit several px
  // from the rule's local y (measured: 8 px on the test photo).
  const tol = Math.max(6, Math.round(lineHeight * 0.15));
  const minW = Math.max(12, lineHeight * 0.5);
  const seen = new Uint8Array(W * H);
  let erased = 0;
  for (const ry of ruleBaselines) {
    const y0 = Math.max(0, Math.round(ry) - tol);
    const y1 = Math.min(H - 1, Math.round(ry) + tol);
    for (let y = y0; y <= y1; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (seen[i] || gray[i] >= 200) continue;
        // flood the 8-connected component
        const px: number[] = [i];
        seen[i] = 1;
        let head = 0;
        let bx0 = x, bx1 = x, by0 = y, by1 = y;
        let kept = 0;
        while (head < px.length) {
          const c = px[head++];
          if (ruleCls && ruleCls[c] === 2) kept++;
          const cx = c % W;
          const cy = (c - cx) / W;
          if (cx < bx0) bx0 = cx;
          if (cx > bx1) bx1 = cx;
          if (cy < by0) by0 = cy;
          if (cy > by1) by1 = cy;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = cx + dx;
              const ny = cy + dy;
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
              const j = ny * W + nx;
              if (seen[j] || gray[j] >= 200) continue;
              seen[j] = 1;
              px.push(j);
            }
          }
        }
        const bw = bx1 - bx0 + 1;
        const bh = by1 - by0 + 1;
        // Two width bars. Fragments a few px tall need real width (a comma or a
        // dot crossing the band is small but ROUND, and extends outside it).
        // RAZOR-THIN fragments — 3 px or less — get a much lower bar: nothing
        // handwritten is 12 px wide and 2 px tall, and exactly such a sliver
        // (residue under "the") survived the single bar, was inflated by Pass B
        // into a 20x94 crop, and shipped as a phantom word on a phantom line.
        const wideEnough = bh <= 3
          ? bw >= Math.max(8, lineHeight * 0.15)
          : bw >= minW;
        if (
          by0 >= y0 && by1 <= y1        // entirely inside the rule band
          && bh <= Math.max(5, lineHeight * 0.1)
          && wideEnough && bw >= 3 * bh
          // The classifier's keeps outrank the sliver test — EXCEPT for
          // extreme rule shapes. The stroke-run stamps judge one column at a
          // time and keep a doubled rule's fragments where letter bottoms
          // thicken it; the component view sees the whole bar, and a detached
          // in-band run 6x wider than tall at <=4px is print with near
          // certainty (photorain's dashes under `called. "Now!"` filled the
          // word gap and welded a 20-unit span).
          && (kept < px.length * 0.25 || (bh <= 4 && bw >= 6 * bh))
        ) {
          for (const c of px) gray[c] = 255;
          erased++;
        }
      }
    }
  }
  return erased;
}

/**
 * Erase rule residue that has already WELDED itself to a letter, in place.
 *
 * `eraseRuleResidue` above floods the 8-connected component and requires its
 * bounding box to lie *entirely inside the rule band*. That test is exactly
 * right for a free-standing fragment and exactly wrong for the case that costs
 * the most: the instant a fragment touches a stroke that crosses the rule, the
 * component's bbox escapes the band and the filter declines to erase — so the
 * residue that IS bridging two letters is the residue that always survives.
 * Its own doc comment names the consequence ("no component-level filter can
 * catch it") without closing it.
 *
 * Two changes make it catchable:
 *
 *  1. **Decide per COLUMN, not per component.** Welding is what breaks a
 *     component test; it cannot break a column test. A column of pure residue
 *     has all its ink inside the band. A column of the crossing stroke has ink
 *     continuing above or below it. That distinction survives any amount of
 *     horizontal bridging, which is the whole point.
 *  2. **Ask stage 8.** The WASM pass already removed these rules from
 *     `pa.clean`, and measured on the test page it is not close: 5 leftover
 *     columns against 457 here, longest run 1 px against 56. It works on the
 *     grayscale, before binarization, with a running median of the rule's own
 *     colour along the seam and a run test for crossings — strictly more
 *     information than this scratch page has. Where stage 8 says paper inside a
 *     rule band, it is paper.
 *
 * Both must agree before a pixel is erased, so a faint mark that Sauvola or the
 * despeckler dropped from stage 8 is still protected by the column test if it
 * has any vertical extent at all.
 *
 * `clean` is stage 8's RGBA page (`PassAResult.clean`), same page coordinates as
 * `gray`. Returns the number of pixels erased.
 */
export function eraseWeldedRuleResidue(
  gray: Uint8Array,
  clean: Uint8ClampedArray,
  W: number, H: number,
  rules: { y: number[] | Float32Array; thickness: number }[],
  opts: { pad?: number; inkMax?: number; extend?: number; ruleCls?: Uint8Array | null } = {},
): number {
  // The band the traced thickness describes, widened a little: the rule's soft
  // shoulders sit outside the measured core, and they are what binarizes into
  // the thin surviving streak.
  const pad = opts.pad ?? 2;
  const inkMax = opts.inkMax ?? 200;
  // How far ink must continue past the band to count as a crossing stroke.
  const extend = opts.extend ?? 2;
  let erased = 0;
  for (const r of rules) {
    // `r.y` is indexed by column with no clamp here, unlike the readers above
    // that go through `Math.min(x, r.y.length - 1)`. Every producer in this file
    // emits a full-width trace, so this holds today; a short trace would make
    // the column silently inert (NaN fails every comparison) rather than throw.
    const hb = Math.max(1, r.thickness >> 1) + pad;
    for (let x = 0; x < W; x++) {
      const yc = Math.round(r.y[x]);
      const top = yc - hb;
      const bot = yc + hb;
      if (bot < 0 || top >= H) continue;
      // Does this column's ink continue beyond the band? Look `extend` px past
      // each edge; any ink there means a stroke passes through and the whole
      // column is left alone.
      let crossing = false;
      for (let d = 1; d <= extend && !crossing; d++) {
        const ya = top - d;
        const yb = bot + d;
        if (ya >= 0 && gray[ya * W + x] < inkMax) crossing = true;
        if (yb < H && gray[yb * W + x] < inkMax) crossing = true;
      }
      if (crossing) continue;
      for (let y = Math.max(0, top); y <= Math.min(H - 1, bot); y++) {
        const i = y * W + x;
        if (gray[i] >= inkMax) continue;      // already paper
        if (clean[i * 4] < 128) continue;     // stage 8 kept it — real ink
        // removeHRulesPage KEPT it — a stroke along the rule has no crossing
        // for this column test to see, and Pass A's cruder C-side remover
        // (whose `clean` verdict gates this loop) chews exactly those runs.
        // The classifier's keep outranks both.
        if (opts.ruleCls && opts.ruleCls[i] === 2) continue;
        gray[i] = 255;
        erased++;
      }
    }
  }
  return erased;
}

/**
 * Erase FLAT-STRIP rule residue, in place — the strips the column tests keep.
 *
 * Two populations survive the removers above, both user-visible as underscores
 * (photorain: "_Stars", "it_over", "_never"): (1) the rule's SHOULDER SMEAR —
 * a soft gray band 10-20 px ABOVE the printed rule (emboss/shadow), outside
 * every eraser's band, that binarizes into "ink" and is then rendered fully
 * dark by the per-character normalizer; (2) locally DOUBLED/darker rule
 * segments inside the band, which the classifier keeps because they really
 * are darker than the rule's running median — its keep is per COLUMN, and no
 * column of a 25 px bar looks different from a stroke along the rule.
 *
 * The strip view sees what the columns cannot: a LONG, THIN, vertically
 * ISOLATED bar near a rule, whose darkness matches the SUBSTRATE, not the
 * pen. Measured (photorain): page ink medians 134; all four residue strips
 * 149-163; their flanks at the same rule offset 192-248. A real pen stroke
 * measures at ink level — which is what protects the em-dash and deliberate
 * underlines, both long/thin/flat and (at ~0.5 xh over the baseline) inside
 * this band: the darkness floor is load-bearing, never remove it.
 *
 * Strips are chained from per-column vertical runs (height <= maxH, no other
 * ink within 3 px above/below), so a strip welded to a letter at its ends is
 * still caught — the weld columns fail the isolation test and the erase
 * stops short of them, exactly like eraseWeldedRuleResidue.
 *
 * RETURNS CANDIDATES, NEVER ERASES — the dotCandidates pattern, and both
 * halves of that are measured lessons from the two auto-erase attempts:
 * (1) erasing graySeg before segmentation reshuffled the welded neighbours'
 * per-char Otsu splits ("was"/"Could" lost light strokes the erase never
 * touched — residue is LOAD-BEARING for its neighbour's render); (2) even
 * erasing segPage only is unsafe, because THIS WRITER DRAGS LETTER BOTTOMS
 * flat along the rule — w/C/k/g bottoms measured 134-146 gray against
 * residue at 146-174, overlapping in every cheap feature (the C tail that
 * became "(ould" measured 134, pure pen). The candidates go on the clean
 * result as `flatStripCandidates`; the DECODE decides — a strip claimed by
 * a fitted character box is that character's ink, an unclaimed one is
 * residue (the editor's removeStripResidue; the user's own prescription:
 * "compare to predicted characters").
 */
export interface FlatStripCandidate {
  x0: number; x1: number; y0: number; y1: number;
  /** page-space pixel indices of the strip's ink */
  pixels: number[];
  /** median gray of the strip vs the local pen — kept for tuning/debug */
  stripMed: number; inkMed: number;
}

export function findFlatStripResidue(
  gray: Uint8Array, W: number, H: number,
  rules: { y: number[] | Float32Array; thickness: number }[],
  lineHeight: number,
  /** the page BEFORE rule removal (pa.gray) — the rule's own darkness is the
   *  expectation a residue strip must match; see the ruleLocal test below.
   *  OPTIONAL IN THE SIGNATURE ONLY: `ruleOk` is one of two conjuncts every
   *  candidate must satisfy and it can only be true when this is supplied, so
   *  calling without it returns [] on every page, silently. */
  rawGray?: Uint8Array,
): FlatStripCandidate[] {
  // debug seam (harness only): every candidate strip with its verdict
  const dbg = (globalThis as { __stripLog?: object[] }).__stripLog;
  const out: FlatStripCandidate[] = [];
  if (!rules.length) return out;
  const reach = Math.max(8, Math.round(lineHeight * 0.3));
  const inkMax = 200;
  const maxH = 5;
  const minW = 12;
  for (const r of rules) {
    // Per-column flat runs inside the widened band. A column may hold up to
    // TWO independent runs — a doubled rule leaves its residue as the
    // shoulder smear ABOVE the band plus the darker segment INSIDE it, and
    // the old one-run-only rule silently skipped exactly those columns.
    // Each run must be short (<= maxH) and vertically isolated on its own.
    type Run = { y0: number; y1: number };
    const colRuns: Run[][] = new Array(W);
    for (let x = 0; x < W; x++) {
      const yc = Math.round(r.y[x]);
      const top = Math.max(0, yc - reach);
      const bot = Math.min(H - 1, yc + reach);
      const runs: Run[] = [];
      let s0 = -1;
      let bad = false;
      for (let y = top; y <= bot + 1; y++) {
        const on = y <= bot && gray[y * W + x] < inkMax;
        if (on && s0 < 0) s0 = y;
        if (!on && s0 >= 0) {
          const run = { y0: s0, y1: y - 1 };
          s0 = -1;
          if (run.y1 - run.y0 + 1 > maxH || runs.length >= 2) { bad = true; break; }
          runs.push(run);
        }
      }
      if (bad || !runs.length) { colRuns[x] = []; continue; }
      colRuns[x] = runs.filter((run) => {
        for (let d = 1; d <= 3; d++) {
          const ya = run.y0 - d, yb = run.y1 + d;
          if (ya >= 0 && gray[ya * W + x] < inkMax) return false;
          if (yb < H && gray[yb * W + x] < inkMax) return false;
        }
        return true;
      });
    }
    // chain columns into strips: a run extends the strip whose previous
    // column's run y-overlaps it (±1); several strips can share an x-range
    // (smear above, doubled segment below).
    const open: { x0: number; last: Run; cols: Run[] }[] = [];
    const closed: { x0: number; x1: number; cols: Run[] }[] = [];
    for (let x = 0; x <= W; x++) {
      const runs = x < W ? (colRuns[x] ?? []) : [];
      const used = new Set<number>();
      for (let oi = open.length - 1; oi >= 0; oi--) {
        const st = open[oi];
        let hit = -1;
        for (let ri = 0; ri < runs.length; ri++) {
          if (used.has(ri)) continue;
          if (Math.min(st.last.y1, runs[ri].y1) >= Math.max(st.last.y0, runs[ri].y0) - 1) { hit = ri; break; }
        }
        if (hit >= 0) { used.add(hit); st.last = runs[hit]; st.cols.push(runs[hit]); }
        else { closed.push({ x0: st.x0, x1: st.x0 + st.cols.length - 1, cols: st.cols }); open.splice(oi, 1); }
      }
      for (let ri = 0; ri < runs.length; ri++) {
        if (!used.has(ri)) open.push({ x0: x, last: runs[ri], cols: [runs[ri]] });
      }
    }
    for (const st of closed) {
      const x = st.x0, xe = st.x1;
      const wpx = xe - x + 1;
      if (wpx >= minW) {
        // darkness vs the LOCAL pen: median of the strip against the median of
        // dark pixels in the text band above the rule, x-windowed. A strip
        // MEANINGFULLY LIGHTER than the local ink is substrate; at or below
        // ink level it is writing and must survive (the em-dash test).
        const vals: number[] = [];
        for (let cx = x; cx <= xe; cx++) {
          const run = st.cols[cx - x];
          for (let y = run.y0; y <= run.y1; y++) vals.push(gray[y * W + cx]);
        }
        vals.sort((a, b) => a - b);
        const stripMed = vals[vals.length >> 1];
        const inks: number[] = [];
        const wx0 = Math.max(0, x - 120), wx1 = Math.min(W - 1, xe + 120);
        const yc = Math.round(r.y[(x + xe) >> 1]);
        const wy0 = Math.max(0, yc - Math.round(lineHeight)), wy1 = Math.max(0, yc - reach - 1);
        for (let y = wy0; y <= wy1; y++) {
          for (let cx = wx0; cx <= wx1; cx++) if (gray[y * W + cx] < 150) inks.push(gray[y * W + cx]);
        }
        inks.sort((a, b) => a - b);
        const inkMed = inks.length >= 20 ? inks[inks.length >> 1] : 134;
        // THE DECIDING TEST — the strip against the RULE'S OWN local level,
        // sampled from the pre-removal page in flank windows at the trace.
        // Residue IS the rule's substance (a doubled/smeared segment), so it
        // reads at or lighter than the local rule; pen ink beats the rule.
        // Measured: photorain's true residues sit at ruleLocal-1..+28 while
        // every letter fragment on doubledia sits 8-32 DARKER than its rule
        // — including the "Could" C-tail (-22), which the darkness-vs-ink
        // bar alone could not protect. No overlap between the populations.
        let ruleOk = false;
        if (rawGray) {
          const rl: number[] = [];
          for (const side of [-1, 1]) {
            for (let k = 8; k < 90; k++) {
              const cx = side < 0 ? x - k : xe + k;
              if (cx < 0 || cx >= W) break;
              const yc2 = Math.round(r.y[cx]);
              let colMin = 255;
              for (let dy = -2; dy <= 2; dy++) {
                const y2 = yc2 + dy;
                if (y2 >= 0 && y2 < H) colMin = Math.min(colMin, rawGray[y2 * W + cx]);
              }
              if (colMin < 110) continue;   // real ink crosses the rule here
              rl.push(colMin);
            }
          }
          rl.sort((a, b) => a - b);
          const ruleMed = rl.length >= 10 ? rl[rl.length >> 1] : -1;
          ruleOk = ruleMed >= 0 && stripMed >= ruleMed - 5;
        }
        const kill = stripMed >= inkMed + 10 && ruleOk;
        if (dbg) dbg.push({ x0: x, x1: xe, y: st.cols[(wpx - 1) >> 1].y0, w: wpx, stripMed, inkMed, kill });
        if (kill) {
          const pixels: number[] = [];
          let sy0 = H, sy1 = 0;
          for (let cx = x; cx <= xe; cx++) {
            const run = st.cols[cx - x];
            if (run.y0 < sy0) sy0 = run.y0;
            if (run.y1 > sy1) sy1 = run.y1;
            for (let y = run.y0; y <= run.y1; y++) pixels.push(y * W + cx);
          }
          // RULE-PARALLEL: the strip must track the rule's own trace. A
          // DIAGONAL stroke's per-column runs are just as short and isolated
          // (a 45° stroke shifts one row per column and the chain follows
          // it — "was"'s w qualified as a 13px-tall "strip" that way), but
          // it drifts AWAY from the trace where printed residue never does.
          let offLo = Infinity, offHi = -Infinity;
          for (let cx = x; cx <= xe; cx++) {
            const off = st.cols[cx - x].y0 - r.y[cx];
            if (off < offLo) offLo = off;
            if (off > offHi) offHi = off;
          }
          if (offHi - offLo <= 4) {
            out.push({ x0: x, x1: xe, y0: sy0, y1: sy1, pixels, stripMed, inkMed });
          }
        }
      }
    }
  }
  return out;
}

/**
 * Erase VERTICAL rule residue, in place — the vertical twin of
 * eraseRuleResidue. The margin rule (often a DOUBLE line) is erased along its
 * trace, but fragments survive where the trace drifted or the second line of a
 * pair sat outside the band. Those fragments then become phantom "words" (a
 * lone vertical stroke, a box of smudges), and worse: whatever is left of them
 * in the MARGIN STRIP gets classified as a formatting symbol — a vertical
 * fragment reads as '1' and turns the first line into an ordered list.
 *
 * A residue fragment is thin (a few px wide), tall relative to its width, and
 * lies within the vrule's band (per-row trace x, widened by the traced
 * thickness plus slack for the second line of a double pair).
 */
export function eraseVRuleResidue(
  gray: Uint8Array, W: number, H: number,
  vrules: { x: number[] | Float32Array; thickness: number }[],
  lineHeight: number,
  opts: {
    /**
     * Use the tight inboard band on BOTH sides.
     *
     * The asymmetry below describes a MARGIN rule, where one side faces the page
     * edge and nothing is written there. A grid line has writing on both sides,
     * so the side the page midline calls "outboard" is just the other half of
     * the same sentence — and the generous band would erase the leading stem of
     * every letter to the right of every line right of centre, which is the
     * exact failure the asymmetry was introduced to stop on page D.
     */
    symmetric?: boolean;
  } = {},
): number {
  if (!vrules.length) return 0;
  const seen = new Uint8Array(W * H);
  let erased = 0;
  for (const v of vrules) {
    if (!v.x || v.x.length < H) continue;
    // Band half-width, ASYMMETRIC — the two sides of a margin rule are not the
    // same kind of place.
    //
    // Outboard (toward the page edge) is where the things this function exists
    // to kill live: the partner line of a double rule (measured pair gaps run
    // 10-20 px), trace drift, edge shadow. Nothing is written there, so a
    // generous band costs nothing.
    //
    // Inboard (toward the page centre) is where the WRITING starts, usually
    // immediately — that is what a margin is for. And the fragment test below
    // describes a residue fragment as thin and taller than wide, which is also
    // an exact description of the stem of an i, l, t, d or h. Measured on page D
    // of the corpus, the symmetric 26 px band swallowed the leading stem of two
    // lines that began 2-6 px inside the rule: 32 and 38 px of ink erased, and
    // the decoder then read the words without their first letter. So inboard
    // gets the rule's own half-thickness plus 2 px of drift allowance and no
    // more. Residue that far inside the band is rare; a first letter is not.
    const hbOut = Math.max(8, Math.round(v.thickness / 2) + Math.round(lineHeight * 0.3));
    const hbIn = Math.round(v.thickness / 2) + 2;
    // Which side the text is on: toward the middle of the page. Decided once
    // from the trace's own median column, not per row, so a wobbling trace
    // cannot flip the sides partway down the page.
    const xs = [] as number[];
    for (let y = 0; y < H; y++) xs.push(Math.round(v.x[y] as number));
    xs.sort((a, b) => a - b);
    const textRight = xs[xs.length >> 1] < W / 2;
    const hbL = opts.symmetric ? hbIn : textRight ? hbOut : hbIn;
    const hbR = opts.symmetric ? hbIn : textRight ? hbIn : hbOut;
    for (let y = 0; y < H; y++) {
      const cx = Math.round(v.x[y] as number);
      const x0 = Math.max(0, cx - hbL);
      const x1 = Math.min(W - 1, cx + hbR);
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        if (seen[i] || gray[i] >= 200) continue;
        const px: number[] = [i];
        seen[i] = 1;
        let head = 0;
        let bx0 = x, bx1 = x, by0 = y, by1 = y;
        while (head < px.length) {
          const c = px[head++];
          const ccx = c % W;
          const ccy = (c - ccx) / W;
          if (ccx < bx0) bx0 = ccx;
          if (ccx > bx1) bx1 = ccx;
          if (ccy < by0) by0 = ccy;
          if (ccy > by1) by1 = ccy;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = ccx + dx;
              const ny = ccy + dy;
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
              const j = ny * W + nx;
              if (seen[j] || gray[j] >= 200) continue;
              seen[j] = 1;
              px.push(j);
            }
          }
        }
        const bw = bx1 - bx0 + 1;
        const bh = by1 - by0 + 1;
        // Entirely inside the band at its own rows, thin, and taller than wide.
        // A letter that touches the margin (a generous crossbar) extends OUT of
        // the band, so its bbox fails the inside test and it survives.
        let inside = true;
        for (let yy = by0; yy <= by1 && inside; yy++) {
          const cxx = Math.round(v.x[yy] as number);
          if (bx0 < cxx - hbL || bx1 > cxx + hbR) inside = false;
        }
        if (inside && bw <= Math.max(5, lineHeight * 0.12) && bh >= 2 * bw) {
          for (const c of px) gray[c] = 255;
          erased++;
        }
      }
    }
  }
  return erased;
}

export function ccWordBoxes(
  gray: Uint8Array,
  W: number,
  H: number,
  ruleBaselines: number[],
  marginRightX: number,
  opts?: Partial<CCWordOptions>,
  out?: CCWordOut,
): BoxesJson {
  const debugOut = out?.debug;
  const lineMaskOut = out?.lineMask;
  const cleanOut = out?.clean;
  const o = { ...DEFAULT_CC_WORD_OPTIONS, ...opts };

  const paper = paper85(gray, W, H);
  const inkDark = Math.max(1, Math.round(o.inkDark));
  const inkT = Math.max(0, paper - inkDark);
  const power = Math.max(0.5, o.darkPower);
  const minStrength = Math.max(0, o.minStrength);
  const bridgePx = Math.max(0, Math.round(o.bridgePx));

  // The hand-painted override. Inside a PAINT_ADD stroke the bar drops to
  // "darkish" — the stroke is the precision, the threshold only has to be low
  // enough to catch the ink the page-wide bar already refused. (PAINT_CUT is
  // gone by now: `applyInkPaint` whitened those pixels before this ran.)
  const paint = o.inkPaint && o.inkPaint.length >= W * H ? o.inkPaint : null;
  const paintT = paint ? Math.max(0, paper - Math.max(1, Math.round(o.paintDark ?? PAINT_DARKISH))) : 0;

  const ink = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (gray[i] < (paint && paint[i] === PAINT_ADD ? paintT : inkT)) ink[i] = 1;
  }
  const bridged = dilateMask(ink, W, H, bridgePx);
  // A component's `strength` sums pow((paper - g) / 255, power) over its ink;
  // the term depends only on the gray value g, so it is tabulated once and
  // each pixel adds the identical number it did (Math.pow per pixel was a
  // measurable share of the labelling).
  const strengthOf = new Float64Array(256);
  for (let g = 0; g < 256; g++) {
    const d = (paper - g) / 255;
    strengthOf[g] = d > 0 ? Math.pow(d, power) : 0;
  }

  const label = new Int32Array(W * H).fill(-1);
  // The flood's stack is a typed array (a pixel is pushed at most once, so
  // W*H bounds it) and an interior pixel — one whose eight neighbours are all
  // on the page — takes a bounds-free path. The neighbours are pushed in the
  // same dy, dx order as the general path, so every component's pixel set and
  // its root (the raster-first pixel) are exactly what they were.
  const stack = new Int32Array(W * H);
  const all: Comp[] = [];
  const N8 = [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1];
  for (let s = 0; s < W * H; s++) {
    if (label[s] >= 0 || !bridged[s]) continue;
    label[s] = s;
    let sp = 0;
    stack[sp++] = s;
    let x0 = W;
    let y0 = H;
    let x1 = -1;
    let y1 = -1;
    let strength = 0;
    while (sp > 0) {
      const i = stack[--sp];
      const y = (i / W) | 0;
      const x = i - y * W;
      if (ink[i]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        strength += strengthOf[gray[i]];
      }
      if (x > 0 && x < W - 1 && y > 0 && y < H - 1) {
        for (let k = 0; k < 8; k++) {
          const q = i + N8[k];
          if (label[q] < 0 && bridged[q]) {
            label[q] = s;
            stack[sp++] = q;
          }
        }
        continue;
      }
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const q = yy * W + xx;
          if (label[q] < 0 && bridged[q]) {
            label[q] = s;
            stack[sp++] = q;
          }
        }
      }
    }
    if (x1 >= 0) all.push({ root: s, x0, y0, x1, y1, strength, strong: false });
  }

  const mys = [...ruleBaselines].sort((a, b) => a - b);
  const sp: number[] = [];
  for (let i = 1; i < mys.length; i++) sp.push(mys[i] - mys[i - 1]);
  let lineHeight = medianOf(sp);
  if (lineHeight <= 0) lineHeight = medianOf(all.map((c) => c.y1 - c.y0 + 1)) * 1.6 || H;
  const slack = lineHeight * 0.2;
  const assignLine = (y0: number, y1: number): number => {
    if (!mys.length) return 0;
    const h = y1 - y0 + 1;
    let rest = -1;
    for (let li = 0; li < mys.length; li++) {
      if (mys[li] <= y1 + slack) rest = li;
      else break;
    }
    if (rest < 0) rest = 0;
    while (rest + 1 < mys.length && mys[rest] < y0 + 0.1 * h) rest++;
    return rest;
  };

  // Split any component that fused two lines together (a descender resting on the letters
  // below). Runs BEFORE the acceptance gate so neither half is judged — or dropped by the
  // maxCharH gate — as one two-line-tall blob.
  const cross =
    mys.length >= 2
      ? separateCrossLine(all, label, ink, gray, strengthOf, W, mys, lineHeight)
      : { comps: all, splits: 0 };
  const comps = cross.comps;

  // Acceptance gate (strength + shape). We keep a wide net of candidates here (only
  // dropping obvious rule residue / merged lines / margin / pure noise), and let the
  // LOCATION-aware rescue below decide which weak/small blobs are real — a blob that
  // belongs to a word (hugging a letter) should be kept even if faint.
  const maxCharH = lineHeight * 3;
  const dotFloor = Math.min(minStrength, Math.max(0.5, minStrength * 0.15));
  // THE NOISE FLOOR WAS PRE-EMPTING THE LOCATION RESCUE the paragraph above
  // promises. A light i-dot is a handful of pixels: `plain`'s dot on doubledia
  // is three ink pixels (gray 172/183/196 against paper 253), strength 0.56
  // against a 1.2 floor — dropped here, before `stemBelow` ever got to see that
  // there is an i-stem 13px directly below it, and the word read `plan`. The
  // floor exists to keep sensor noise out, and that is a job the LOCATION test
  // does far better than an intensity threshold can: noise has nothing under
  // it. So a DOT-SIZED component is carried past the floor down to a much lower
  // absolute bar and judged on where it sits, exactly as the comment above
  // says. Everything else keeps the old floor: a large faint smudge has no
  // location argument to make and is still noise.
  const dotRescueFloor = dotFloor * 0.25;
  const dotRescueMax = lineHeight * 0.35;   // pre-gate; the real dotMax (from the
                                            // measured letter height) still applies below
  const marginCut = Math.max(0, Math.round(marginRightX));
  const marginLeftCut = Math.max(0, Math.round(o.marginLeftX ?? 0));

  // WHICH COMPONENTS DID THE WRITER PAINT, AND HOW MUCH OF THEM IS THE PAINT
  // ENTITLED TO? Answered here, after the cross-line split, from each
  // component's OWN ink — a descender cut away from a painted body is judged
  // on its own pixels rather than inheriting an exemption for ink nobody
  // pointed at. Only INK vouches, never the bridge halo: a stroke that merely
  // passes over blank paper beside a letter must not adopt that letter.
  //
  // The bound matters as much as the exemption. `bridged` welds dense writing
  // freely, and on a low-contrast page the whole sheet can come out as ONE
  // component that the size vetoes below then discard — measured on the
  // synthetic sample, where the component under a 135x14 px stroke was already
  // [16,16]-[738,993] with 24.6k ink pixels. Exempting THAT from the vetoes
  // admits the page as a single character: refCharH, the gap clustering and the
  // per-character render all collapse behind it (52 word boxes -> 12, segPage
  // ink 14.3k -> 37.5k, every printed rule drawn as writing).
  //
  // So the exemption is scoped by what the stroke can plausibly have meant:
  //
  //  - a component that COULD be a character keeps the old behaviour — paint
  //    any part of a faint letter and the whole letter is admitted, which is
  //    the forgiving reading and the common case;
  //  - a component that could not be one gets the LITERAL reading instead
  //    ("any darkish pixel in that area"): the painted ink is split off as its
  //    own component and the unpayable remainder goes on to be dropped exactly
  //    as it was. The brush is then bounded by itself, which is the one bound
  //    the writer can see while painting.
  if (paint) {
    const plausibleChar = (c: Comp): boolean => {
      const bw = c.x1 - c.x0 + 1;
      const bh = c.y1 - c.y0 + 1;
      if (bh > maxCharH) return false;                             // merged lines
      if (bh > lineHeight * 2.5 && bw < bh * 0.35) return false;    // vertical rule residue
      if (bw > W * 0.45 && bh < lineHeight * 0.55) return false;    // horizontal rule
      return true;
    };
    const extra: Comp[] = [];
    const stack2: number[] = [];
    for (const c of comps) {
      let seed = -1;
      for (let y = c.y0; y <= c.y1 && seed < 0; y++) {
        const row = y * W;
        for (let x = c.x0; x <= c.x1; x++) {
          const i = row + x;
          if (ink[i] && label[i] === c.root && paint[i] === PAINT_ADD) { seed = i; break; }
        }
      }
      if (seed < 0) continue;
      if (plausibleChar(c)) { c.painted = true; continue; }
      // Split every painted island out of this component. Connectivity runs
      // through PAINTED ink only, so the piece can never be larger than what
      // the stroke covers.
      const claimed = new Uint8Array((c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1));
      const cw = c.x1 - c.x0 + 1;
      for (let sy = c.y0; sy <= c.y1; sy++) {
        for (let sx = c.x0; sx <= c.x1; sx++) {
          const s0 = sy * W + sx;
          const li = (sy - c.y0) * cw + (sx - c.x0);
          if (claimed[li] || !ink[s0] || label[s0] !== c.root || paint[s0] !== PAINT_ADD) continue;
          claimed[li] = 1;
          stack2.length = 0;
          stack2.push(s0);
          const pix: number[] = [];
          let x0 = W, y0 = H, x1 = -1, y1 = -1, strength = 0;
          while (stack2.length) {
            const i = stack2.pop() as number;
            const y = (i / W) | 0;
            const x = i - y * W;
            pix.push(i);
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
            strength += strengthOf[gray[i]];
            for (let dy = -1; dy <= 1; dy++) {
              const yy = y + dy;
              if (yy < c.y0 || yy > c.y1) continue;
              for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue;
                const xx = x + dx;
                if (xx < c.x0 || xx > c.x1) continue;
                const q = yy * W + xx;
                const ql = (yy - c.y0) * cw + (xx - c.x0);
                if (claimed[ql] || !ink[q] || label[q] !== c.root || paint[q] !== PAINT_ADD) continue;
                claimed[ql] = 1;
                stack2.push(q);
              }
            }
          }
          if (x1 < 0) continue;
          const root = pix[0];
          for (const p of pix) label[p] = root;
          extra.push({ root, x0, y0, x1, y1, strength, strong: true, painted: true });
        }
      }
    }
    comps.push(...extra);
  }

  const kept: Comp[] = [];
  for (const c of comps) {
    const bw = c.x1 - c.x0 + 1;
    const bh = c.y1 - c.y0 + 1;
    // PAINTED INK SKIPS THE WHOLE GATE. Every test below is a guess about
    // whether a shape is writing, made without ever seeing it; the paint
    // stroke is a person who has. It is also the only behaviour that is
    // predictable to use — a brush that admits ink except when some unstated
    // aspect ratio disagrees is worse than no brush. `strong` is set so the
    // downstream rules treat it as a real letter body rather than a mark
    // hunting for a stem to hug.
    if (c.painted) { c.strong = true; kept.push(c); continue; }
    if (bh > lineHeight * 2.5 && bw < bh * 0.35) continue; // tall & thin = vertical rule residue
    if (bw > W * 0.45 && bh < lineHeight * 0.55) continue; // wide & thin = leftover horizontal rule
    if (bh > maxCharH) continue; // merged lines / artifact
    if (marginCut > 0 && c.x1 < marginCut) continue; // entirely inside the margin
    if (marginLeftCut > 0 && c.x0 > marginLeftCut) continue; // …or inside a right-hand margin
    c.strong = c.strength >= minStrength;
    if (!c.strong && c.strength < dotFloor) {
      // (A "cut by the frame, beside a word" rescue for sub-floor border
      // fragments was built here and REVERTED: with the page quad cutting at
      // the paper edge, a frame-cut letter's ink is mostly outside the warp
      // — see the edgeInkRetry note in index.ts — so the rescue's real
      // population barely exists, while it admits border shadow specks
      // beside line-ending words: measured +1 weirdpage error, 0 recovered.)
      const dotish = bw <= dotRescueMax && bh <= dotRescueMax;
      if (!dotish || c.strength < dotRescueFloor) continue; // below the noise floor
      c.weakDot = true;
    }
    kept.push(c);
  }

  // Reference letter height, measured from the actual strong letter bodies on the page
  // (not the rule spacing) so it's robust to a mis-estimated lineHeight (spurious/absent
  // rules). Used to tell a dot/period-sized mark from a real letter.
  const bodyMinH = lineHeight * 0.3;
  const bodies = kept.filter((c) => c.strong && c.y1 - c.y0 + 1 >= bodyMinH);
  const strongHeights = bodies.map((b) => b.y1 - b.y0 + 1).sort((a, b) => a - b);
  const refCharH = strongHeights.length ? strongHeights[Math.floor(strongHeights.length * 0.6)] : lineHeight * 0.5;
  const dotMax = refCharH * 0.42; // a dot/period is small in BOTH dims vs a real letter
  const dotLeeway = refCharH * 0.6; // horizontal slack for a mark sitting over / beside a body
  const bandPad = lineHeight * 0.15;

  // Small-mark validation (the dot rule). A dark, big-enough blob is a letter and is
  // always kept as its own character box. A SMALL mark (dot-sized in both dims, or a
  // faint blob) is kept only when it is part of a real letter:
  //   • a STEM/body sits just BELOW it, roughly under its centre → an i/j dot or an accent
  //     (this is the "look for a stem below so it isn't a stray mark" test), OR
  //   • it hugs a letter body horizontally on the baseline → a period / comma beside a word.
  // A small mark with neither is a stray speck (scanner noise, bleed-through) → dropped.
  // Returns the body it found rather than a bare yes/no: the body is the right
  // darkness reference for the dot, and the caller needs it (see faintDots).
  // THE NEAREST body, not the first one `bodies` happens to hold. `dotLeeway` is
  // 0.6 of a letter height of horizontal slack, so a dot between two letters
  // matches BOTH — and the array is in raster-discovery order, so which one was
  // returned depended on where its root pixel fell. `plain`'s i-dot on doubledia
  // matched the `a` three letters' worth of slack to its left before the i-stem
  // 2px to its right. That mattered twice over: the returned body is also the
  // darkness reference `liftFaintDots` lifts the dot to, so the wrong body meant
  // the wrong lift as well as the wrong verdict.
  const stemBelow = (c: Comp): Comp | null => {
    const cx = (c.x0 + c.x1) / 2;
    let best: Comp | null = null;
    let bestD = Infinity;
    for (const b of bodies) {
      if (b === c) continue;
      if (cx < b.x0 - dotLeeway || cx > b.x1 + dotLeeway) continue; // not above this body
      const vgap = b.y0 - c.y1; // body top relative to the mark's bottom
      if (vgap < -lineHeight * 0.25 || vgap > lineHeight * 0.6) continue;
      const d = cx < b.x0 ? b.x0 - cx : cx > b.x1 ? cx - b.x1 : 0; // 0 = directly over it
      if (d < bestD) { bestD = d; best = b; }
    }
    // …and a STEM counts as a body here even though `bodies` excludes it. The
    // same circularity as the weak rescue below, one level up: `said`, `in` and
    // `plain` on doubledia have i-dots that CLEAR the noise floor and are still
    // dropped, because the only thing under them is a dotless i — 10-14 px
    // against `bodyMinH`'s 15 — so `stemBelow` finds nothing and `hugsLetter`
    // cannot reach either (a dot rides ABOVE the x-height band its neighbours
    // occupy, so the band test fails by design). A narrow, stem-shaped
    // component directly below is exactly the claim an i-dot makes; requiring
    // it to be full-letter TALL asks the dot to prove what its own absence
    // caused.
    if (!best) best = stemBelowIn(c, weakStems);
    return best;
  };
  // (`weakStems` and `stemBelowIn` are declared BELOW this. That is legal only
  // because nothing calls `stemBelow` until the `kept.filter` further down, by
  // which point both are initialised — move a call above them and it throws.)
  const hugsLetter = (c: Comp): boolean => {
    for (const b of bodies) {
      if (b === c) continue;
      const hgap = Math.max(0, b.x0 - c.x1, c.x0 - b.x1);
      if (hgap > dotLeeway) continue; // too far from any letter
      const atBaseline = c.y1 >= b.y1 - lineHeight * 0.35 && c.y0 >= b.y0 + bandPad; // low & short (period/comma)
      const bandOverlap = c.y1 >= b.y0 - bandPad && c.y0 <= b.y1 + bandPad; // shares the letter's band
      if (atBaseline || bandOverlap) return true;
    }
    return false;
  };
  // STEMS FOR THE WEAK RESCUE, which `bodies` cannot supply. `bodies` requires
  // `bodyMinH` = 0.3 of the LINE height, and the thing under an i-dot is a
  // DOTLESS lowercase i: measured on doubledia, `said`/`in`/`plain` have stems
  // of 10-14 px against that 15 px floor, so none of them is a body. The
  // circularity is the point — the dot is dropped for want of a body, and the
  // body is too short precisely BECAUSE its dot is missing. So the weak rescue
  // gets its own pool, keyed on the shape that actually wants a dot (narrow,
  // and tall enough to be a stem rather than another speck) instead of on a
  // height floor calibrated for full letters.
  // NOT gated on `strong`: the stem under a faint dot is usually faint TOO —
  // `said`'s i-stem measures strength 5.6 against minStrength 8, written in the
  // same light touch as the dot above it. Requiring a dark stem to rescue a
  // light dot asks the wrong half of one stroke to vouch for the other. Shape
  // carries it instead: narrow, and tall enough to be a stem; the caller adds
  // the discriminator that a speck cannot fake — a stem is several times the
  // height of the dot that crowns it.
  const weakStems = kept.filter((c) => {
    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    return bw <= refCharH * WEAK_DOT_STEM && bh >= refCharH * 0.3 && bh <= refCharH * 1.8;
  });
  /** Nearest stem-shaped component below `c`, over an arbitrary pool. */
  const stemBelowIn = (c: Comp, pool: Comp[]): Comp | null => {
    const cx = (c.x0 + c.x1) / 2;
    let best: Comp | null = null, bestD = Infinity;
    for (const b of pool) {
      if (b === c) continue;
      if (cx < b.x0 - dotLeeway || cx > b.x1 + dotLeeway) continue;
      const vgap = b.y0 - c.y1;
      if (vgap < -lineHeight * 0.25 || vgap > lineHeight * 0.6) continue;
      // a stem is SEVERAL TIMES the height of its dot; two specks stacked are
      // not a letter, and this is the one ratio a speck cannot fake
      if ((b.y1 - b.y0 + 1) < STEM_DOT_RATIO * (c.y1 - c.y0 + 1)) continue;
      const d = cx < b.x0 ? b.x0 - cx : cx > b.x1 ? cx - b.x1 : 0;
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  };
  const faintDots: FaintDot[] = [];
  const dotCandidates: DotCandidate[] = [];
  /** Is there real, letter-sized ink close to this mark? */
  const nearInkAny = (c: Comp): boolean => {
    for (const b of kept) {
      if (b === c) continue;
      const bw2 = b.x1 - b.x0 + 1, bh2 = b.y1 - b.y0 + 1;
      if (bw2 * bh2 < 0.1 * refCharH * refCharH) continue;
      if (Math.max(0, b.x0 - c.x1, c.x0 - b.x1) > refCharH * 0.6) continue;
      if (Math.max(0, b.y0 - c.y1, c.y0 - b.y1) > refCharH * 1.0) continue;
      return true;
    }
    return false;
  };
  /** Record a rejected dot-sized mark before it disappears from the page.
   *  Metadata only: it is NOT restored to the render and NOT offered to the
   *  segmenter, because both of those were measured to cost words (a speck
   *  promoted to a letter, then to a word). It exists so the RECOGNIZER can
   *  ask for it back once it knows the character below wants a dot. */
  const rejectDot = (c: Comp) => {
    const bw2 = c.x1 - c.x0 + 1, bh2 = c.y1 - c.y0 + 1;
    if (bw2 > dotMax || bh2 > dotMax) return;   // only dot-sized ink is a dot
    if (!nearInkAny(c)) return;                 // …and only ink beside writing
    // A Comp is label-based, not a pixel list — collect from the label map over
    // the mark's own (tiny) bounding box. `label` holds the BRIDGED root, so
    // matching it keeps a neighbour's stroke out of the box; where the crossing
    // splitter has re-rooted things, plain ink in a 3x5 box is the same set.
    const pxs: [number, number][] = [];
    let dark = 255;
    for (let y = c.y0; y <= c.y1; y++) {
      for (let x = c.x0; x <= c.x1; x++) {
        const i = y * W + x;
        if (!ink[i]) continue;
        if (label[i] >= 0 && label[i] !== c.root) continue;
        pxs.push([x, y]);
        if (gray[i] < dark) dark = gray[i];
      }
    }
    if (pxs.length) dotCandidates.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, pixels: pxs, dark });
  };
  const final = kept.filter((c) => {
    if (c.painted) return true; // see the gate above — the writer already answered this
    const bw = c.x1 - c.x0 + 1;
    const bh = c.y1 - c.y0 + 1;
    // A BORDER SLIVER IS VETOED AT COMPONENT LEVEL, before grouping. The
    // word-box rule below ("ink that runs INTO the border and is 3x taller
    // than wide") cannot see a sliver that GROUPED: weirdpage's left-edge
    // binding shadow sat 9 px from the first word, joined its word box, and
    // rode a 313px-wide rec into the editor as a black bar no filter could
    // reach. Same argument, component granularity. (A 1.2-lineHeight height
    // cap was tried here when a frame-cut d seemed to be this veto's victim
    // — it was not: the page QUAD had cut the letter, see index.ts
    // edgeInkRetry — and the cap only readmitted border chips, +1 word.)
    {
      const edge = Math.max(2, Math.round(0.06 * lineHeight));
      const toEdge = Math.min(c.x0, W - 1 - c.x1, c.y0, H - 1 - c.y1);
      if (toEdge <= edge && bh >= 3 * bw) return false;
    }
    // A DOT IS ROUND; A STROKE IS NOT. This test is meant to say "dot-sized in
    // BOTH dims (not a tall i/l/1)" and it said it with two independent caps —
    // which a SHORT stem slips under. weirdpage's `is` has a 4x18 stem against
    // a dotMax of 18.5: half a pixel from being treated as a letter, at 4.5:1
    // aspect and strength 20.5 against a floor of 8. It then failed the dot
    // rule for the reason an i-stem always will (nothing sits BELOW a stem, and
    // its own `s` was 17 px away, too far to hug), and the page read `good s
    // the`. Aspect is what the comment always meant, and it is the feature that
    // separates the two: across all nine corpus pages exactly two strong
    // components are dot-boxed and rejected — this stem at 4.5:1 and a
    // page-edge fragment on page A at 2.6:1. DOT_ASPECT is 3, the same "tall
    // and thin" ratio the border-sliver veto above already uses, so the page-A
    // fragment stays rejected on a bar that was not fitted to it.
    const small = bw < dotMax && bh < dotMax && bh < DOT_ASPECT * bw;
    if (c.strong && !small) return true; // dark & big enough → a real letter, own box
    const body = stemBelow(c);
    // A FAINT mark with a letter under it is an i/j dot written with a light
    // touch. Record it: downstream stages threshold on intensity and would
    // otherwise lose exactly the marks this rule just went to the trouble of
    // keeping. A strong dot needs no help.
    //
    // HELD, NOT PUSHED YET. The weak-dot branch below can still REJECT this
    // mark, and the record used to be pushed before that decision was made — so
    // a sub-floor speck over a WIDE body (the exact population that branch exists
    // to throw away: no narrow stem beneath it) was dropped from the segmentation
    // and still handed to `liftFaintDots`, which stretches its contrast up to 4x
    // in `pa.gray` — the page Pass B crops every word from. The rejection and the
    // record have to agree, so the record is committed only where the mark is.
    const faintOf = (b: Comp): FaintDot => ({
      x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1,
      bodyX0: b.x0, bodyY0: b.y0, bodyX1: b.x1, bodyY1: b.y1,
    });
    const faint = body && !c.strong ? faintOf(body) : null;
    // A SUB-FLOOR RESCUE GETS THE STEM ROUTE ONLY. The baseline-hug route says
    // "there is a letter somewhere beside me", which almost anything on a line
    // of text can say — fine for ink that already cleared the noise floor, and
    // far too weak for ink that did not: measured, letting sub-floor blobs hug
    // cost 3 words on photorain and 2 on gal, all of them the same failure
    // (a speck became its own word box and read as a phantom `i`/`I`), against
    // the one i-dot it was there to save. A body directly BELOW is the claim a
    // dot can actually make.
    // …and over a STEM, which is what the test is named for. `stemBelow` accepts
    // any body, which is right for ink that already cleared the noise floor; for
    // ink that did not, the narrow ascender of an i/j/l/t is the shape that
    // actually wants a dot, and a wide body with a faint speck over it is noise.
    // Measured against the alternative gate — "the dot must be CENTRED on its
    // body" (stemDist <= 0.3 refCharH) — which rescues one more real dot
    // (`plain`) and costs five: photo 31 -> 36. Width is the discriminating
    // feature here, position is not.
    if (c.weakDot) {
      const narrow = body && body.x1 - body.x0 + 1 <= refCharH * WEAK_DOT_STEM ? body : null;
      const stem = narrow || stemBelowIn(c, weakStems);
      if (!stem) { rejectDot(c); return false; }
      // `stemBelow` may have matched nothing (no BODY qualifies) while the weak
      // pool found the real stem, so the lift reference falls back to the stem —
      // a dot lifted to the wrong letter's darkness is the bug
      // docs/faint-dots.md warns about.
      faintDots.push(faint ?? faintOf(stem));
      return true;
    }
    const keep = body !== null || hugsLetter(c); // a small/faint mark must belong to a letter
    if (!keep) rejectDot(c);
    // (`faint` implies `body`, and `body` implies `keep`, so this commits exactly
    // the records the old unconditional push did on every path but the one above.)
    if (keep && faint) faintDots.push(faint);
    return keep;
  });
  if (out) { out.faintDots = faintDots; out.dotCandidates = dotCandidates; }

  // Core-height cutoff for the thin-mark test, relative to the real letter height (NOT
  // the rule spacing) so a normal-height letter always registers a solid core and only
  // genuine crossbars / underlines / dots come out "thin".
  const minCore = Math.max(2, Math.round(o.coreHeightFrac * 2 * refCharH));
  // A thin mark wider than a letter is an underline / strikethrough, not a letter.
  const barMinW = refCharH * 1.3;
  interface Ch {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    /** The x-span used for word-gap measurement: the character body's CORE (solid
     *  strokes; thin tails excluded), or the full box for an all-thin char (a lone dot). */
    gapL: number;
    gapR: number;
    /** Excluded from the word-gap computation + word building. ONLY true for a WIDE THIN
     *  bar (underline/strikethrough) — including it would bridge every gap under it. Every
     *  other char, INCLUDING a lone dot/period, is a normal participant in the gaps. */
    skip: boolean;
    line: number;
  }

  // Per-blob core x-extent (solid strokes; thin tails trimmed), its line, and whether it's
  // a wide thin bar. Computed once so the overlap-merge below can hold bars out.
  const solid = final.map((c) => {
    const { cx0, cx1, thin } = coreExtent(label, c.root, ink, c.x0, c.y0, c.x1, c.y1, W, minCore);
    const bar = thin && c.x1 - c.x0 + 1 > barMinW; // wide horizontal stroke = underline/strike
    return { cx0, cx1, thin, bar, line: assignLine(c.y0, c.y1) };
  });

  // WHICH LINE DOES A MARK BELONG TO — decided here, at the segmenter, so the
  // answer reaches EVERY consumer: the word crops an editor displays, Pass B's
  // baselines, and the decode bands. The rules are the measured ones
  // `wordgpu/page.mjs linesFromRecs` applies when cutting bands (the ragù-comma
  // and À-bientôt cases recorded there), restructured as positive evidence in
  // descending strength — and, crucially, with the band cutter's OTHER
  // principle carried over too: when no evidence is decisive the mark is
  // `maskFree`, i.e. UNCLAIMED in the line mask, so a crop keeps it rather
  // than amputating it. Measured need: this writer's trailing commas dip
  // +0.93..1.1 xh below their baseline — outside every resting window — and a
  // single-owner mask erased a real comma from the very word it trails
  // (page.mjs keeps a verdict-less mark in every band that covers it; crops
  // must do the same). Grouping still uses the single best line either way.
  // `HW_LINE_DEBUG=1` prints every component with the line it was given —
  // the one view that shows a dot or a descender on the wrong line, which is
  // otherwise visible only as a stray mark inside somebody else's crop.
  const lineDebug = typeof process !== 'undefined' && !!process.env?.HW_LINE_DEBUG;
  if (lineDebug) {
    console.log(`[line] rules ${mys.map((y) => Math.round(y)).join(',')} lineHeight=${Math.round(lineHeight)}`);
    for (let i = 0; i < final.length; i++) {
      const c = final[i];
      const b = mys[solid[i].line];
      const above = b === undefined ? 0 : (b - c.y0) / lineHeight;
      console.log(`[line] comp ${i} [${c.x0},${c.y0}-${c.x1},${c.y1}] line=${solid[i].line}`
        + ` top=${above.toFixed(2)}LH above its baseline${above > 1.2 ? '  << TOO HIGH' : ''}`);
    }
  }
  let markMoves = 0;
  // Mark-sized: the population the line rules below judge (a dot, an accent, a
  // comma) as opposed to a letter body. Defined once — it was written out twice,
  // identically, in the two blocks that use it.
  const markSized = (c: Comp) =>
    c.y1 - c.y0 + 1 <= lineHeight * 0.5 && c.x1 - c.x0 + 1 <= lineHeight * 0.9;
  const maskFree: boolean[] = new Array(final.length).fill(false);
  const dropHigh = new Set<number>();
  // per line: the highest LETTER top. Mark-sized comps — the very population
  // rule 1.5 judges — are excluded, or a floating blob sets its OWN ceiling
  // and shields itself (the 10x28 blob qualified as a "letter" at a
  // 0.2-lineHeight floor and did exactly that).
  const lineTopOfInk = new Map<number, number>();
  {
    for (let i = 0; i < final.length; i++) {
      const c = final[i];
      if (c.y1 - c.y0 + 1 < lineHeight * 0.2 || markSized(c)) continue;
      const ln = solid[i].line;
      const cur = lineTopOfInk.get(ln);
      if (cur === undefined || c.y0 < cur) lineTopOfInk.set(ln, c.y0);
    }
  }
  if (mys.length >= 2) {
    const xh = lineHeight * 0.45;
    for (let i = 0; i < final.length; i++) {
      const c = final[i];
      if (!markSized(c)) continue;
      const own = solid[i].line;
      const b = mys[own];
      if (b === undefined) continue;
      const inCore = !(c.y1 < b - lineHeight * 0.55 || c.y0 > b + lineHeight * 0.08);

      // (1) A LETTER DIRECTLY BENEATH claims the mark as its diacritic or dot —
      // the strongest evidence, and the only kind that works for ink whose
      // bottom is nowhere near a baseline. The mark's OWN line is included (an
      // accent confirmed over its own letter stays owned instead of falling to
      // the shared fallback); a DIFFERENT line's letter re-homes it (the
      // À-bientôt case: the accent's bottom sits 14 px below the previous
      // line's baseline, and only the A beneath it says where it belongs).
      // 0.35 xh of vertical gap, measured: at 0.6 this stole trailing commas
      // downward — a comma also has next-line ink beneath it, just ~0.8 xh
      // down, against an accent's 0.26.
      const cw = c.x1 - c.x0 + 1;
      const cx = (c.x0 + c.x1) / 2;
      // A DOT RIDES HIGH OVER ITS STEM, and 0.35 xh does not reach it: this
      // writer's i-dots sit 0.6-0.8 xh clear of the letter, which is the same
      // reach a trailing comma has to the next line's ink — the ambiguity the
      // tight bound was protecting against. What separates them is what lies
      // BESIDE the mark: a comma trails a word, so its own line's letters
      // overlap its rows a stroke to its left; a dot has nothing at its
      // height but the page. So the reach opens to `MARK_STEM_REACH` for a
      // mark with no neighbour of its own line beside it. Without this the
      // dot is not claimed here, rule (2) hands it to the NEAREST baseline —
      // which is the line ABOVE, since a dot is closer to the line it rides
      // under than to its own — and rule (3) then marks it unclaimed, so it
      // paints inside the crop of the word above (measured: `Site copy` came
      // back wearing the i-dot of `Millirec`).
      let besideOwn = false;
      for (let j = 0; j < final.length && !besideOwn; j++) {
        if (j === i || solid[j].line !== own) continue;
        const d = final[j];
        if (d.y1 < c.y0 || d.y0 > c.y1) continue;      // must overlap its rows
        // …and RESTING WHERE IT RESTS. A comma's neighbours are the letters it
        // trails: they end on the same baseline it sits on. An ascender beside
        // a dot overlaps the dot's rows too, and runs a whole x-height further
        // down — it is not a word this mark is trailing, so it must not shorten
        // the reach to the stem underneath.
        if (Math.abs(d.y1 - c.y1) > xh * MARK_TRAIL_LEVEL) continue;
        const hg = d.x0 > c.x1 ? d.x0 - c.x1 : c.x0 - d.x1;
        if (hg <= xh * 1.5) besideOwn = true;          // …a stroke away
      }
      // A mark with nothing resting beside it is looked for its letter with a
      // longer reach, a little horizontal slack (a dot drifts off its stem)
      // and a lower bar on what counts as a body (an under-inked stem is
      // still the letter this dot belongs to).
      const reach = besideOwn ? xh * 0.35 : xh * MARK_STEM_REACH;
      const slackX = besideOwn ? 0 : xh * 0.25;
      const minBody = xh * (besideOwn ? 0.5 : 0.45);
      let bodyL = -1;
      let bodyGap = Infinity;
      for (let j = 0; j < final.length; j++) {
        if (j === i) continue;
        const d = final[j];
        if (d.y0 <= c.y1) continue;                    // must be BELOW the mark
        const vg = d.y0 - c.y1;
        if (vg > reach) continue;                      // …and close below it
        if (cw > d.x1 - d.x0 + 1) continue;            // no wider than its letter
        if (cx < d.x0 - slackX || cx > d.x1 + slackX) continue;  // …and under it
        if (d.y1 - d.y0 + 1 < minBody) continue;       // a letter body, not a speck
        if (vg < bodyGap) { bodyGap = vg; bodyL = solid[j].line; }
      }
      if (bodyL >= 0) {
        if (lineDebug) console.log(`[line] mark ${i} [${c.x0},${c.y0}-${c.x1},${c.y1}] claimed by a body below → line ${bodyL} (gap ${bodyGap.toFixed(0)}, reach ${reach.toFixed(0)}, beside=${besideOwn})`);
        if (bodyL !== solid[i].line) { solid[i].line = bodyL; markMoves++; }
        continue;
      }
      if (lineDebug) console.log(`[line] mark ${i} [${c.x0},${c.y0}-${c.x1},${c.y1}] UNCLAIMED (own ${own}, reach ${reach.toFixed(0)}, beside=${besideOwn})`);

      // (1.5) STRATOSPHERIC JUNK. The diacritic claim above just failed, so
      // there is no letter beneath — and this mark's BOTTOM sits well above
      // its own line's TOP-OF-INK (the highest letter top on the line), where
      // nothing belonging to the line can be: an i-dot or accent rides a few
      // px over the ascender that is itself part of that ceiling, a quote's
      // bottom sits below ascender tops. Measured against top-of-ink rather
      // than a baseline because on a skip-a-rule page the segmenter's
      // lineHeight is the WRITTEN pitch and every baseline-relative bound is
      // 2x generous. This is the previous sheet's ink showing at the top of
      // the photo — weirdpage: a 10x28 blob 70 px above line 0's tallest
      // letter, riding into "on"/"paper."'s crops as unclaimed ink. Dropped
      // outright, NOT maskFree: no crop should keep it, no band should read
      // it.
      const ceil = lineTopOfInk.get(own);
      if (ceil !== undefined && c.y1 < ceil - lineHeight * 0.3) { dropHigh.add(i); continue; }
      // Inside its own line's letter zone with no letter claiming it: an
      // ordinary mark (a period on the baseline, a low comma), confidently
      // owned as assigned. The letter-below test runs FIRST even for these —
      // a tall tick hugging the next line's ascender sits inside the upper
      // line's zone by geometry and still belongs to the letter under it
      // (doubledia's apostrophe, the original mark-move on this corpus).
      if (inCore) continue;

      // (2) BOTTOM-PLAUSIBILITY: where could this mark's bottom rest? Within
      // [-2.0, +0.85] x-heights of a baseline, nearest wins. An UP-move claims
      // "I am the previous line's trailing mark", and a trailing mark is TIGHT
      // against its word (corpus comma fit: gap -0.08..+0.15 xh) while a next
      // line's opening quote sits a word space clear — so an up-move needs a
      // letter on the destination line ending within 0.6 xh.
      const bot = c.y1;
      let bestL = -1;
      let bestD = Infinity;
      for (let li = 0; li < mys.length; li++) {
        const lb = mys[li];
        if (bot < lb - 2.0 * xh || bot > lb + 0.85 * xh) continue;
        const d = Math.abs(bot - lb);
        if (d < bestD) { bestD = d; bestL = li; }
      }
      // A mark standing INSIDE its own line's writing — its bottom at or below
      // the highest letter top on the line — is not the line above's trailing
      // mark, whatever the arithmetic of bottoms says. The line above's own
      // marks sit clear above that ceiling (its comma's bottom lands ~0.7 xh
      // over this line's ascender tops), so this guard costs them nothing and
      // keeps an i-dot whose stem is too short or too far below to claim it
      // (rule 1) from being handed upward and painted into the word above.
      const zoneTop = lineTopOfInk.get(own);
      const inZone = zoneTop !== undefined && c.y1 >= zoneTop && c.y1 <= (mys[own] ?? Infinity);
      if (bestL >= 0 && bestL !== own && !(inZone && mys[bestL] < mys[own])) {
        let gated = false;
        if (mys[bestL] < mys[own]) {
          let tight = false;
          for (let j = 0; j < final.length; j++) {
            if (j === i || solid[j].line !== bestL) continue;
            if (final[j].y1 - final[j].y0 + 1 < xh * 0.5) continue; // a letter, not a speck
            if (final[j].x0 < c.x0 && c.x0 - final[j].x1 < xh * 0.6) { tight = true; break; }
          }
          gated = !tight;
        }
        if (!gated) { solid[i].line = bestL; markMoves++; }
      }

      // (3) OWNERSHIP IS CONFIDENT when the bottom genuinely RESTS near the
      // chosen line's baseline — or when the mark stands inside that line's
      // own writing (see `inZone` above), which is the i-dot whose stem was
      // too short to claim it. A deep comma (this writer: +0.93..1.1 xh)
      // matches neither: it hangs BELOW its baseline, between two lines, and
      // assignLine's default is then a guess — a guess is exactly what a crop
      // must not be amputated on, so the mark goes UNCLAIMED in the mask and
      // shows in every crop whose rectangle covers it, precisely as an
      // unresolved component stays in every decode band.
      const fb = mys[solid[i].line];
      const rests = fb !== undefined && Math.abs(c.y1 - fb) <= 0.85 * xh;
      if (!rests && !(inZone && solid[i].line === own)) maskFree[i] = true;
    }
  }

  // The stratospheric drops leave every array in sync by filtering all three
  // together — the union-find below indexes into `final`, so this must happen
  // before it.
  if (dropHigh.size) {
    const keepIdx = final.map((_, i) => i).filter((i) => !dropHigh.has(i));
    const f2 = keepIdx.map((i) => final[i]);
    const s2 = keepIdx.map((i) => solid[i]);
    const m2 = keepIdx.map((i) => maskFree[i]);
    final.length = 0; final.push(...f2);
    solid.length = 0; solid.push(...s2);
    maskFree.length = 0; maskFree.push(...m2);
  }

  // Merge blobs that OVERLAP in x on the SAME line into one CHARACTER box: an i/j dot (or
  // accent) over its stem, a colon's two dots, or two touching letters all collapse into a
  // single box. Word gaps only measure the empty spans BETWEEN separate characters, so
  // fusing overlapping ink is safe — and it makes a dot ride its stem automatically without
  // any special stacking test (the dot's box x-overlaps the stem's, same line). A wide thin
  // bar is held OUT of the merge (and dropped) so it can't bridge every character beneath it.
  const uf = final.map((_, i) => i);
  const find = (i: number): number => {
    while (uf[i] !== i) {
      uf[i] = uf[uf[i]];
      i = uf[i];
    }
    return i;
  };
  for (let a = 0; a < final.length; a++) {
    if (solid[a].bar) continue;
    for (let b = a + 1; b < final.length; b++) {
      if (solid[b].bar || solid[a].line !== solid[b].line) continue;
      const ca = final[a];
      const cb = final[b];
      if (Math.max(ca.x0, cb.x0) <= Math.min(ca.x1, cb.x1)) {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) uf[rb] = ra;
      }
    }
  }
  const charGroups = new Map<number, number[]>();
  for (let i = 0; i < final.length; i++) {
    const r = find(i);
    const g = charGroups.get(r);
    if (g) g.push(i);
    else charGroups.set(r, [i]);
  }

  const charComps = [...charGroups.values()];
  const chars: Ch[] = charComps.map((group) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let gapL = Infinity;
    let gapR = -Infinity;
    let hasSolid = false;
    for (const gi of group) {
      const c = final[gi];
      if (c.x0 < x0) x0 = c.x0;
      if (c.y0 < y0) y0 = c.y0;
      if (c.x1 > x1) x1 = c.x1;
      if (c.y1 > y1) y1 = c.y1;
      if (!solid[gi].thin) {
        hasSolid = true; // the letter body defines the gap span; thin tails/dots don't
        if (solid[gi].cx0 < gapL) gapL = solid[gi].cx0;
        if (solid[gi].cx1 > gapR) gapR = solid[gi].cx1;
      }
    }
    if (!hasSolid) {
      gapL = x0; // all-thin char (a lone dot / period, or a bar)
      gapR = x1;
    }
    // Only a wide underline/strikethrough is excluded from the gaps; a lone dot/period is
    // a normal char (thin → full-box gap-span) so it counts in the split like anything else.
    const wideThin = !hasSolid && group.length === 1 && solid[group[0]].bar;
    return { x0, y0, x1, y1, gapL, gapR, skip: wideThin, line: solid[group[0]].line };
  });

  // Per-CHARACTER cleaning + Otsu + darkness normalization (see the block comment above
  // `CHAR_PAD`). Two passes: measure every character's own ink/paper split, then re-render
  // them all at one page-wide ink level.
  if (cleanOut) {
    cleanOut.fill(255);
    // A character's own pixels — the blobs that merged into it. Restricting the render to
    // these is the CLEANING: a neighbour's stroke clipping the box, a speck the dot rule
    // rejected, or leftover rule/bleed-through ink is simply never drawn.
    // WHICH CHARACTER OWNS THIS PIXEL, as a flat lookup: the two render loops
    // below ask it once per pixel of every character's padded box, and this is
    // the second-largest stage of the clean. A component's `root` is its own
    // raster-first PIXEL INDEX and no two components share one, so root ->
    // character is a plain array indexed by that pixel — the per-character
    // `Set` of roots this replaced answered the same question with a hash probe.
    const rootChar = new Int32Array(W * H).fill(-1);
    for (let ci = 0; ci < charComps.length; ci++) {
      for (const gi of charComps[ci]) rootChar[final[gi].root] = ci;
    }
    const charAt = (i: number): number => { const l = label[i]; return l >= 0 ? rootChar[l] : -1; };
    // A character built from painted ink must REACH the page — getting it past
    // the acceptance gate accomplishes nothing if the render then declines to
    // draw it. Both of the render's bail-outs are contrast tests, and painted
    // ink is painted precisely because it is low-contrast, so they fire on
    // exactly the population the brush exists to rescue.
    const paintedChar = charComps.map((g) => g.some((gi) => final[gi].painted));
    const box = chars.map((ch) => ({
      px0: Math.max(0, ch.x0 - CHAR_PAD),
      py0: Math.max(0, ch.y0 - CHAR_PAD),
      px1: Math.min(W - 1, ch.x1 + CHAR_PAD),
      py1: Math.min(H - 1, ch.y1 + CHAR_PAD),
    }));

    // Every blob some character DID claim is exactly `charAt(i) >= 0` — the
    // complement is droppable specks and filtered fragments, which the
    // faint-bridge adoption below may pick back up when they hug a character's
    // own ink.

    // Pass 1 — each character's LOCAL split. The histogram is taken over the padded box
    // (real paper conditions it), and the cut is FLOORED so it can never discard ink the
    // segmentation already accepted as part of this character.
    const levels = chars.map((_, ci) => {
      const b = box[ci];
      const hist = new Int32Array(256);
      let n = 0;
      const inkVals: number[] = [];
      for (let y = b.py0; y <= b.py1; y++) {
        const row = y * W;
        for (let x = b.px0; x <= b.px1; x++) {
          const i = row + x;
          hist[gray[i]]++;
          n++;
          // The character's OWN ink — its blobs' pixels that the page-level gate already
          // called ink. A neighbour bleeding into the padded box is not in this set.
          if (ink[i] && charAt(i) === ci) inkVals.push(gray[i]);
        }
      }
      if (inkVals.length < 3) return null;
      inkVals.sort((a, c) => a - c);
      const pct = (q: number) => inkVals[Math.min(inkVals.length - 1, Math.floor(q * (inkVals.length - 1)))];
      const core = pct(0.5); // the character's darkness — what gets normalized page-wide
      const solidTo = pct(0.9); // all but the lightest tenth is real stroke, not rim
      // Painted ink answers to its OWN pixels, not to a page-wide contrast bar:
      // draw everything the segmenter accepted for this character and ramp the
      // rim out just past it. Nothing else on the page moves — this level is
      // used only to render this one character's box.
      const painted = paintedChar[ci];
      // The cut sits just past the LIGHTEST pixel the gate accepted, not at
      // `solidTo + 2`: the accepted set here is already bounded by the paint
      // stroke's own darkness bar, so "everything accepted, rim ramping out
      // over the lightest tenth" is the render the brush promised.
      const paintedLevel = () => ({ t: inkVals[inkVals.length - 1] + 1, core, solidTo });

      // Otsu SEPARATES the block's two classes; the cut we take is the midpoint of their
      // MEANS. Otsu's own index is fragile at both ends: on a clean scan the histogram has
      // a flat run between the clusters, its between-class variance ties across the whole
      // run and the first index wins — landing the threshold ON the ink level, with nothing
      // below it.
      const t0 = otsuOf(hist, n);
      let sLo = 0;
      let nLo = 0;
      let sHi = 0;
      let nHi = 0;
      for (let v = 0; v < 256; v++) {
        const c = hist[v];
        if (!c) continue;
        if (v <= t0) {
          sLo += v * c;
          nLo += c;
        } else {
          sHi += v * c;
          nHi += c;
        }
      }
      if (!nLo || !nHi) return painted ? paintedLevel() : null;
      const paper = sHi / nHi;
      if (paper - core < CHAR_MIN_CONTRAST) {
        if (painted) return paintedLevel();
        return null; // no real ink/paper split here
      }
      // ...and when a block's own strokes vary a lot (pressure changing mid-character),
      // Otsu can put the split INSIDE the ink and erase the lighter half. So the cut is
      // floored above `solidTo` — every stroke the segmenter accepted survives — while
      // still being held clear of the local paper level.
      const t = Math.min(paper - CHAR_MIN_CONTRAST / 2, Math.max((sLo / nLo + paper) / 2, solidTo + 2));
      if (t <= core) return painted ? paintedLevel() : null;
      // A softer ADOPTION cut for the faint-bridge pixels (t + 35, capped at
      // local paper) was tried and measured: it admits ~2766 more pixels on
      // photorain and costs doubledia one word while restoring nothing the
      // scorer can see — the chewed-bowl instances it was built for still
      // fail some deeper condition. Adoptees therefore answer to the same `t`
      // as the character's own ink.
      return { t, core, solidTo: Math.min(solidTo, t - 1) };
    });

    // The page's normalized ink darkness: the MEDIAN character's ink level. Using the
    // median (not 0, and not each character's own level) keeps the writing's natural weight
    // while pulling every character onto the same one.
    const inks = levels.filter((l) => l !== null).map((l) => l!.core).sort((a, b) => a - b);
    const target = inks.length
      ? Math.max(INK_TARGET_MIN, Math.min(INK_TARGET_MAX, Math.round(inks[inks.length >> 1])))
      : 0;

    // Pass 2 — render. The character's real strokes (down to `solidTo`) go to FULL coverage
    // and only the rim between there and the cut ramps out, so nothing solid is left
    // half-inked for a later threshold to lose. Full coverage maps onto the page-wide ink
    // target, so a character written faint and one written heavy come out the same weight.
    // Overlapping padded boxes take the darker value, so there are no seams.
    for (let ci = 0; ci < chars.length; ci++) {
      const lv = levels[ci];
      if (!lv) continue;
      const b = box[ci];
      const span = Math.max(1, lv.t - lv.solidTo);
      for (let y = b.py0; y <= b.py1; y++) {
        const row = y * W;
        for (let x = b.px0; x <= b.px1; x++) {
          const i = row + x;
          const v = gray[i];
          const own = charAt(i) === ci;
          if (v >= lv.t) continue; // paper
          if (!own) {
            // FAINT BRIDGES. A light-pencil stroke can dip under the PAGE-level
            // ink gate mid-run (no label at all), or its faint arc can survive
            // the gate only to be DROPPED as a speck by the strength filters —
            // measured on photorain's "neighbor", whose b-bowl arc sits at
            // 160-215 grey against paper 255 and came back with a bite. Either
            // way the render, which draws only the character's own blobs, loses
            // stroke. A pixel darker than the character's own local cut is
            // adopted when it touches (within 2px) the character's own ink;
            // ink OWNED BY ANOTHER CHARACTER is never adopted, so a neighbour
            // clipping the box still cannot bleed in.
            if (ink[i] && charAt(i) >= 0) continue;
            let near = false;
            for (let dy = -2; dy <= 2 && !near; dy++) {
              const yy = y + dy;
              if (yy < b.py0 || yy > b.py1) continue;
              for (let dx = -2; dx <= 2; dx++) {
                const xx = x + dx;
                if (xx < b.px0 || xx > b.px1) continue;
                const q = yy * W + xx;
                if (ink[q] && charAt(q) === ci) { near = true; break; }
              }
            }
            if (!near) continue;
          }
          const a = v <= lv.solidTo ? 1 : Math.min(1, (lv.t - v) / span);
          const val = Math.round(255 - a * (255 - target));
          if (val < cleanOut[i]) cleanOut[i] = val;
        }
      }
    }
  }

  // Per-pixel line ownership, for callers that crop whole-line bands (the line/code
  // trainers): every kept blob paints its line index + 1 over its own pixels. Ink pixels
  // are painted first and are definitive; the dilation halo only fills where nothing else
  // claimed it — so trimming a neighbour line's descender out of a crop takes its
  // anti-aliased fringe with it but can never erase real ink belonging to this line.
  if (lineMaskOut) {
    lineMaskOut.fill(0);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < final.length; i++) {
        if (maskFree[i]) continue; // unresolved mark: unclaimed, kept in every crop
        const c = final[i];
        const v = solid[i].line + 1;
        const px0 = Math.max(0, c.x0 - bridgePx);
        const px1 = Math.min(W - 1, c.x1 + bridgePx);
        const py0 = Math.max(0, c.y0 - bridgePx);
        const py1 = Math.min(H - 1, c.y1 + bridgePx);
        for (let y = py0; y <= py1; y++) {
          const row = y * W;
          for (let x = px0; x <= px1; x++) {
            const p = row + x;
            if (label[p] !== c.root) continue;
            if (pass === 0) {
              if (ink[p]) lineMaskOut[p] = v;
            } else if (!lineMaskOut[p]) lineMaskOut[p] = v;
          }
        }
      }
    }
  }

  // Gaps between consecutive CHARACTERS within each line (their body core-spans). Only
  // wide bars are left out; each merged char (letter + its dot) contributes ONE span.
  const byLine = new Map<number, number[]>();
  chars.forEach((c, i) => {
    if (c.skip) return;
    const arr = byLine.get(c.line) ?? [];
    arr.push(i);
    byLine.set(c.line, arr);
  });
  for (const arr of byLine.values()) arr.sort((a, b) => chars[a].gapL - chars[b].gapL);

  const gaps: number[] = [];
  for (const arr of byLine.values()) {
    for (let k = 1; k < arr.length; k++) {
      const g = chars[arr[k]].gapL - chars[arr[k - 1]].gapR - 1;
      if (g > 0) gaps.push(g);
    }
  }
  // Auto split: cluster the gaps into within-word vs between-word (2-means). Trust it
  // only with enough gaps AND a clean separation, and keep the chosen threshold in a
  // sane band around the line height — a noisy distribution can otherwise land a
  // threshold that either shatters one word or collapses several into one.
  const { thr, sep } = twoMeans(gaps);
  const autoAccepted = gaps.length >= 3 && sep >= o.gapSeparation && Number.isFinite(thr);
  // The clustered split (or a line-height fallback), scaled by autoScale so the auto
  // split can be made more/less aggressive without leaving auto mode. The lower clamp is
  // small (0.05·lineHeight) so a low autoScale can genuinely push toward more words — a
  // higher floor was silently capping how aggressive the slider could get.
  const rawAuto = autoAccepted ? thr : lineHeight * 0.55;
  const autoThr = Math.min(lineHeight * 0.9, Math.max(lineHeight * 0.05, rawAuto * o.autoScale));
  // Manual override wins; else the (scaled) auto split.
  const gapThreshold = o.wordGap > 0 ? o.wordGap : autoThr;
  // A between-word gap this close (fraction) above the threshold is AMBIGUOUS: the split
  // is only barely a split, so the two words might really be one. We split (the "real"
  // choice) but flag the left word `mergeNext` so the OCR step can try the merged
  // grouping (the "potential" combination) and fuse them if that reads better. With
  // autoScale defaulting < 1 (split aggressively), this is where the OCR earns its keep.
  const AMBIG_FRAC = 0.25;
  const ambigHi = Number.isFinite(gapThreshold) ? gapThreshold * (1 + AMBIG_FRAC) : Infinity;

  // Build word boxes per line. Each word tracks its CORE span (solid strokes, thin
  // horizontals excluded) as well as its full ink box, and whether the gap to the next
  // word on the line is near-threshold (`mergeNext`, an OCR merge candidate).
  interface W2 {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    line: number;
    coreL: number;
    coreR: number;
    mergeNext: boolean;
    /** How many CHARACTER boxes the word is built from — the orphaned-descender
     *  rule below asks it whether this "word" is writing or one stray stroke. */
    chars: number;
  }
  let words: W2[] = [];
  for (const [line, arr] of byLine.entries()) {
    if (!arr.length) continue;
    let cur: number[] = [arr[0]];
    // `gapAfter` = the gap that ended this word (-1 for the line's last word). The word
    // is a merge candidate when that gap sits in [threshold, threshold·(1+AMBIG_FRAC)].
    const flush = (gapAfter: number) => {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let coreL = Infinity;
      let coreR = -Infinity;
      for (const ci of cur) {
        const ch = chars[ci];
        x0 = Math.min(x0, ch.x0);
        y0 = Math.min(y0, ch.y0);
        x1 = Math.max(x1, ch.x1);
        y1 = Math.max(y1, ch.y1);
        coreL = Math.min(coreL, ch.gapL);
        coreR = Math.max(coreR, ch.gapR);
      }
      const mergeNext = gapAfter >= 0 && gapAfter <= ambigHi;
      words.push({ x0, y0, x1, y1, line, coreL, coreR, mergeNext, chars: cur.length });
    };
    for (let k = 1; k < arr.length; k++) {
      const g = chars[arr[k]].gapL - chars[arr[k - 1]].gapR - 1;
      if (g >= gapThreshold) {
        flush(g);
        cur = [arr[k]];
      } else cur.push(arr[k]);
    }
    flush(-1);
  }

  // Edge junk removal.
  //
  // A page photographed on a desk collects marks that are not writing: the
  // shadow along a binding, tape or a torn edge, bleed-through from the sheet
  // behind, a scribble in the margin. They land near a border, and what gives
  // them away is that they are DETACHED — the writing on a line sits at word
  // spacing, while junk sits alone with a large empty gap between it and the
  // rest of its line.
  //
  // So the test is comparative rather than positional: how far is this box from
  // its nearest neighbour on the same line, against how close it is to an edge.
  // A box that is near an edge, separated by more than double the word gap, AND
  // small beside its line-mates is junk. A box near an edge that sits at normal
  // word spacing is the first or last word of the line and is kept, which is why
  // proximity alone would be the wrong rule — and a word-sized box is kept
  // however far along the line it sits, which is why distance alone is wrong
  // too.
  //
  // This used to consider the right edge only, and only trailing words. It now
  // considers all four, because a photo can pick up an artefact at any border.
  // A box TOUCHING the border, this close in px. Real writing can sit near an
  // edge — the first and last text lines do — but its box does not usually run
  // right into it, whereas a speck along the border does. Small and absolute
  // rather than a fraction of the page, because it is describing contact.
  const edgeTouch = Math.max(2, 0.06 * lineHeight);
  // Further apart than the page's own word-splitting distance, DOUBLED.
  //
  // Testing against gapThreshold itself is circular: it is the distance that
  // separates two words, so every word sits further than it from its neighbour
  // by construction, and the test condemns the last word of any line that
  // happens to reach the border. Measured on the test photo, the trailing
  // "will" sat 50px from "I" against a 35px threshold and was being dropped
  // while the writing either side of it was kept. Real junk is much further
  // out — 271px on the regression page — so doubling separates the two with
  // room to spare.
  const detachedGap = Math.max(1, gapThreshold * 2);
  // Smaller than this fraction of its line-mates, in EITHER dimension, is not
  // writing. A speck against the border is a sliver next to real words; the
  // regression page's junk is 7px wide beside 60-90px words.
  const SMALL_FRAC = 0.35;
  // a line whose total box ink is under this fraction of the median line's is
  // a junk cluster, not writing (see the mark-line veto below)
  const JUNK_LINE_FRAC = 0.12;
  {
    const perLine = new Map<number, W2[]>();
    for (const w of words) {
      const a = perLine.get(w.line) ?? [];
      a.push(w);
      perLine.set(w.line, a);
    }
    const gapX = (a: W2, b: W2) => b.x0 >= a.x1 ? b.x0 - a.x1 : a.x0 >= b.x1 ? a.x0 - b.x1 : 0;
    const gapY = (a: W2, b: W2) => b.y0 >= a.y1 ? b.y0 - a.y1 : a.y0 >= b.y1 ? a.y0 - b.y1 : 0;
    const vOverlap = (a: W2, b: W2) => Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

    const drop = new Set<W2>();
    for (const ws of perLine.values()) {
      for (const w of ws) {
        // NB one px more generous than the component-level sliver veto above,
        // which measures `W - 1 - c.x1` / `H - 1 - c.y1`. Left as measured:
        // `edgeTouch` is >= 2 px, so a box flush against the border clears
        // either form, and the corpus numbers quoted below were fitted on this.
        const toEdge = Math.min(w.x0, W - w.x1, w.y0, H - w.y1);
        if (toEdge > edgeTouch) continue;          // not against a border
        // A SLIVER CUT OFF BY THE FRAME is junk on its own evidence, before any
        // question about neighbours. Writing stops short of the paper's edge —
        // there is always some margin — so ink that runs INTO the border and is
        // several times taller than it is wide is the shadow along a binding, a
        // torn rim, or the next sheet showing past the edge of this one. It is
        // not a letter, however close to the text it happens to sit.
        //
        // This is separate from the detachment test below because detachment
        // does not describe it. Measured on page C of `training/pages/`, two
        // such slivers (10x98 and 12x132, both flush at x = W-1) sat only 72 px
        // from the previous line's last word — closer than a line is tall — so
        // the alone-on-its-line branch kept them, each became its own text line,
        // and each read as a phantom "I". They are page C's only two errors.
        //
        // Over the whole corpus, 217 word records: 3 touch a border, 3 are 3x
        // taller than wide, and exactly 2 are both — these two. The ratio alone
        // would be far too aggressive (a real "I" or "l" is a sliver by shape);
        // border CONTACT is what carries the argument, which is why edgeTouch
        // stays small. Note this necessarily also applies at the LEFT border,
        // where text legitimately sits close: contact is measured against the
        // page edge, not the margin rule, and writing that starts near the rule
        // is still tens of px clear of the paper's edge.
        if ((w.y1 - w.y0 + 1) >= 3 * (w.x1 - w.x0 + 1)) { drop.add(w); continue; }
        const mates = ws.filter((o) => o !== w && !drop.has(o));
        if (!mates.length) {
          // Alone on its line, so there is no line-mate to be detached from —
          // which is exactly what an artefact in a page corner looks like, since
          // it lands in no text line at all. Judge it against the whole page
          // instead: if the nearest box in ANY direction is further than a line
          // is tall, it is not part of the writing. A genuine short last line
          // still sits directly under the line above, so its vertical gap is
          // small and it survives.
          let near = Infinity;
          for (const o of words) {
            if (o === w || drop.has(o)) continue;
            near = Math.min(near, Math.max(gapX(w, o), gapY(w, o)));
          }
          if (near > lineHeight) drop.add(w);
          continue;
        }
        // Distance to its line, and whether it shares the line's band at all.
        let nearest = Infinity;
        let overlap = 0;
        for (const o of mates) {
          nearest = Math.min(nearest, gapX(w, o));
          overlap = Math.max(overlap, vOverlap(w, o));
        }
        // Outside the line's vertical band entirely — a sliver that was
        // assigned to the last line but does not sit on it.
        if (overlap === 0) { drop.add(w); continue; }
        // Otherwise junk has to look wrong TWO independent ways: stranded far
        // along the line, AND too small to be writing. Either signal alone
        // misfires — distance alone drops a real trailing word whenever the
        // writer left a wide space before it, and size alone drops a genuinely
        // narrow word like "I" or "a". What is actually being described is a
        // speck marooned against the border, which is both.
        const medW = medianOf(mates.map((o) => o.x1 - o.x0));
        const medH = medianOf(mates.map((o) => o.y1 - o.y0));
        const small = (w.x1 - w.x0) < SMALL_FRAC * medW
          || (w.y1 - w.y0) < SMALL_FRAC * medH;
        if (nearest > detachedGap && small) drop.add(w);
      }
    }
    if (drop.size) words = words.filter((w) => !drop.has(w));
  }
  // A LINE THAT IS ONLY MARKS IS NOT A TEXT LINE. On a page whose rules run
  // past the writing (the faint-rules rescue extends them to the page edge on
  // purpose), specks and residue clusters in the UNWRITTEN region collect on
  // a baseline and become a phantom line of tiny "words" that decode as
  // hallucinations (weirdpage: two junk recs at 47 and 128 ink px, 250 px
  // below the last written line, reading as extra words). A real text line
  // carries an order of magnitude more ink than a junk cluster, and even a
  // genuinely short closing line ("it changes.") is well over the bar —
  // measured: weirdpage's lightest real line holds ~2500 ink px against the
  // junk line's 175, with the page median around 3200.
  {
    const byLine = new Map<number, W2[]>();
    for (const w of words) {
      const a = byLine.get(w.line) ?? [];
      a.push(w);
      byLine.set(w.line, a);
    }
    const inkOf = (w: W2): number => {
      let n = 0;
      const yA = Math.max(0, Math.round(w.y0));
      const yB = Math.min(H - 1, Math.round(w.y1));
      const xA = Math.max(0, Math.round(w.x0));
      const xB = Math.min(W - 1, Math.round(w.x1));
      for (let y = yA; y <= yB; y++) for (let x = xA; x <= xB; x++) if (ink[y * W + x]) n++;
      return n;
    };
    const lineInk = new Map<number, number>();
    for (const [line, ws] of byLine) lineInk.set(line, ws.reduce((n, w) => n + inkOf(w), 0));
    const medLine = medianOf([...lineInk.values()]);
    if (medLine > 0 && byLine.size >= 3) {
      const drop = new Set<W2>();
      for (const [line, ws] of byLine) {
        if ((lineInk.get(line) ?? 0) < medLine * JUNK_LINE_FRAC) for (const w of ws) drop.add(w);
      }
      if (drop.size) words = words.filter((w) => !drop.has(w));
    }
  }
  // Orphaned descenders. The cross-line separator cuts a blob whose ink sits in
  // two lines' bands, and the LOWER piece lands on the lower line — correct for
  // a descender resting on real writing, but when the lower line has no other
  // words, the "word" is just the tail of a flourish (measured: the sweeping t
  // of "the" produced a 20x94 phantom on an otherwise empty line, which then
  // read as an empty line downstream). A lone word that x-overlaps a word on
  // the line ABOVE and starts at/inside that word's vertical extent is the
  // upper word's own ink, not a line of text — drop it. Its pixels stay on the
  // page; only the phantom WORD (and with it the phantom line) goes.
  {
    const byLine = new Map<number, W2[]>();
    for (const w of words) {
      const a = byLine.get(w.line) ?? [];
      a.push(w);
      byLine.set(w.line, a);
    }
    const drop = new Set<W2>();
    for (const [line, ws] of byLine) {
      if (ws.length !== 1) continue;
      const w = ws[0];
      // …and it must be ONE STROKE. Containment alone said "a real one-word
      // line never sits inside a single word's span above", and that is simply
      // false for an indented list: `- Apples` written under `- Millirec` is
      // narrower than its parent and sits squarely inside it, and the whole
      // nested line was deleted (measured on a photographed index card — the
      // line, its dash and its reading all vanished, and the item above
      // swallowed its ink). A flourish's tail is one component; writing is
      // several, so the character count separates them where the geometry
      // cannot.
      if (w.chars > 1) continue;
      const above = byLine.get(line - 1) ?? [];
      for (const u of above) {
        // Contained (with slack) within ONE word's span above, with any actual
        // overlap. A fractional-overlap test missed the measured case by 1.2 px:
        // the orphan was a sliver at the EDGE of the word it fell from, so most
        // of its width hung outside.
        const ov = Math.min(u.x1, w.x1) - Math.max(u.x0, w.x0);
        if (ov <= 0) continue;
        if (w.x0 < u.x0 - 8 || w.x1 > u.x1 + 8) continue;
        // The seam cut threads the white gap under the upper line's ink, so the
        // orphaned piece can start several px below the upper word's box. A real
        // one-word line (a signature, say) sits a full line-height down; a third
        // of one is comfortably between the two.
        if (w.y0 <= u.y1 + lineHeight * 0.35) { drop.add(w); break; }
      }
    }
    if (drop.size) words = words.filter((w) => !drop.has(w));
  }
  // Clip adjacent word boxes so they NEVER overlap in x. A wide letter or a tail at a
  // word's edge otherwise reaches into the neighbour, so that letter appears in BOTH
  // crops (double-counted) and the box runs into the space. Cut the overlap at the
  // midpoint of the empty CORE gap between the two words (guaranteed ink-free there,
  // since the split happened on a core gap ≥ threshold).
  const wordsByLine = new Map<number, W2[]>();
  for (const w of words) {
    const a = wordsByLine.get(w.line) ?? [];
    a.push(w);
    wordsByLine.set(w.line, a);
  }
  for (const ws of wordsByLine.values()) {
    ws.sort((a, b) => a.coreL - b.coreL);
    for (let k = 1; k < ws.length; k++) {
      const A = ws[k - 1];
      const B = ws[k];
      if (A.x1 >= B.x0) {
        const mid = Math.round((A.coreR + B.coreL) / 2);
        A.x1 = Math.min(A.x1, mid);
        B.x0 = Math.max(B.x0, mid + 1);
      }
    }
  }

  if (debugOut) {
    debugOut.chars = chars.map((c) => ({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, skip: c.skip }));
    debugOut.words = words.map((w) => ({
      x: w.x0, y: w.y0, w: w.x1 - w.x0 + 1, h: w.y1 - w.y0 + 1, line: w.line, mergeNext: w.mergeNext,
    }));
    debugOut.lineHeight = lineHeight;
    debugOut.gapThreshold = gapThreshold;
    debugOut.crossSplits = cross.splits;
    debugOut.markLineMoves = markMoves;
  }

  // Group into BoxesJson lines (one entry per rule line that has words), top→bottom,
  // words left→right within each line. Clear `mergeNext` on each line's LAST word — its
  // right neighbour is gone (or was dropped by the right-edge filter), so there's nothing
  // to merge it with.
  const lineOrder = [...new Set(words.map((w) => w.line))].sort((a, b) => a - b);
  // The BoxesJson index -> segmenter-line-id bridge for lineMask consumers.
  if (out && lineMaskOut) out.lineIds = lineOrder;
  const lines = lineOrder.map((ln) => {
    const ws = words
      .filter((w) => w.line === ln)
      .sort((a, b) => a.x0 - b.x0)
      .map<WordBox>((w, i, all) => ({
        x: w.x0, y: w.y0, w: w.x1 - w.x0 + 1, h: w.y1 - w.y0 + 1,
        ...(w.mergeNext && i < all.length - 1 ? { mergeNext: true } : {}),
      }));
    return { words: ws };
  });

  // Tuning aid: the gap distribution + chosen threshold, so wordGap can be picked by
  // eye. One concise line per import.
  if (cleanDebugOn()) {
    const g = [...gaps].sort((a, b) => a - b);
    const pct = (q: number) => (g.length ? g[Math.min(g.length - 1, Math.floor(q * (g.length - 1)))] : 0);
    const nWords = lines.reduce((s, l) => s + l.words.length, 0);
    // eslint-disable-next-line no-console
    console.log(
      `[hw v2 seg] chars=${chars.length} words=${nWords} lineH=${lineHeight.toFixed(0)} ` +
        `xline-split=${cross.splits} mark-moves=${markMoves} mark-free=${maskFree.filter(Boolean).length} | ` +
        `gaps n=${g.length} min=${pct(0)} p25=${pct(0.25)} med=${pct(0.5)} p75=${pct(0.75)} max=${pct(1)} | ` +
        `auto sep=${sep.toFixed(2)} thr=${autoAccepted ? autoThr.toFixed(0) : 'rejected'} | ` +
        `USED=${Number.isFinite(gapThreshold) ? gapThreshold.toFixed(0) + 'px' : '∞'} (wordGap=${o.wordGap}, gapSep=${o.gapSeparation})`,
    );
  }
  return { width: W, height: H, lines };
}
