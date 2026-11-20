// What KIND of paper this is — and how that changes the cleanup.
//
// Every stage of Pass A used to assume one answer: ruled paper with a single
// vertical margin rule on the left. That assumption is baked into the defaults
// (`ruleAutoGap` on, `vruleEnable` on, `detectMarginLine` scanning the left 35%)
// and it is invisible, so on paper that is NOT that the failures are silent
// rather than loud:
//
//   - PLAIN unruled paper has NO BASELINES, and `ccWordBoxes` drives its whole
//     line structure off them: `assignLine` returns 0 for every component when
//     the rule list is empty, so the page comes back as ONE word box. Measured
//     on the synthetic unruled sample: 1 box for sixteen lines of writing,
//     21 boxes over 12 lines once `inkBaselines` supplies them.
//     (The rule stage is also turned OFF for unruled paper, on the argument that
//     a peak finder over horizontal line-energy will eventually find peaks in
//     dense writing and erase bands through it. That one is a PRECAUTION and is
//     not measured — the synthetic's writing is too sparse to fool the tracer,
//     which finds zero rules on it either way.)
//   - GRID paper has a vertical line every few millimetres. Pass A traces
//     exactly ONE vertical rule (`seams.c`: `g.n_vrules = 1`), keeps the
//     strongest, and `detectMarginLine` then calls whichever line that was the
//     margin — so one arbitrary grid line is removed, the other twenty stay,
//     and everything left of the "margin" is excluded from segmentation.
//   - DOT grid is invisible to the rule tracer entirely (a dot has no run
//     length), so the dots survive as ink: `speckleMin` 6 does not reach them,
//     and the segmenter groups them into words.
//
// A template makes the assumption explicit and selectable, and `classifyTemplate`
// picks one from the page's own evidence when the caller does not.
//
// TWO THINGS ARE DELIBERATELY NOT PARAMETERS HERE. Rule SPACING is measured per
// page by Pass A (`ruleAutoGap`), and it is measured better than a template
// could declare it — "college ruled" is 7.1 mm on paper and some unknown number
// of pixels in a photograph. And page SIZE is not modelled at all: nothing
// downstream works in millimetres.

import * as passA from './passA/params';
import type { RulesJson, VRuleTrace } from './types';

export type PageTemplateId =
  | 'ruled-margin'
  | 'ruled-margin-double'
  | 'ruled-margin-right'
  | 'ruled'
  | 'plain'
  | 'grid'
  | 'dots';

export interface PageTemplate {
  id: PageTemplateId;
  name: string;
  /** One line, for a picker. */
  description: string;
  /** Printed horizontal rules the pipeline should trace and erase. */
  ruled: boolean;
  /** A regular lattice of vertical lines across the whole page (graph paper). */
  gridV: boolean;
  /** A lattice of printed dots instead of printed lines. */
  dotted: boolean;
  /** Which side carries a margin rule, if any. */
  margin: 'none' | 'left' | 'right';
  /** Two parallel rules rather than one (the common UK exercise book). */
  marginDouble: boolean;
  /** Pass A parameter overrides, keyed by `passA.PARAMS[].key`. */
  params: Record<string, number>;
}

/**
 * The built-in templates.
 *
 * `ruled-margin` reproduces the pipeline's historical defaults EXACTLY (its
 * `params` is empty), so selecting it — or auto-detecting it, which is what the
 * five-page photo corpus does — cannot move a single pixel of the shipped
 * behaviour. Every other template is a departure and says what it changes.
 */
export const PAGE_TEMPLATES: readonly PageTemplate[] = [
  {
    id: 'ruled-margin',
    name: 'Ruled, left margin',
    description: 'Horizontal rules with one vertical margin rule on the left. The default.',
    ruled: true, gridV: false, dotted: false, margin: 'left', marginDouble: false,
    params: {},
  },
  {
    id: 'ruled-margin-double',
    name: 'Ruled, double left margin',
    description: 'As above but the margin is two parallel rules a few px apart.',
    ruled: true, gridV: false, dotted: false, margin: 'left', marginDouble: true,
    // NO PARAMETER OVERRIDES, AND THAT IS A MEASUREMENT.
    //
    // The obvious one is `lineMaxThick` (default 8), on the reasoning that the
    // removal band has to span both lines and the gap between them. It does not
    // need raising: `probe_thickness_double` searches out to `3 * max_t + 4`
    // for a partner run, so at the default cap it already reaches 28px. On the
    // three double-margin pages of `training/pages/` it measures 17, 17 and 18
    // px against the three single-margin pages' 10, 11 and 11 — the pair is
    // already fully spanned.
    //
    // So this template is a DESCRIPTION, not a configuration. It exists because
    // "is the margin one rule or two" is a real thing a caller may want to state
    // or be told, and because a template that changed nothing would otherwise
    // have to be inferred from an evidence field nobody reads. Auto-selecting it
    // therefore costs no second Pass A.
    params: {},
  },
  {
    id: 'ruled-margin-right',
    name: 'Ruled, right margin',
    description: 'Horizontal rules with one vertical margin rule on the RIGHT — the mirror of the default.',
    ruled: true, gridV: false, dotted: false, margin: 'right', marginDouble: false,
    // The mirror of `ruled-margin`, and like it overrides nothing: Pass A's
    // vertical tracer finds the strongest line whichever side it is on and
    // erases it. What the template adds is the SIDE — the margin strip to
    // exclude from segmentation is to the line's right here, not its left,
    // and the classifier used to file these pages as `ruled` with the strip
    // left in (a note in `classifyTemplate` said so rather than mis-handling
    // it). Gated on the synthetic mirror page in verify-templates.
    params: {},
  },
  {
    id: 'ruled',
    name: 'Ruled, no margin',
    description: 'Horizontal rules only. Nothing is treated as a margin.',
    ruled: true, gridV: false, dotted: false, margin: 'none', marginDouble: false,
    // vruleEnable off: with no margin to find, the vertical tracer's best
    // candidate is whatever long dark thing exists — a page-edge shadow, or the
    // left stems of a well-aligned first column of letters.
    params: { vruleEnable: 0 },
  },
  {
    id: 'plain',
    name: 'Plain (unruled)',
    description: 'No printed lines at all. Rule tracing is off; baselines come from the ink.',
    ruled: false, gridV: false, dotted: false, margin: 'none', marginDouble: false,
    // ruleThresh at its ceiling is how the rule stage is disabled without a new
    // parameter: nothing clears a threshold of 0.99 relative to the strongest
    // rule except the strongest rule, and rules are only ever accepted as
    // members of a PARALLEL PAIR (see the note at the end of `stage_rules`), so
    // a single survivor is dropped. `ruleMax` 1 caps it belt-and-braces.
    params: { ruleThresh: 0.99, ruleMax: 1, vruleEnable: 0 },
  },
  {
    id: 'grid',
    name: 'Grid / graph paper',
    description: 'Horizontal AND vertical rules across the whole page.',
    ruled: true, gridV: true, dotted: false, margin: 'none', marginDouble: false,
    // The single-vrule tracer is worse than useless here (it removes one line of
    // twenty and tells the margin detector that line is the margin), so it is
    // off and the whole lattice is found in JS by `detectVLattice`, which writes
    // every line into `rules.vrules` for the ordinary removal to erase.
    params: { vruleEnable: 0 },
  },
  {
    id: 'dots',
    name: 'Dot grid',
    description: 'A printed lattice of dots. No lines to trace; the dots are erased as a lattice.',
    ruled: false, gridV: false, dotted: true, margin: 'none', marginDouble: false,
    // Same rule-stage shutdown as `plain` — a dot lattice has no runs for the
    // tracer to find, so anything it "finds" came from the writing.
    params: { ruleThresh: 0.99, ruleMax: 1, vruleEnable: 0 },
  },
] as const;

export function templateById(id: PageTemplateId | string): PageTemplate | null {
  return PAGE_TEMPLATES.find((t) => t.id === id) ?? null;
}

const KEY_INDEX = new Map(passA.PARAMS.map((p, i) => [p.key, i]));

/** Pass A parameters for a template: the shared defaults with its overrides applied. */
export function templateParams(t: PageTemplate, base?: Float32Array): Float32Array {
  const q = base ? Float32Array.from(base) : passA.defaultParams();
  for (const [key, v] of Object.entries(t.params)) {
    const i = KEY_INDEX.get(key);
    // A typo in a template's params would otherwise write nothing and look like
    // the template simply having no effect, which is the hardest kind of bug to
    // see in an image pipeline.
    if (i == null) throw new Error(`template ${t.id}: unknown Pass A param "${key}"`);
    q[i] = v;
  }
  return q;
}

// ---------------------------------------------------------------------------
// Lattice detection — the evidence for `grid` and `dots`, and the input to
// their removal. Both run on the flattened page (Pass A stage 4), where paper
// is near-uniform, so a printed line or dot is a local darkening rather than an
// absolute grey level.
// ---------------------------------------------------------------------------

/** Paper level: the 85th percentile of a sparse sample, the same estimator the
 *  rest of the pipeline uses. Sparse because a full histogram of a 1500px page
 *  is 2M reads for a number that moves by less than a grey level. */
function paperLevel(gray: Uint8Array, stride = 997): number {
  const samp: number[] = [];
  for (let i = 0; i < gray.length; i += stride) samp.push(gray[i]);
  if (!samp.length) return 235;
  samp.sort((a, b) => a - b);
  return samp[Math.floor(samp.length * 0.85)] || 235;
}

/** Running median over a 1-D profile, window = 2r+1. Used to subtract the
 *  writing's own envelope so a lattice line is measured against ITS OWN
 *  neighbourhood rather than against the page. */
/** Median over a sliding window. Only the middle POSITION is wanted, so the
 *  window is quickselected in a reused typed buffer rather than fully sorted
 *  with a comparator — same value (`sorted[len >> 1]`), no per-pixel array
 *  allocation. */
function runningMedian(v: Float64Array, r: number): Float64Array {
  const n = v.length;
  const out = new Float64Array(n);
  const win = new Float64Array(2 * r + 1);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - r);
    const b = Math.min(n - 1, i + r);
    const len = b - a + 1;
    for (let k = 0; k < len; k++) win[k] = v[a + k];
    const kth = len >> 1;
    let lo = 0, hi = len - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      const x = win[lo], y = win[m], z = win[hi];
      const p = x < y ? (y < z ? y : (x < z ? z : x)) : (x < z ? x : (y < z ? z : y));
      let s = lo, t = hi;
      while (s <= t) {
        while (win[s] < p) s++;
        while (win[t] > p) t--;
        if (s <= t) { const tmp = win[s]; win[s] = win[t]; win[t] = tmp; s++; t--; }
      }
      if (kth <= t) hi = t;
      else if (kth >= s) lo = s;
      else break;
    }
    out[i] = win[kth];
  }
  return out;
}

export interface VLattice {
  /** Fitted x of each line at the page's vertical midpoint, left to right. */
  xs: number[];
  /** Spacing between neighbouring lines, px. */
  pitch: number;
  /** Fraction of the lattice positions the page HAS that actually carry a line.
   *  A page whose lines fade under the writing scores below 1 and is still a grid. */
  coverage: number;
  /** Measured line thickness, px. */
  thickness: number;
  /** Traces ready to hand to `removeVRules` / `eraseVRuleResidue`. */
  vrules: VRuleTrace[];
}

/**
 * Find a regular lattice of vertical printed lines.
 *
 * THE MEASUREMENT IS COLUMN COVERAGE, NOT COLUMN DARKNESS, and the difference is
 * the whole detector. Mean darkness per column separates a printed line from
 * blank paper but NOT from writing: a column through a page of text is dark in
 * plenty of rows, and with a peak bar low enough to catch a faint grid it
 * produces dozens of "peaks" that a pitch search will happily fit a lattice to.
 *
 * What only a printed line does is run the WHOLE HEIGHT of the page. So each
 * column is scored by the fraction of rows in which it is dark at all, against a
 * deliberately lax threshold — a grid line scores near 1, a letter stem scores
 * what one letter is worth (a few percent), and the two do not overlap. The
 * running-median subtraction then removes what every column shares, which is
 * mostly the horizontal rules crossing them.
 *
 * The periodicity test is what makes it a GRID rather than a set of lines: any
 * page has some columns darker than their neighbours, but only printed paper
 * has them at a constant pitch. `coverage` (how many of the pitch's positions
 * are actually occupied) is the number that decides, not the raw peak count.
 */
export function detectVLattice(
  gray: Uint8Array, W: number, H: number,
  opts: { minPitch?: number; maxPitch?: number; minLines?: number; minRun?: number } = {},
): VLattice | null {
  const minPitch = Math.max(6, opts.minPitch ?? Math.round(W / 90));
  const maxPitch = Math.min(Math.round(W / 3), opts.maxPitch ?? Math.round(W / 8));
  const minLines = opts.minLines ?? 5;
  // How much of the page's height a column must be dark down before it can be a
  // printed line. Not 1.0: a grid line fades under the writing that crosses it,
  // and the flatten stage can wash out a whole band of one.
  const minRun = opts.minRun ?? 0.5;
  if (W < 40 || H < 40 || maxPitch <= minPitch) return null;

  const paper = paperLevel(gray);
  // Lax: printed grid lines are FAINT after illumination flatten — often 10-20
  // grey levels below paper, where writing is 80+. The threshold has to admit
  // the faint line, and the coverage measure is what keeps the writing out.
  const darkT = paper - 10;
  const cov = new Float64Array(W);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) if (gray[row + x] < darkT) cov[x]++;
  }
  for (let x = 0; x < W; x++) cov[x] /= H;
  const base = runningMedian(cov, Math.max(8, Math.round(maxPitch * 1.5)));
  const r = new Float64Array(W);
  for (let x = 0; x < W; x++) r[x] = cov[x] - base[x];

  // Peak bar from the profile's own spread, floored so a page with no lattice at
  // all cannot manufacture one out of its own noise.
  const sorted = Array.from(r).sort((a, b) => a - b);
  const p50 = sorted[sorted.length >> 1];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const bar = Math.max(0.15, p50 + (p95 - p50) * 0.45);

  const peaks: number[] = [];
  for (let x = 1; x < W - 1; x++) {
    // BOTH tests: tall against its neighbourhood, and absolutely long enough to
    // be a printed line. The absolute one is what a page of writing fails.
    if (r[x] < bar || cov[x] < minRun) continue;
    if (r[x] < r[x - 1] || r[x] < r[x + 1]) continue;
    // suppress the shoulder of a peak already taken
    if (peaks.length && x - peaks[peaks.length - 1] < minPitch * 0.5) {
      if (r[x] > r[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = x;
      continue;
    }
    peaks.push(x);
  }
  if (peaks.length < minLines) return null;

  // Pitch = the spacing that best explains the peaks. Scanning candidate pitches
  // and scoring alignment beats taking the median gap: a lattice with a few
  // MISSED lines has gaps at 1x and 2x the pitch, and the median of those is
  // neither.
  //
  // THE SCORE MUST CHARGE FOR EMPTY LATTICE POSITIONS, or every HARMONIC of the
  // true pitch ties with it — at half the pitch every line still lands on a
  // node, so a score that only counts hits is identical, and the loop then keeps
  // whichever it saw first, which is the smaller one. Measured on the synthetic
  // grid: true pitch 46, and 23 won with the same 15 hits spread over 29
  // positions instead of 15, after which the lattice was rejected for 52%
  // coverage and the whole grid template did nothing. Charging half a point per
  // empty position separates them 15 to 8.
  //
  // `expected` counts positions over the SPAN THE PEAKS COVER, not the page
  // width: grid paper often has an unruled header or footer, and charging for
  // the positions in it would penalise the true pitch for the paper's margins.
  const loX = peaks[0], hiX = peaks[peaks.length - 1];
  let bestPitch = 0, bestScore = -Infinity, bestPhase = 0;
  for (let p = minPitch; p <= maxPitch; p++) {
    const tol = Math.max(1.5, p * 0.12);
    // Phase from the peaks themselves: try each peak as an anchor (cheap — the
    // score only depends on phase mod p, so distinct anchors mostly collide).
    const phases = new Set<number>();
    for (const x of peaks) phases.add(((x % p) + p) % p);
    const expected = (hiX - loX) / p + 1;
    for (const ph of phases) {
      let hit = 0;
      for (const x of peaks) {
        let e = Math.abs(((x - ph) % p + p) % p);
        if (e > p / 2) e = p - e;
        if (e <= tol) hit++;
      }
      const score = hit
        - 0.5 * Math.max(0, expected - hit)      // lattice positions with no line
        - 0.35 * Math.max(0, hit - expected);    // more lines than the pitch allows
      if (score > bestScore) { bestScore = score; bestPitch = p; bestPhase = ph; }
    }
  }
  if (bestPitch <= 0) return null;

  // Keep the peaks that sit on the winning lattice, one per position.
  const tol = Math.max(1.5, bestPitch * 0.12);
  const byPos = new Map<number, number>();
  for (const x of peaks) {
    const k = Math.round((x - bestPhase) / bestPitch);
    const ideal = bestPhase + k * bestPitch;
    if (Math.abs(x - ideal) > tol) continue;
    const cur = byPos.get(k);
    if (cur == null || r[x] > r[cur]) byPos.set(k, x);
  }
  const xs = [...byPos.values()].sort((a, b) => a - b);
  if (xs.length < minLines) return null;

  // Coverage over the RANGE THE LINES ACTUALLY SPAN, not the whole page: grid
  // paper very often has an unruled header or footer strip, and measuring
  // against the full width would score a real grid at 0.7 and reject it.
  const span = xs[xs.length - 1] - xs[0];
  const positions = Math.round(span / bestPitch) + 1;
  const coverage = positions > 0 ? xs.length / positions : 0;
  if (coverage < 0.6) return null;

  const thickness = measureVThickness(gray, W, H, xs, paper);
  return {
    xs, pitch: bestPitch, coverage, thickness,
    vrules: xs.map((x) => fitVTrace(gray, W, H, x, paper, thickness, bestPitch)),
  };
}

/** Horizontal run width of the dark line at each of several rows; 90th
 *  percentile, plus the anti-aliased skirt. Same construction as the WASM
 *  `probe_thickness`, so the removal band means the same thing. */
function measureVThickness(
  gray: Uint8Array, W: number, H: number, xs: number[], paper: number,
): number {
  const dark = paper - 12;
  const runs: number[] = [];
  for (const x of xs) {
    for (let y = Math.floor(H * 0.1); y < H * 0.9; y += Math.max(1, Math.round(H / 40))) {
      const i = y * W + x;
      if (gray[i] >= dark) continue;
      let a = x, b = x;
      while (a > 0 && gray[y * W + a - 1] < dark) a--;
      while (b < W - 1 && gray[y * W + b + 1] < dark) b++;
      const wRun = b - a + 1;
      if (wRun <= 12) runs.push(wRun);   // wider than that is a crossing stroke
    }
  }
  if (runs.length < 8) return 3;
  runs.sort((a, b) => a - b);
  return Math.min(12, runs[Math.floor(runs.length * 0.9)] + 2);
}

/**
 * One lattice line as an x-per-row trace.
 *
 * A straight column would be enough on a perfect dewarp and is not on a real
 * one: the corrected page still carries a fraction of a degree of rotation, and
 * over 1200 rows a fraction of a degree is several pixels — enough that a fixed
 * band misses the line at one end and eats its neighbour's writing at the
 * other. Least squares over per-band darkness centroids costs nothing and
 * follows it.
 */
function fitVTrace(
  gray: Uint8Array, W: number, H: number, x0: number, paper: number,
  thickness: number, pitch: number,
): VRuleTrace {
  const search = Math.max(3, Math.round(pitch * 0.3));
  const nb = 12;
  const ys: number[] = [], cxs: number[] = [];
  for (let b = 0; b < nb; b++) {
    const yA = Math.floor((b * H) / nb);
    const yB = Math.floor(((b + 1) * H) / nb);
    let wsum = 0, xsum = 0;
    for (let y = yA; y < yB; y++) {
      for (let x = Math.max(0, x0 - search); x <= Math.min(W - 1, x0 + search); x++) {
        const v = paper - gray[y * W + x];
        if (v <= 6) continue;
        wsum += v; xsum += v * x;
      }
    }
    if (wsum <= 0) continue;
    ys.push((yA + yB) / 2);
    cxs.push(xsum / wsum);
  }
  let a = x0, slope = 0;
  if (ys.length >= 4) {
    const n = ys.length;
    const my = ys.reduce((p, q) => p + q, 0) / n;
    const mx = cxs.reduce((p, q) => p + q, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (ys[i] - my) * (cxs[i] - mx); den += (ys[i] - my) ** 2; }
    slope = den > 0 ? num / den : 0;
    // A lattice line is vertical to within a rounding error of the dewarp. A
    // large fitted slope means the centroids latched onto writing, not the line.
    if (Math.abs(slope) > 0.08) slope = 0;
    a = mx - slope * my;
  }
  const x = new Array<number>(H);
  for (let y = 0; y < H; y++) x[y] = Math.round(Math.min(W - 1, Math.max(0, a + slope * y)));
  return { thickness, x };
}

export interface DotLattice {
  pitchX: number;
  pitchY: number;
  phaseX: number;
  phaseY: number;
  /** Dots found sitting on the lattice. */
  count: number;
  /** Of the small blobs on the page, the fraction that sit on the lattice. */
  purity: number;
  /** Median bounding-box side of an on-lattice dot, px. */
  size: number;
  /** Median darkness below paper of an on-lattice dot. */
  depth: number;
}

interface Blob { cx: number; cy: number; w: number; h: number; area: number; depth: number }

/** Small dark blobs, with their size and mean darkness. Bounded by `maxSide` so
 *  a page of writing does not flood-fill into one component and cost a second. */
function smallBlobs(
  gray: Uint8Array, W: number, H: number, dark: number, paper: number, maxSide: number,
): Blob[] {
  const seen = new Uint8Array(W * H);
  const out: Blob[] = [];
  const stack: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = y * W + x;
      if (seen[s] || gray[s] >= dark) continue;
      seen[s] = 1;
      stack.length = 0;
      stack.push(s);
      let x0 = x, x1 = x, y0 = y, y1 = y, area = 0, sum = 0;
      let over = false;
      while (stack.length) {
        const i = stack.pop()!;
        const cx = i % W, cy = (i - (i % W)) / W;
        area++;
        sum += paper - gray[i];
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
        if (x1 - x0 > maxSide || y1 - y0 > maxSide) { over = true; break; }
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const j = ny * W + nx;
            if (!seen[j] && gray[j] < dark) { seen[j] = 1; stack.push(j); }
          }
        }
      }
      // Drain the rest of an oversized component so its pixels are not revisited
      // as fresh seeds (they are already marked, but the stack must be cleared).
      if (over) {
        while (stack.length) {
          const i = stack.pop()!;
          const cx = i % W, cy = (i - (i % W)) / W;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = cx + dx, ny = cy + dy;
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
              const j = ny * W + nx;
              if (!seen[j] && gray[j] < dark) { seen[j] = 1; stack.push(j); }
            }
          }
        }
        continue;
      }
      if (area < 2) continue;
      out.push({
        cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
        w: x1 - x0 + 1, h: y1 - y0 + 1, area, depth: sum / area,
      });
    }
  }
  return out;
}

/** The pitch that best explains a set of coordinates, by phase alignment. */
function bestPitch(vals: number[], lo: number, hi: number): { pitch: number; phase: number; hits: number } {
  let best = { pitch: 0, phase: 0, hits: 0 };
  for (let p = lo; p <= hi; p++) {
    const tol = Math.max(1.5, p * 0.14);
    const phases = new Set<number>();
    for (const v of vals) phases.add(Math.round(((v % p) + p) % p));
    for (const ph of phases) {
      let hit = 0;
      for (const v of vals) {
        let e = Math.abs(((v - ph) % p + p) % p);
        if (e > p / 2) e = p - e;
        if (e <= tol) hit++;
      }
      if (hit > best.hits) best = { pitch: p, phase: ph, hits: hit };
    }
  }
  return best;
}

/**
 * Find a printed dot lattice.
 *
 * The discriminator against an i-dot, a full stop or a speck is NOT position —
 * a written dot lands on a lattice node often enough — it is UNIFORMITY. Printed
 * dots are all the same size and the same darkness because they came off the
 * same press; pen marks vary in both, and are darker. So the lattice is fitted
 * from the small blobs' positions, and then the dot MODEL (median size, median
 * darkness) is fitted from the blobs that landed on it. Erasure later requires
 * a blob to match position AND size AND darkness.
 */
export function detectDotLattice(
  gray: Uint8Array, W: number, H: number,
): DotLattice | null {
  if (W < 60 || H < 60) return null;
  const paper = paperLevel(gray);
  const dark = paper - 14;
  const maxSide = Math.max(4, Math.round(W / 150));
  const blobs = smallBlobs(gray, W, H, dark, paper, maxSide);
  if (blobs.length < 40) return null;

  const lo = Math.max(8, Math.round(W / 120));
  const hi = Math.min(Math.round(W / 6), Math.round(W / 20));
  if (hi <= lo) return null;
  const bx = bestPitch(blobs.map((b) => b.cx), lo, hi);
  const by = bestPitch(blobs.map((b) => b.cy), lo, hi);
  if (!bx.pitch || !by.pitch) return null;

  const tolX = Math.max(1.5, bx.pitch * 0.14);
  const tolY = Math.max(1.5, by.pitch * 0.14);
  const off = (v: number, p: number, ph: number) => {
    let e = Math.abs(((v - ph) % p + p) % p);
    return e > p / 2 ? p - e : e;
  };
  const on = blobs.filter((b) => off(b.cx, bx.pitch, bx.phase) <= tolX
    && off(b.cy, by.pitch, by.phase) <= tolY);
  const purity = on.length / blobs.length;
  // Two independent bars. `count` because a lattice needs to be a lattice — a
  // dozen coincidences are not one. `purity` because on a page of writing the
  // small blobs are dominated by i-dots and stroke fragments, which do not
  // align; a real dot grid puts hundreds of blobs on the lattice and the
  // handwriting's specks are the minority.
  if (on.length < 40 || purity < 0.5) return null;

  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[s.length >> 1];
  };
  return {
    pitchX: bx.pitch, pitchY: by.pitch, phaseX: bx.phase, phaseY: by.phase,
    count: on.length, purity,
    size: med(on.map((b) => Math.max(b.w, b.h))),
    depth: med(on.map((b) => b.depth)),
  };
}

/**
 * Erase a printed dot lattice from a page in place. Returns how many dots went.
 *
 * A dot is erased only when it matches the fitted model on all three counts —
 * on a node, the same size, the same darkness. The size and darkness bands are
 * generous (±60% and ±45%) because the model is a median over hundreds of
 * samples and printing is not perfectly even; what they exclude is the pen,
 * which is a different animal, not a slightly different dot.
 *
 * The fill is the LOCAL paper level rather than a global one, so a dot under a
 * shadow does not become a bright hole.
 */
export function removeDotLattice(
  gray: Uint8Array, W: number, H: number, lat: DotLattice,
): number {
  const paper = paperLevel(gray);
  const dark = paper - 14;
  const maxSide = Math.max(4, Math.round(W / 150));
  const blobs = smallBlobs(gray, W, H, dark, paper, maxSide);
  const tolX = Math.max(1.5, lat.pitchX * 0.14);
  const tolY = Math.max(1.5, lat.pitchY * 0.14);
  const off = (v: number, p: number, ph: number) => {
    let e = Math.abs(((v - ph) % p + p) % p);
    return e > p / 2 ? p - e : e;
  };
  let erased = 0;
  for (const b of blobs) {
    if (off(b.cx, lat.pitchX, lat.phaseX) > tolX) continue;
    if (off(b.cy, lat.pitchY, lat.phaseY) > tolY) continue;
    const side = Math.max(b.w, b.h);
    if (side > lat.size * 1.6 + 1 || side < lat.size * 0.4) continue;
    if (b.depth > lat.depth * 1.45 + 6) continue;   // darker than print = pen
    // Local paper: the median of a ring around the dot, so the patch matches the
    // page it sits in.
    const x0 = Math.max(0, Math.round(b.cx) - side - 2);
    const x1 = Math.min(W - 1, Math.round(b.cx) + side + 2);
    const y0 = Math.max(0, Math.round(b.cy) - side - 2);
    const y1 = Math.min(H - 1, Math.round(b.cy) + side + 2);
    const ring: number[] = [];
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++)
        if (gray[y * W + x] >= dark) ring.push(gray[y * W + x]);
    const fill = ring.length
      ? ring.sort((p, q) => p - q)[ring.length >> 1]
      : paper;
    const rx = Math.ceil(b.w / 2) + 1, ry = Math.ceil(b.h / 2) + 1;
    for (let y = Math.max(0, Math.round(b.cy) - ry); y <= Math.min(H - 1, Math.round(b.cy) + ry); y++)
      for (let x = Math.max(0, Math.round(b.cx) - rx); x <= Math.min(W - 1, Math.round(b.cx) + rx); x++)
        if (gray[y * W + x] < dark) gray[y * W + x] = fill;
    erased++;
  }
  return erased;
}

/**
 * Baselines read off the WRITING, for paper that has no printed rules.
 *
 * THIS IS WHAT PLAIN PAPER WAS MISSING, and the failure was total rather than
 * partial. `ccWordBoxes` takes `ruleBaselines` and its `assignLine` returns 0
 * for every component when that array is empty — so an unruled page put every
 * word on line 0, gap clustering then had one enormous line to cluster, and the
 * whole page came back as ONE word box. Measured on the synthetic unruled
 * sample: 1 box for a page of writing. Turning the rule tracer off (which is
 * the right thing to do on unruled paper) is what exposes it; before this
 * template existed the tracer's invented rules were accidentally supplying the
 * line structure while corrupting the ink.
 *
 * The estimator is a row ink-profile split into bands. A baseline is placed at
 * each band's lower edge rather than its centre because that is what a printed
 * rule would be — the descenders hang below it — and everything downstream
 * (`attachBaselines`, `eraseRuleResidue`, `assignLine`) was written against a
 * rule's geometry.
 *
 * IT ESTIMATES ITS OWN LINE PITCH AND DOES NOT TAKE PASS A'S. `estimate_line_height`
 * probes the 95th-percentile vertical gap between dark pixels, which is a good
 * estimator of rule spacing on RULED paper and a bad one on unruled paper, where
 * the gaps it measures are mostly the blank space between lines: on the
 * synthetic unruled page it reads 185 against a true pitch of 46. Smoothing at
 * 8% of 185 then merged every line with its neighbours and produced 4 baselines
 * for 16 lines of writing. Autocorrelating the profile finds the pitch from the
 * writing itself, which is the only thing on an unruled page that knows it.
 */
export function inkBaselines(
  gray: Uint8Array, W: number, H: number, lineHeightHint = 0,
): number[] {
  const paper = paperLevel(gray);
  const darkT = paper - 40;                     // writing, not print
  const row = new Float64Array(H);
  for (let y = 0; y < H; y++) {
    let n = 0;
    for (let x = 0; x < W; x++) if (gray[y * W + x] < darkT) n++;
    row[y] = n / W;
  }
  const peak = Math.max(...row);
  if (peak <= 0) return [];

  const pitch = profilePitch(row, H) || (lineHeightHint > 4 ? lineHeightHint : Math.max(12, H / 30));

  // Smooth over a fraction of a line so the two density lobes a wandering line
  // of handwriting produces (x-height band and ascender band) stay one line.
  const r = Math.max(1, Math.round(pitch * 0.12));
  const sm = new Float64Array(H);
  for (let y = 0; y < H; y++) {
    let s = 0, n = 0;
    for (let k = Math.max(0, y - r); k <= Math.min(H - 1, y + r); k++) { s += row[k]; n++; }
    sm[y] = s / n;
  }
  const smPeak = Math.max(...sm);
  if (smPeak <= 0) return [];
  // A fraction of the page's own peak row density, so a light hand and a heavy
  // one give the same bands.
  const bar = smPeak * 0.18;

  const bands: { y0: number; y1: number }[] = [];
  let start = -1;
  for (let y = 0; y < H; y++) {
    if (sm[y] >= bar) { if (start < 0) start = y; }
    else if (start >= 0) { bands.push({ y0: start, y1: y - 1 }); start = -1; }
  }
  if (start >= 0) bands.push({ y0: start, y1: H - 1 });

  // Rejoin the lobes of ONE line: a wandering hand puts most of its ink in the
  // x-height band and the rest in the ascenders, and the row between them can
  // dip below the bar and split the line in two.
  //
  // THE GAP TEST ALONE IS NOT ENOUGH, and the reason is arithmetic: at a 46px
  // pitch with bands 29px tall the space BETWEEN lines is 17px, and the space
  // between one line's two lobes is about the same. Merging on gap alone
  // therefore fused line pairs and gave 10 baselines for 16 lines of writing.
  // The height cap is what separates them — two lobes of one line still fit
  // inside a line, and two lines do not.
  const merged: { y0: number; y1: number }[] = [];
  for (const b of bands) {
    const last = merged[merged.length - 1];
    if (last && b.y0 - last.y1 < pitch * 0.35 && b.y1 - last.y0 + 1 <= pitch * 0.95) {
      last.y1 = b.y1;
      continue;
    }
    merged.push({ ...b });
  }

  const out: number[] = [];
  for (const b of merged) {
    // Too short to be a line of writing (a speck, a stray mark).
    if (b.y1 - b.y0 + 1 < pitch * 0.2) continue;
    // The baseline is where the bulk of the ink STOPS. Descenders are a thin
    // tail below it, so the last row at a fifth of the band's own peak is a far
    // better estimate than the band's bottom edge.
    let bp = 0;
    for (let y = b.y0; y <= b.y1; y++) bp = Math.max(bp, sm[y]);
    let base = b.y1;
    for (let y = b.y1; y >= b.y0; y--) {
      if (sm[y] >= bp * 0.2) { base = y; break; }
    }
    out.push(base);
  }
  return out;
}

/**
 * Line pitch from a row ink profile, by autocorrelation.
 *
 * Lines of writing repeat; nothing else on the page does. The profile is
 * mean-removed first so the correlation measures the REPEAT rather than the
 * page's overall darkness. Returns 0 when no lag stands out, which is the
 * honest answer for a page with two lines on it.
 *
 * TAKE THE FIRST STRONG PEAK, NOT THE HIGHEST. Autocorrelation peaks at every
 * multiple of the true pitch, and a page with STRUCTURE above the line — a blank
 * line every so often, a paragraph rhythm — correlates BETTER at the structure's
 * period than at one line, because at one line's lag the blanks land on written
 * rows. Measured on the synthetic unruled page, which blanks every fifth line:
 * the argmax is 230 (five lines) against a true pitch of 46, and taking it
 * merged the whole page into one band. Dividing the argmax down does not fix it
 * either — the answer is not always a neat divisor of the structure's period.
 */
function profilePitch(row: Float64Array, H: number): number {
  const lo = Math.max(8, Math.round(H / 120));
  const hi = Math.round(H / 4);
  if (hi <= lo) return 0;
  let mean = 0;
  for (let y = 0; y < H; y++) mean += row[y];
  mean /= H;
  const d = new Float64Array(H);
  for (let y = 0; y < H; y++) d[y] = row[y] - mean;
  let norm = 0;
  for (let y = 0; y < H; y++) norm += d[y] * d[y];
  if (norm <= 0) return 0;

  const corr = new Float64Array(hi + 1);
  let bestC = 0;
  for (let lag = lo; lag <= hi; lag++) {
    let c = 0;
    for (let y = 0; y + lag < H; y++) c += d[y] * d[y + lag];
    corr[lag] = c / norm;
    if (corr[lag] > bestC) bestC = corr[lag];
  }
  // A page of writing correlates with itself at one line's offset far better
  // than at a random one. No clear peak means no repeating structure to find.
  if (bestC < 0.15) return 0;

  const bar = bestC * 0.7;
  for (let lag = lo + 1; lag < hi; lag++) {
    if (corr[lag] < bar) continue;
    if (corr[lag] < corr[lag - 1] || corr[lag] < corr[lag + 1]) continue;
    return lag;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface TemplateEvidence {
  /** Horizontal rules Pass A traced. */
  rules: number;
  /** Coefficient of variation of the gaps between them. Printed rules are
   *  regular; rules "found" in dense writing are not. */
  ruleGapCv: number;
  /** Vertical rules Pass A traced (0 or 1 — it only ever emits one). */
  vrules: number;
  /** Median x of that vrule as a fraction of the page width; -1 if none. */
  vruleAt: number;
  /** Its measured thickness, px. A double margin reads as a thick single line. */
  vruleThickness: number;
  vLattice: { pitch: number; lines: number; coverage: number } | null;
  dotLattice: { pitchX: number; pitchY: number; count: number; purity: number } | null;
}

export interface TemplateChoice {
  template: PageTemplate;
  /** 0..1. Below `AUTO_MIN_CONFIDENCE` the caller should say so rather than
   *  silently commit — an unsure guess about the paper is worse than the
   *  default, because it changes the parameters. */
  confidence: number;
  /** Why, in one line, for a lab or a log. */
  reason: string;
  evidence: TemplateEvidence;
}

/** The bar below which `cleanPage` keeps the default rather than acting on a
 *  guess. Set so the five-page photo corpus, which is ordinary ruled paper with
 *  a left margin, lands well above it. */
export const AUTO_MIN_CONFIDENCE = 0.5;

/** Traced margin thickness, as a fraction of the page width, above which the
 *  margin is a PAIR of rules rather than one. Fitted to the six pages of
 *  `training/pages/` — see the note at its use in `classifyTemplate`. */
export const DOUBLE_MARGIN_FRAC = 0.0125;

function cv(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (m <= 0) return 0;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
  return Math.sqrt(v) / m;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * Read the paper off a completed Pass A run.
 *
 * Order matters and is not arbitrary: the LATTICES are tested first, because a
 * grid page and a dot page both also look like some other template from the
 * rule tracer's point of view (a grid has perfectly good horizontal rules and
 * one "margin"; a dot page has neither and reads as plain). Only when neither
 * lattice is present does the horizontal-rule evidence decide.
 */
export function classifyTemplate(
  gray: Uint8Array, W: number, H: number, rules: RulesJson,
): TemplateChoice {
  const hs = rules.rules ?? [];
  const gaps: number[] = [];
  const mids = hs.map((r) => median(r.y)).sort((a, b) => a - b);
  for (let i = 1; i < mids.length; i++) gaps.push(mids[i] - mids[i - 1]);
  const vs = rules.vrules ?? [];
  const vAt = vs.length ? median(vs[0].x) / W : -1;

  // Printed rules are evenly spaced by construction. "Rules" the tracer found in
  // dense writing are not, and that is the only test here that does real work:
  // rule COUNT alone cannot separate them, because a page of writing produces
  // plenty of horizontal line-energy.
  const ruleCv = cv(gaps);
  const ruled = hs.length >= 3 && ruleCv <= 0.25;

  const vLat = detectVLattice(gray, W, H);
  // The dot detector is a full connected-component pass, and dots do not share a
  // page with printed rules — so a page that is already clearly ruled does not
  // pay for it. That is a real saving on the common case, not a micro-optimisation:
  // it is the difference between the classifier costing nothing measurable on an
  // ordinary ruled photo and costing a CC pass over two megapixels.
  const dots = vLat || ruled ? null : detectDotLattice(gray, W, H);

  const ev: TemplateEvidence = {
    rules: hs.length,
    ruleGapCv: ruleCv,
    vrules: vs.length,
    vruleAt: vAt,
    vruleThickness: vs.length ? vs[0].thickness : 0,
    vLattice: vLat ? { pitch: vLat.pitch, lines: vLat.xs.length, coverage: vLat.coverage } : null,
    dotLattice: dots
      ? { pitchX: dots.pitchX, pitchY: dots.pitchY, count: dots.count, purity: dots.purity }
      : null,
  };

  const pick = (id: PageTemplateId, confidence: number, reason: string): TemplateChoice =>
    ({ template: templateById(id)!, confidence, reason, evidence: ev });

  if (vLat) {
    return pick('grid', Math.min(1, 0.55 + vLat.coverage * 0.45),
      `${vLat.xs.length} vertical lines at ${vLat.pitch}px pitch, ${(vLat.coverage * 100).toFixed(0)}% covered`);
  }
  if (dots) {
    return pick('dots', Math.min(1, 0.4 + dots.purity * 0.6),
      `${dots.count} dots on a ${dots.pitchX}x${dots.pitchY}px lattice, ${(dots.purity * 100).toFixed(0)}% pure`);
  }

  if (!ruled) {
    // Confidence is deliberately asymmetric. Declaring a page plain turns the
    // rule stage OFF, and being wrong about that leaves the rules in the ink;
    // so a page with several near-regular rules is reported as a weak plain,
    // and `cleanPage` will keep the default instead.
    const conf = hs.length === 0 ? 0.9 : hs.length < 3 ? 0.7 : Math.max(0.2, 0.7 - ev.ruleGapCv);
    return pick('plain', conf,
      hs.length === 0 ? 'no horizontal rules traced'
        : `${hs.length} rules, spacing cv ${ev.ruleGapCv.toFixed(2)} — not a printed ruling`);
  }

  const conf = Math.min(1, 0.6 + Math.min(hs.length, 12) / 30);
  if (vs.length && vAt >= 0 && vAt <= 0.35) {
    // A double margin reads as ONE THICK TRACE, because `probe_thickness_double`
    // deliberately spans both lines and the gap between them. So the pair shows
    // up as thickness, and the only question is where the bar goes.
    //
    // MEASURED on all six pages of `training/pages/`, each checked by eye at the
    // margin: the three double-ruled pages trace at 17, 17 and 18px and the
    // three single-ruled at 10, 11 and 11, at a working width of 1125px. That is
    // 1.51-1.60% of the width against 0.89-0.98%, and the bar sits in the middle
    // of a gap with no samples in it.
    //
    // Relative to the page width rather than absolute, because `workMaxDim` is a
    // caller's choice: the same paper photographed and processed at 3000px would
    // trace at twice the pixel thickness and an absolute bar would call every
    // margin double.
    const dbl = ev.vruleThickness >= W * DOUBLE_MARGIN_FRAC;
    return pick(dbl ? 'ruled-margin-double' : 'ruled-margin', conf,
      `${hs.length} rules + a margin at ${(vAt * 100).toFixed(0)}% width, ${ev.vruleThickness}px thick`
      + ` (${(100 * ev.vruleThickness / W).toFixed(2)}% — ${dbl ? 'double' : 'single'})`);
  }
  if (vs.length && vAt >= 0.65) {
    // The right-hand margin: the mirror of the common one, with its own
    // template so the strip beyond the line is excluded on the correct side.
    return pick('ruled-margin-right', conf,
      `${hs.length} rules + a margin at ${(vAt * 100).toFixed(0)}% width (right-hand)`);
  }
  return pick('ruled', conf, `${hs.length} rules, no margin line`);
}
