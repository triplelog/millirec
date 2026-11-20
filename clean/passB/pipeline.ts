// Per-word cleanup pipeline. Implemented stages:
//
//   1. Baseline attach — bind each word box to the printed rule that acts as
//      its baseline: the topmost rule with at least `minInkAbove` of the
//      word's ink above it, searched down to `maxExtend` line heights below
//      the box. The box is expanded to include the rule band plus a margin.
//   2. Level — resample each word crop from the flattened page so its
//      baseline is exactly horizontal, either by rigid rotation (least-
//      squares slope of the rule over the box span) or by per-column
//      vertical shift following the actual rule trace.
//   3. Rule removal — port of better's lines.c dual-test band removal,
//      applied to the one horizontal band per crop. A band pixel survives
//      as text only if it is (a) radically darker than the band row's
//      expected color (running median along the row) AND (b) its vertical
//      dark run extends beyond the band (crossing strokes continue; rule
//      pixels don't). Everything else is erased and blended to background.
//   4. Measure — per-word core height and stroke thickness on the cleaned
//      crop. X-height = the dense band of the ink row-projection above the
//      baseline (NOT a raw ink-percentile — that is biased by ascender
//      composition); thickness = median over dark pixels of
//      min(horizontal run, vertical run), robust to blobs and joins.
//   5. Height normalize — uniform bilinear rescale of each cleaned crop so
//      its x-height matches the page median, with the per-word factor
//      clamped to 1 ± scaleClamp so a mis-measured word can't be mangled.
//   6. Thickness normalize — signed distance field offset. A sub-pixel SDF
//      is built from the grayscale (exact Euclidean distance transform far
//      from the edge, the anti-aliased gray ramp near it — the same
//      information a threshold shift would exploit, so both of the planned
//      phases collapse into one continuous offset), the ink surface is
//      moved by ±offset px per side (total change capped), and the stroke
//      is re-rendered with a soft edge at uniform ink color. Thickness is
//      (re)measured at the SAME coverage surface the SDF moves, so the
//      correction is self-consistent with the rendering. The offset is a
//      per-pixel FIELD driven by local stroke thickness (depth of the
//      nearest ridge, doubled): parts thinner than the target grow, parts
//      at or beyond it stay put — thinning targets only the fat parts,
//      thickening only the thin ones. Rendering saturates to full ink a
//      fixed small depth inside the surface, so ridge lines / central
//      contours always reach max darkness even on hairline strokes.
//   7. Smooth — blur the (offset) SDF and re-render: every level set is
//      smoothed consistently, rounding stroke wobble without contours
//      crossing. The potrace comparison lives in the UI layer.
//   8. Composite — place the finished words on a blank page: rules are
//      straightened to horizontal lines at each rule's median y, words
//      center on their original x with their baseline on the straight
//      rule, and ink merges via min-blend (darker wins) after each crop's
//      paper level is remapped to pure white.
//
// Everything works on the full-page grayscale so crops never resample twice.

import type { RulesJson, BoxesJson, RuleTrace, WordBox } from '../types';

export interface Params {
  inkThreshold: number;
  inkSlack: number;       // hysteresis: flood ink into neighbours this much lighter
  padX: number;
  padTop: number;
  minInkAbove: number;
  maxExtend: number;      // × line height searched below the box bottom
  baselineMargin: number; // rows kept below the rule band
  fallbackPct: number;    // ink-y percentile for synthetic baselines
  levelMode: number;      // 0 = rigid rotate, 1 = per-column unwarp
  rmMaxThick: number;     // cap on the rule thickness used for the band
  rmBandPad: number;      // extra band rows each side (leveling residue)
  rmDelta: number;        // darker than expected by this = text
  rmWindow: number;       // half-width of the expected-color median window
  rmExtend: number;       // dark run must reach this far past the band
  rmGrow: number;         // along-rule rescue flood reach, px (0 = off)
  rmGapBridge: number;    // rescue connectivity radius, px (bridges light gaps)
  rmRescueDelta: number;  // darker-than-rule margin for a pixel to be rescuable
  rmShapePrune: number;   // erase band shapes not extending this far past a rule (0 = off)
  rmInpaint: number;      // diffusion iterations over erased pixels
  rmTint: number;         // 0/1: contact sheet shows classification tint
  xhFrac: number;         // x-height band ends where projection < this × peak
  xhSmooth: number;       // box-smoothing radius of the row projection
  thickDark: number;      // ink cutoff for thickness runs (excludes AA edges)
  scaleClamp: number;     // per-word height scale clamped to 1 ± this
  tnMaxChange: number;    // cap on total thickness change, px
  tnTarget: number;       // goal thickness, px (0 = auto page median)
  tnEdge: number;         // rendered anti-aliased edge width, px
  tnSurface: number;      // ink coverage level treated as the stroke boundary
  tnInk: number;          // ink core gray override (0 = auto per word)
  dkPct: number;          // % of stroke pixels pushed to max black (0 = off)
  smRadius: number;       // SDF blur radius for stage-7 smoothing, px
  smTurd: number;         // potrace turdsize (speckle removal)
  smAlphaMax: number;     // potrace alphamax (corner smoothing)
  cpSource: number;       // 0 = SDF smoothed, 1 = potrace, 2 = unsmoothed
  cpRules: number;        // 0/1: draw straightened rules on the output page
}

export type WordStatus = 'ok' | 'extended' | 'fallback' | 'empty';

export interface WordRec {
  index: number;
  line: number;
  box: WordBox;                                   // original segmenter box
  x0: number; y0: number; x1: number; y1: number; // expanded crop, inclusive
  /** The crop bounds BEFORE `extendCropsToOwnedInk` grew them to cover owned
   *  descenders. The decode's votes, bands and gates read `voteBox ?? rec` —
   *  growing the voting rectangles was a measured negative (photo 23 -> 36). */
  voteBox?: { x0: number; y0: number; x1: number; y1: number };
  inkCount: number;
  inkAboveFrac: number; // fraction of ink above the chosen baseline
  ruleIdx: number;      // index into rules[], -1 = synthetic baseline
  baselineY: number;    // page y at the box center
  slope: number;        // baseline dy/dx over the box span
  status: WordStatus;
  crop?: ImageData;     // leveled gray crop (stage 2)
  baselineRow?: number; // baseline row within crop
  clean?: ImageData;    // crop after rule removal (stage 3)
  mask?: Uint8Array;    // per px: 0 untouched, 1 removed, 2 protected text
  measure?: Measure;    // stage 4 (absent when the crop has no ink)
  scale?: number;             // stage 5 height-normalization factor
  scaled?: ImageData;         // stage 5 rescaled crop
  scaledBaselineRow?: number; // baseline row within the scaled crop
  thickCur?: number;          // stage 6 thickness at the coverage surface, px
  thickOffset?: number;       // stage 6 word-level offset per side (captions)
  thick?: ImageData;          // stage 6 thickness-normalized crop (cleanPage renders it only for
                              // ink-less pass-through words; `smooth` is the render it ships)
  bgclean?: ImageData;        // scaled crop, background removed, NO thickness change
                              // (filled by `cleanRenders`, which cleanPage no longer runs — nothing consumed it)
  sdf?: Sdf;                  // stage 6 SDF of the scaled crop
  sdfAdj?: Sdf;               // stage 6 SDF after the adaptive offset (used by 7)
  smooth?: ImageData;         // stage 7 SDF-smoothed render
  traced?: ImageData;         // stage 7 potrace render (filled by the UI)
}

export interface Measure {
  xHeight: number;   // px from baseline up to the top of the core band
  ascent: number;    // px from baseline up to the topmost ink row
  descent: number;   // px from baseline down to the lowest ink row
  thickness: number; // median stroke width, px
  proj: number[];    // smoothed ink row-projection above the baseline
  projMax: number;   // its peak (threshold = xhFrac × this)
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function toGray(img: ImageData): Uint8Array {
  const { data, width, height } = img;
  const g = new Uint8Array(width * height);
  for (let i = 0; i < g.length; i++) {
    const o = i * 4;
    g[i] = (data[o] * 77 + data[o + 1] * 150 + data[o + 2] * 29) >> 8;
  }
  return g;
}

/**
 * The k-th smallest value, without a comparator sort.
 *
 * Every caller here hands in a per-pixel sample — a crop's paper levels, a
 * page's stroke run lengths — so the arrays run to tens of thousands of
 * elements and `[...v].sort((a,b)=>a-b)` was doing O(n log n) comparator calls
 * on the copy. Two exact replacements, chosen by what the data is:
 *
 *   - SMALL-INTEGER data (grays, run lengths — most of it) goes through a
 *     counting histogram: one pass to bucket, one to walk. O(n).
 *   - anything else through quickselect on a typed copy: O(n) expected, no
 *     comparator, and only the k-th position is resolved.
 *
 * Both return exactly `[...values].sort((a,b)=>a-b)[k]`, ties included, since
 * equal values are indistinguishable.
 */
function selectKth(values: number[] | Uint8Array | Float64Array, k: number): number {
  const n = values.length;
  if (!n) return undefined as unknown as number;   // what the sort form returned
  // integrality + range probe: one pass, and it exits the moment it fails
  let lo = Infinity, hi = -Infinity, ints = true;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    if (ints && (v | 0) !== v) { ints = false; break; }
  }
  if (ints && hi - lo < 4096) {
    if (lo === Infinity) return NaN;
    const hist = new Int32Array(hi - lo + 1);
    for (let i = 0; i < n; i++) hist[values[i] - lo]++;
    let seen = 0;
    for (let b = 0; b < hist.length; b++) {
      seen += hist[b];
      if (seen > k) return b + lo;
    }
    return hi;
  }
  const a = Float64Array.from(values as number[]);
  let l = 0, r = n - 1;
  while (l < r) {
    // median-of-3 pivot, so sorted and constant runs do not degenerate
    const m = (l + r) >> 1;
    const x = a[l], y = a[m], z = a[r];
    const p = x < y ? (y < z ? y : (x < z ? z : x)) : (x < z ? x : (y < z ? z : y));
    let i = l, j = r;
    while (i <= j) {
      while (a[i] < p) i++;
      while (a[j] > p) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k <= j) r = j;
    else if (k >= i) l = i;
    else return a[k];
  }
  return a[k];
}

function percentile(values: number[], pct: number): number {
  const n = values.length;
  return selectKth(values, clamp(Math.round((pct / 100) * (n - 1)), 0, n - 1));
}

/** Least-squares slope of a rule trace over columns [x0, x1]. */
function traceSlope(rule: RuleTrace, x0: number, x1: number): number {
  const n = x1 - x0 + 1;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let x = x0; x <= x1; x++) {
    const rx = x - x0;
    sx += rx; sy += rule.y[x]; sxy += rx * rule.y[x]; sxx += rx * rx;
  }
  const denom = n * sxx - sx * sx;
  return denom ? (n * sxy - sx * sy) / denom : 0;
}

export function attachBaselines(
  gray: Uint8Array, W: number, H: number,
  rulesJson: RulesJson, boxesJson: BoxesJson, p: Params,
): WordRec[] {
  // defensive sort top-to-bottom (export already sorts)
  const rules = [...rulesJson.rules]
    .sort((a, b) => a.y[a.y.length >> 1] - b.y[b.y.length >> 1]);
  const lineHeight = rulesJson.lineHeight > 0
    ? rulesJson.lineHeight
    : estimateLineHeight(rules, H);

  const recs: WordRec[] = [];
  let index = 0;
  boxesJson.lines.forEach((ln, li) => {
    for (const box of ln.words) {
      recs.push(attachOne(gray, W, H, rules, lineHeight, box, index++, li, p));
    }
  });
  return recs;
}

function estimateLineHeight(rules: RuleTrace[], H: number): number {
  if (rules.length < 2) return H / 25;
  const gaps: number[] = [];
  for (let i = 1; i < rules.length; i++) {
    const mid = rules[i].y.length >> 1;
    gaps.push(rules[i].y[mid] - rules[i - 1].y[mid]);
  }
  return percentile(gaps, 50);
}

/**
 * RE-ATTACH after component ownership, on the word's OWN ink. The attach
 * above runs before ownership exists, on everything dark inside the
 * segmenter's box — and a box the cross-line splitter could not shorten (a
 * `g` welded to the `s` of the line below) holds the next line's letters too.
 * The topmost rule then fails `minInkAbove` by a hair and the word takes the
 * LOWER line's baseline: warehouse2's "full again." carried 444 for a line
 * whose rule is 393, so the editor filed it under the heading below, cut
 * "full" out of that heading's ink, and rendered `# C` in its place. (Node
 * attached 393 to the same box — its rasterization put a few pixels fewer
 * below the rule — which is why no node gate saw it.)
 *
 * Only records with a FOREIGN-owned component inside their box are touched:
 * the ink counted is what the record's line owns or nobody claims, and the
 * box bottom follows that ink, so a record that lost the line below's letters
 * also stops reaching down into them. Everything else keeps its first attach
 * byte for byte. Returns how many records changed.
 */
export function reattachOwned(
  gray: Uint8Array, W: number, H: number,
  rulesJson: RulesJson, recs: WordRec[], p: Params,
  own: { ccLabel: Int32Array; ccOwner: Int32Array; ccMinX: number[]; ccMaxX: number[]; ccMinY: number[]; ccMaxY: number[] },
): number {
  const rules = [...rulesJson.rules]
    .sort((a, b) => a.y[a.y.length >> 1] - b.y[b.y.length >> 1]);
  const lineHeight = rulesJson.lineHeight > 0
    ? rulesJson.lineHeight
    : estimateLineHeight(rules, H);
  let changed = 0;
  for (const r of recs) {
    if (r.status === 'empty') continue;
    let foreign = false;
    for (let c = 0; c < own.ccOwner.length && !foreign; c++) {
      const o = own.ccOwner[c];
      if (o < 0 || o === r.line) continue;
      foreign = own.ccMinX[c] <= r.x1 && own.ccMaxX[c] >= r.x0 && own.ccMinY[c] <= r.y1 && own.ccMaxY[c] >= r.y0;
    }
    if (!foreign) continue;
    const keep = (x: number, y: number): boolean => {
      const c = own.ccLabel[y * W + x];
      return c < 0 || own.ccOwner[c] < 0 || own.ccOwner[c] === r.line;
    };
    const again = attachOne(gray, W, H, rules, lineHeight, r.box, r.index, r.line, p, keep);
    {
      const t = (globalThis as { __sepTrace?: [number, number, number, number] }).__sepTrace;
      if (t && r.x1 >= t[0] && r.x0 <= t[2] && r.y1 >= t[1] && r.y0 <= t[3]) {
        const cx = clamp(Math.round(r.box.x + r.box.w / 2), 0, W - 1);
        const near = rules.map((ru, ri) => `${ri}:${ru.y[cx]}`).filter((s) => { const y = Number(s.split(':')[1]); return y >= r.y0 - lineHeight && y <= r.y1 + lineHeight; });
        console.log(`[reattach] rec x${r.x0}-${r.x1} y${r.y0}-${r.y1} line=${r.line} before=@${r.baselineY}/${r.status} after=@${again.baselineY}/${again.status} rule=${again.ruleIdx} frac=${again.inkAboveFrac.toFixed(2)} y1=${r.y1}->${again.y1} ink=${again.inkCount} rules@cx${cx}=[${near.join(' ')}]`);
      }
    }
    if (again.status === 'empty') continue;
    if (again.baselineY === r.baselineY && again.y1 === r.y1) continue;
    r.ruleIdx = again.ruleIdx;
    r.baselineY = again.baselineY;
    r.slope = again.slope;
    r.status = again.status;
    r.inkCount = again.inkCount;
    r.inkAboveFrac = again.inkAboveFrac;
    r.y1 = again.y1;
    changed++;
  }
  return changed;
}

function attachOne(
  gray: Uint8Array, W: number, H: number,
  rules: RuleTrace[], lineHeight: number,
  box: WordBox, index: number, line: number, p: Params,
  /** which dark pixels count as this word's (reattachOwned); all of them by default */
  keep?: (x: number, y: number) => boolean,
): WordRec {
  const x0 = clamp(box.x - p.padX, 0, W - 1);
  const x1 = clamp(box.x + box.w - 1 + p.padX, 0, W - 1);
  const y0 = clamp(box.y - p.padTop, 0, H - 1);
  const segBot = clamp(box.y + box.h - 1, 0, H - 1);
  const cx = clamp(Math.round(box.x + box.w / 2), 0, W - 1);

  // ink pixels inside the (x-expanded) segmenter box
  const inkX: number[] = [], inkY: number[] = [];
  let inkBot = -1;
  for (let y = y0; y <= segBot; y++)
    for (let x = x0; x <= x1; x++)
      if (gray[y * W + x] < p.inkThreshold && (!keep || keep(x, y))) { inkX.push(x); inkY.push(y); inkBot = y; }
  // With a filter, the box bottom follows the ink that survived it: the
  // segmenter's bottom was set by letters this word no longer owns.
  const boxBot = keep && inkBot >= 0 ? Math.min(segBot, inkBot + 1) : segBot;

  const rec: WordRec = {
    index, line, box, x0, y0, x1, y1: boxBot,
    inkCount: inkX.length, inkAboveFrac: 0,
    ruleIdx: -1, baselineY: boxBot, slope: 0, status: 'empty',
  };
  if (!inkX.length) return rec;

  // topmost rule with >= minInkAbove of the ink above it, searched down to
  // maxExtend line heights below the box bottom
  const searchBot = boxBot + p.maxExtend * lineHeight;
  for (let ri = 0; ri < rules.length; ri++) {
    const yc = rules[ri].y[cx];
    if (yc < y0 || yc > searchBot) continue;
    let above = 0;
    for (let i = 0; i < inkX.length; i++)
      if (inkY[i] < rules[ri].y[inkX[i]]) above++;
    const frac = above / inkX.length;
    if (frac >= p.minInkAbove) {
      rec.ruleIdx = ri;
      rec.inkAboveFrac = frac;
      rec.baselineY = yc;
      rec.slope = traceSlope(rules[ri], x0, x1);
      rec.status = yc > boxBot ? 'extended' : 'ok';
      let maxRuleY = 0;
      for (let x = x0; x <= x1; x++) maxRuleY = Math.max(maxRuleY, rules[ri].y[x]);
      rec.y1 = clamp(
        Math.max(boxBot, maxRuleY + Math.ceil(rules[ri].thickness / 2) + p.baselineMargin),
        y0, H - 1,
      );
      return rec;
    }
  }

  // no qualifying rule (typically below the last rule of the page):
  // synthesize a baseline from the ink itself
  rec.status = 'fallback';
  rec.baselineY = percentile(inkY, p.fallbackPct);
  rec.inkAboveFrac = p.fallbackPct / 100;
  let nearest = -1, nearestDist = Infinity;
  for (let ri = 0; ri < rules.length; ri++) {
    const d = Math.abs(rules[ri].y[cx] - rec.baselineY);
    if (d < nearestDist) { nearestDist = d; nearest = ri; }
  }
  if (nearest >= 0) rec.slope = traceSlope(rules[nearest], x0, x1);
  rec.y1 = clamp(Math.max(boxBot, Math.ceil(rec.baselineY) + p.baselineMargin), y0, H - 1);
  return rec;
}

function sampleBilinear(gray: Uint8Array, W: number, H: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x > W - 1 || y > H - 1) return 255;
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const xj = Math.min(xi + 1, W - 1), yj = Math.min(yi + 1, H - 1);
  const a = gray[yi * W + xi], b = gray[yi * W + xj];
  const c = gray[yj * W + xi], d = gray[yj * W + xj];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/** Stage 2: fill rec.crop with the leveled grayscale crop. */
export function levelWords(
  gray: Uint8Array, W: number, H: number,
  rulesJson: RulesJson, recs: WordRec[], p: Params,
  /** Per-pixel line ownership from the segmenter (line index + 1; 0 =
   *  unclaimed — see `CCWordOut.lineMask`). With it, a source pixel the
   *  segmenter assigned to a DIFFERENT line samples as paper: on tight ruling
   *  a word's crop rectangle reaches over the neighbouring lines' ascenders
   *  and descenders, and without the mask that foreign ink rides the crop
   *  through every later stage into the word's displayed render. Own-line and
   *  unclaimed ink are kept — the same rule as `cropGrayRegion`, which is how
   *  the trainers have always cut their line strips. */
  lineMask?: Int16Array,
  /** `CCWordOut.lineIds`: the BoxesJson-index -> segmenter-line-id bridge.
   *  `rec.line` is a BoxesJson index and the mask holds SEGMENTER ids — on any
   *  page with a wordless rule they diverge, and reading the mask untranslated
   *  whitens a word's OWN ink as foreign (measured: every crop near-empty).
   *  Omit only when the caller's rec.line already carries mask-space ids. */
  lineIds?: number[],
  /** Rule-residue strip pixels (removeHRulesPage's distance-graded display
   *  mask, 1 = strip): sampled like `lineMask`, a marked source pixel reads
   *  as paper. DISPLAY-side by design — the crops are the editor's shown
   *  ink, while the decode reads segPage and never sees this (erasing these
   *  pixels decode-side measured 8-11 photo words; see clean/README.md). */
  stripMask?: Uint8Array,
): void {
  const rules = [...rulesJson.rules]
    .sort((a, b) => a.y[a.y.length >> 1] - b.y[b.y.length >> 1]);

  for (const rec of recs) {
    const w = rec.x1 - rec.x0 + 1, h = rec.y1 - rec.y0 + 1;
    const out = new ImageData(w, h);
    const cx = clamp(Math.round(rec.box.x + rec.box.w / 2), 0, W - 1);
    const rule = rec.ruleIdx >= 0 ? rules[rec.ruleIdx] : null;
    const unwarp = p.levelMode > 0.5;
    const theta = Math.atan(rec.slope);
    const cos = Math.cos(theta), sin = Math.sin(theta);
    const mine = (lineIds ? lineIds[rec.line] ?? rec.line : rec.line) + 1;

    for (let oy = 0; oy < h; oy++) {
      for (let ox = 0; ox < w; ox++) {
        const X = rec.x0 + ox, Y = rec.y0 + oy;
        let sx: number, sy: number;
        if (unwarp) {
          // per-column vertical shift following the trace
          const dy = rule
            ? rule.y[clamp(X, 0, W - 1)] - rec.baselineY
            : rec.slope * (X - cx);
          sx = X;
          sy = Y + dy;
        } else {
          // rigid rotation about (cx, baselineY): the leveled frame's
          // horizontal axis maps back onto the baseline direction
          const dx = X - cx, dy = Y - rec.baselineY;
          sx = cx + cos * dx - sin * dy;
          sy = rec.baselineY + sin * dx + cos * dy;
        }
        let v = sampleBilinear(gray, W, H, sx, sy);
        const srcI = clamp(Math.round(sy), 0, H - 1) * W + clamp(Math.round(sx), 0, W - 1);
        if (lineMask) {
          // The mask is looked up at the SAMPLED position (nearest pixel) —
          // the crop is a resampling of the page, so ownership travels with
          // the source, not the output rectangle. The mask's own bridgePx
          // dilation halo covers the bilinear fringe at ink boundaries.
          const mi = lineMask[srcI];
          if (mi && mi !== mine) v = 255; // another line's ink → paper
        }
        if (stripMask && stripMask[srcI]) v = 255; // rule-residue strip → paper
        const o = (oy * w + ox) * 4;
        out.data[o] = out.data[o + 1] = out.data[o + 2] = v;
        out.data[o + 3] = 255;
      }
    }
    rec.crop = out;
    rec.baselineRow = clamp(Math.round(rec.baselineY) - rec.y0, 0, h - 1);
  }
}

/** Running median of row `y` over a ±winhw window (sliding histogram). */
/** Sliding-window median down a row — the histogram AND the median pointer are
 *  both carried, so it is O(1) per pixel instead of O(256). Same rule (the
 *  smallest v whose cumulative count exceeds half the window), same answer;
 *  the twin in clean/trainImport.ts has the longer note. */
function runningMedian(
  gray: Uint8Array, w: number, y: number, winhw: number, out: Uint8Array,
): void {
  const hist = new Uint16Array(256);
  let count = 0;
  for (let x = 0; x <= winhw && x < w; x++) { hist[gray[y * w + x]]++; count++; }
  let med = 0, below = 0;
  for (let x = 0; x < w; x++) {
    if (x > 0) {
      const add = x + winhw, del = x - winhw - 1;
      if (add < w) { const v = gray[y * w + add]; hist[v]++; count++; if (v < med) below++; }
      if (del >= 0) { const v = gray[y * w + del]; hist[v]--; count--; if (v < med) below--; }
    }
    const k = (count >> 1) + 1;
    while (below + hist[med] < k) { below += hist[med]; med++; }
    while (below >= k) { med--; below -= hist[med]; }
    out[x] = med;
  }
}

/** Fill mask==1 pixels by vertical interpolation from mask==0 pixels, then
 *  diffusion-blend them. mask==2 (protected text) is neither filled nor a
 *  fill source. Port of lines.c fill_and_blend, with one deviation: only
 *  LIGHT pixels (gray >= lightMin) qualify as fill/blend sources, so ink
 *  just outside the band can't smear noise into the filled paper. */
function fillAndBlend(
  gray: Uint8Array, w: number, h: number, mask: Uint8Array,
  reach: number, iters: number, lightMin: number,
): void {
  // Row order: the fill reads only mask-0 pixels and writes only mask-1
  // pixels, so the walk's order cannot change the result.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] !== 1) continue;
      const src = (yy: number) =>
        mask[yy * w + x] === 0 && gray[yy * w + x] >= lightMin;
      let ya = -1, yb = -1;
      for (let d = 1; d <= reach; d++) {
        if (ya < 0 && y - d >= 0 && src(y - d)) ya = y - d;
        if (yb < 0 && y + d < h && src(y + d)) yb = y + d;
        if (ya >= 0 && yb >= 0) break;
      }
      let v: number;
      if (ya >= 0 && yb >= 0) {
        const t = (y - ya) / (yb - ya);
        v = gray[ya * w + x] * (1 - t) + gray[yb * w + x] * t;
      } else if (ya >= 0) v = gray[ya * w + x];
      else if (yb >= 0) v = gray[yb * w + x];
      else v = 250;
      gray[y * w + x] = Math.round(v);
    }
  }

  if (iters > 0) {
    let a: Uint8Array = gray, b: Uint8Array = new Uint8Array(gray);
    for (let it = 0; it < iters; it++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (mask[y * w + x] !== 1) continue;
          const y0 = Math.max(y - 1, 0), y1 = Math.min(y + 1, h - 1);
          const x0 = Math.max(x - 1, 0), x1 = Math.min(x + 1, w - 1);
          let sum = 0, cnt = 0;
          for (let yy = y0; yy <= y1; yy++) {
            for (let xx = x0; xx <= x1; xx++) {
              if (yy === y && xx === x) continue;
              const q = yy * w + xx;
              // filled pixels are already light; raw neighbors must be light
              if (mask[q] === 1 || (mask[q] === 0 && a[q] >= lightMin)) {
                sum += a[q]; cnt++;
              }
            }
          }
          b[y * w + x] = cnt ? Math.round(sum / cnt) : a[y * w + x];
        }
      }
      const t = a; a = b; b = t;
    }
    if (a !== gray) gray.set(a);
  }
}

/** Median page-y of a rule trace over the columns [x0,x1] (a word's x-span). */
function ruleMedianY(rule: RuleTrace, x0: number, x1: number): number {
  const n = rule.y.length;
  const a = clamp(x0, 0, n - 1), b = clamp(x1, 0, n - 1);
  const xs: number[] = [];
  for (let x = a; x <= b; x++) xs.push(rule.y[x]);
  if (!xs.length) return rule.y[clamp((x0 + x1) >> 1, 0, n - 1)];
  xs.sort((u, v) => u - v);
  return xs[xs.length >> 1];
}

/**
 * Hysteresis ink mask (à la Canny). A pixel is ink if it is darker than `highT`
 * (a strong seed), OR darker than the gentler `lowT` (highT + slack) AND
 * connected — through other such weak pixels — to a strong one. So a pixel that
 * is not quite dark enough on its own still counts when it is part of a stroke
 * that has a solidly-dark core nearby. Returns 1 = ink, 0 = not.
 */
function hysteresisInk(gray: Uint8Array, w: number, h: number, highT: number, lowT: number): Uint8Array {
  const N = w * h;
  const ink = new Uint8Array(N);
  // typed stack (a pixel is pushed once) and a bounds-free path for interior
  // pixels, neighbours in the general path's order — the flooded set is the
  // same set whatever the order, and only the set is returned
  const stack = new Int32Array(N);
  let sp = 0;
  for (let i = 0; i < N; i++) {
    if (gray[i] < highT) { ink[i] = 1; stack[sp++] = i; }
  }
  const N8 = [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];
  while (sp > 0) {
    const i = stack[--sp];
    const y = (i / w) | 0, x = i - y * w;
    if (x > 0 && x < w - 1 && y > 0 && y < h - 1) {
      for (let k = 0; k < 8; k++) {
        const q = i + N8[k];
        if (!ink[q] && gray[q] < lowT) { ink[q] = 1; stack[sp++] = q; }
      }
      continue;
    }
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const q = yy * w + xx;
        if (!ink[q] && gray[q] < lowT) { ink[q] = 1; stack[sp++] = q; }
      }
    }
  }
  return ink;
}

/**
 * Shape prune for horizontal rule bands: a connected ink shape (8-conn, over ink
 * pixels not already erased as rule) that touches a rule band but never reaches
 * more than `keep` px past it is a rule remnant → erase the whole shape. Baseline
 * bands require the shape to extend ABOVE the band (letters sit above the
 * baseline); other bands (the line above) accept extension on either side. This
 * cleans up the "bits still showing" that the per-pixel pass leaves along a rule.
 */
function pruneHorizontalShapes(
  gray: Uint8Array, w: number, h: number, mask: Uint8Array,
  bands: { row: number; yTop: number; yBot: number }[], baseRow: number,
  ink: Uint8Array, keep: number,
): void {
  const N = w * h;
  const label = new Int32Array(N).fill(-1);
  const isInk = (i: number) => ink[i] === 1 && mask[i] !== 1;
  const minY: number[] = [];
  const maxY: number[] = [];
  const stack: number[] = [];

  for (let s = 0; s < N; s++) {
    if (label[s] !== -1 || !isInk(s)) continue;
    const id = minY.length;
    let lo = h, hi = -1;
    label[s] = id;
    stack.length = 0;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop() as number;
      const y = (i / w) | 0, x = i - y * w;
      if (y < lo) lo = y;
      if (y > hi) hi = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (label[q] === -1 && isInk(q)) { label[q] = id; stack.push(q); }
        }
      }
    }
    minY.push(lo);
    maxY.push(hi);
  }

  const remove = new Uint8Array(minY.length); // default 0; set 1 to erase
  for (let id = 0; id < minY.length; id++) {
    let touches = false, kept = false;
    for (const b of bands) {
      // Consider shapes intersecting the band OR sitting within `keep` px of it,
      // so remnants that leaked just outside the band are still pruned.
      if (maxY[id] < b.yTop - keep || minY[id] > b.yBot + keep) continue;
      touches = true;
      const above = b.yTop - minY[id];
      const below = maxY[id] - b.yBot;
      const pass = b.row === baseRow ? above >= keep : above >= keep || below >= keep;
      if (pass) { kept = true; break; }
    }
    if (touches && !kept) remove[id] = 1;
  }

  for (let i = 0; i < N; i++) {
    const id = label[i];
    if (id >= 0 && remove[id]) mask[i] = 1;
  }
}

/** Stage 3: erase the baseline rule band (and any other rule caught in the crop,
 *  e.g. the line above) from each leveled crop, keeping crossing strokes. Fills
 *  rec.clean and rec.mask. */
export function removeRules(rulesJson: RulesJson, recs: WordRec[], p: Params): void {
  const rules = [...rulesJson.rules]
    .sort((a, b) => a.y[a.y.length >> 1] - b.y[b.y.length >> 1]);
  const winhw = clamp(Math.round(p.rmWindow), 5, 400);
  const maxT = clamp(Math.round(p.rmMaxThick), 1, 40);
  const extend = clamp(Math.round(p.rmExtend), 1, 20);
  const inkSlack = clamp(Math.round(p.inkSlack), 0, 120);

  for (const rec of recs) {
    if (!rec.crop || rec.baselineRow === undefined) continue;
    const w = rec.crop.width, h = rec.crop.height;
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) gray[i] = rec.crop.data[i * 4];
    const mask = new Uint8Array(w * h);
    // Hysteresis ink mask: pixels darker than the ink threshold, plus lighter
    // pixels flooded from them (anti-aliased stroke edges / faint stroke parts).
    // Used for every "is this pixel part of a stroke" test below.
    const ink = hysteresisInk(gray, w, h, p.inkThreshold, p.inkThreshold + inkSlack);

    // Bands to erase in this crop: the word's baseline rule PLUS any other rule
    // (typically the line-above rule) whose straightened row lands in — or just
    // outside — the crop. Leveling preserves vertical distances, so a rule at
    // page-y `ry` sits at crop row baseRow + (ry - baselineY). Same removal +
    // rescue is applied to every band.
    const baseRow: number = rec.baselineRow;
    const med = new Uint8Array(w);
    // Expected rule colour at each band pixel (running median), kept so the
    // connectivity rescue below can use a gentler "darker than the rule"
    // threshold than the hard outlier test.
    const expected = new Float32Array(w * h);
    const bandPad = Math.round(p.rmBandPad);
    const nearSlack = bandPad + 2; // "in OR close to the box"

    interface Band { row: number; hb: number; yTop: number; yBot: number; reach: number }
    const bands: Band[] = [];
    const addBand = (rowF: number, thickRaw: number) => {
      const row = Math.round(rowF);
      const t = Math.min(thickRaw, maxT);
      const hb = Math.max(1, t >> 1) + bandPad;
      // Skip rules whose band doesn't overlap (or nearly touch) the crop rows.
      if (row + hb < -nearSlack || row - hb > h - 1 + nearSlack) return;
      bands.push({ row, hb, yTop: row - hb, yBot: row + hb, reach: hb * 2 + extend + maxT });
    };

    if (rec.ruleIdx >= 0) addBand(baseRow, rules[rec.ruleIdx].thickness);
    for (let j = 0; j < rules.length; j++) {
      if (j === rec.ruleIdx) continue;
      const ry = ruleMedianY(rules[j], rec.x0, rec.x1);
      addBand(baseRow + (ry - rec.baselineY), rules[j].thickness);
    }

    if (bands.length) {
      for (const band of bands) {
        for (let off = -band.hb; off <= band.hb; off++) {
          const y = band.row + off;
          if (y < 0 || y >= h) continue;
          runningMedian(gray, w, y, winhw, med);
          for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const v = gray[i];
            expected[i] = med[x];
            // test 1: radically darker than the expected rule color
            const outlier = v + p.rmDelta < med[x];
            let isText = outlier;
            // test 2: dark run extends beyond the band (crossing stroke)
            if (isText) {
              let up = y, down = y;
              while (up > 0 && y - up < band.reach && ink[(up - 1) * w + x])
                up--;
              while (down < h - 1 && down - y < band.reach && ink[(down + 1) * w + x])
                down++;
              isText = band.yTop - up >= extend || down - band.yBot >= extend;
            }
            mask[i] = isText ? 2 : 1;
          }
        }
      }

      // Connectivity rescue: keep any band pixel that is darker than the rule
      // (by the gentler rmRescueDelta) when it connects — in ANY direction, and
      // across small light gaps up to `bridge` px — to text: a protected crossing
      // stroke (mask 2) or ink just outside the band (a stroke above/below the
      // rule). Multi-source flood over the rescuable pixels until nothing new is
      // reachable, bounded to rmGrow px so a long noisy rule can't rescue itself
      // end to end. This replaces the old 8-way single-pixel BFS so a letter
      // sitting ON the rule (whose ink is only faintly darker than, and slightly
      // separated from, the printed line) is preserved instead of erased.
      const growLimit = Math.round(p.rmGrow);
      if (growLimit > 0) {
        const bridge = clamp(Math.round(p.rmGapBridge), 1, 8);
        const rescueDelta = clamp(p.rmRescueDelta, 0, 120);
        // A still-erased band pixel meaningfully darker than its expected rule
        // colour (mask 1 ⟹ a band pixel, so `expected` is set for it).
        const rescuable = (i: number) =>
          mask[i] === 1 && gray[i] + rescueDelta < expected[i];
        const isSource = (i: number) =>
          mask[i] === 2 || (mask[i] === 0 && ink[i] === 1);
        const dist = new Int32Array(w * h).fill(-1);
        const queue: number[] = [];

        // First pass: rescuable pixels within `bridge` of a text source (the
        // "connect to ink above/below the rule" seeds).
        for (let i = 0; i < w * h; i++) {
          if (!rescuable(i)) continue;
          const x = i % w, y = (i / w) | 0;
          let best = -1;
          for (let dy = -bridge; dy <= bridge; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            for (let dx = -bridge; dx <= bridge; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= w) continue;
              if (isSource(yy * w + xx)) {
                const d = Math.max(Math.abs(dx), Math.abs(dy));
                if (best < 0 || d < best) best = d;
              }
            }
          }
          if (best >= 0 && best <= growLimit) {
            mask[i] = 2;
            dist[i] = best;
            queue.push(i);
          }
        }

        // Keep passing: pull in rescuable neighbours (horizontal/diagonal, across
        // gaps up to `bridge`) off already-kept pixels until none remain in reach.
        for (let qi = 0; qi < queue.length; qi++) {
          const i = queue[qi];
          const di = dist[i];
          if (di >= growLimit) continue;
          const x = i % w, y = (i / w) | 0;
          for (let dy = -bridge; dy <= bridge; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            for (let dx = -bridge; dx <= bridge; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= w) continue;
              const q = yy * w + xx;
              if (dist[q] >= 0 || !rescuable(q)) continue;
              const nd = di + Math.max(Math.abs(dx), Math.abs(dy));
              if (nd > growLimit) continue;
              mask[q] = 2;
              dist[q] = nd;
              queue.push(q);
            }
          }
        }
      }

      // Shape-level cleanup: drop rule remnants (shapes hugging a rule that never
      // reach past it). Runs after the per-pixel rescue so leftover bits go too.
      const keepPast = clamp(Math.round(p.rmShapePrune), 0, 40);
      if (keepPast > 0) pruneHorizontalShapes(gray, w, h, mask, bands, baseRow, ink, keepPast);

      fillAndBlend(gray, w, h, mask, maxT * 4 + 4,
        clamp(Math.round(p.rmInpaint), 0, 30), p.inkThreshold);
    }

    const clean = new ImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      clean.data[o] = clean.data[o + 1] = clean.data[o + 2] = gray[i];
      clean.data[o + 3] = 255;
    }
    rec.clean = clean;
    rec.mask = mask;
  }
}

/**
 * Erase vertical rule bands (the printed margin, incl. double margins) from the
 * FULL-PAGE grayscale, keeping crossing strokes. This is the column-wise
 * analogue of `removeRules`, run once on the page BEFORE the per-word stages —
 * `removeRules` only ever touches each word's horizontal baseline band, so
 * without this a vertical line inside a crop (typically the margin, in the
 * leftmost words) survives into the output. Mutates `gray` in place.
 *
 * Follows each vrule's x-per-row trace. A band pixel is kept as text only if it
 * is radically darker than the line's expected colour AND its horizontal dark
 * run extends beyond the band (a crossing stroke continues; the rule doesn't);
 * everything else is erased and horizontally in-filled from the light paper on
 * either side.
 */
export function removeVRules(
  gray: Uint8Array, W: number, H: number, rulesJson: RulesJson, p: Params,
): void {
  const vrules = rulesJson.vrules ?? [];
  if (!vrules.length) return;
  const rules = rulesJson.rules;
  const maxT = clamp(Math.round(p.rmMaxThick), 1, 40);
  const extend = clamp(Math.round(p.rmExtend), 1, 20);
  const inkT = p.inkThreshold;
  const inkSlack = clamp(Math.round(p.inkSlack), 0, 120);
  // Hysteresis ink mask for the page (computed once from the original ink), used
  // by the run test + shape prune so anti-aliased stroke edges count as stroke.
  const ink = hysteresisInk(gray, W, H, inkT, inkT + inkSlack);

  for (const v of vrules) {
    if (v.x.length < H) continue;
    const thick = Math.min(v.thickness, maxT);
    // +1 px over the half-thickness so trace drift / slightly thicker spots are
    // still fully covered (a partly-covered line leaves a residual mark).
    const hb = Math.max(1, thick >> 1) + Math.round(p.rmBandPad) + 1;
    const reach = hb * 2 + extend + maxT;
    const mask = new Uint8Array(W * H); // 0 untouched, 1 erase, 2 protected text

    // expected line colour per band offset (median down the trace)
    const expected = new Uint8Array(2 * hb + 1);
    for (let off = -hb; off <= hb; off++) {
      const samples: number[] = [];
      for (let y = 0; y < H; y++) {
        const x = Math.round(v.x[y]) + off;
        if (x >= 0 && x < W) samples.push(gray[y * W + x]);
      }
      expected[off + hb] = samples.length ? percentile(samples, 50) : 250;
    }

    // classify each band pixel: darker-than-expected AND no horizontal run-out.
    // EXCEPTION: where this vertical rule crosses a horizontal rule, the
    // horizontal rule itself provides the "run-out", falsely protecting the
    // intersection. Pass A removes H×V intersections unconditionally, so we do
    // too — otherwise a mark survives at every crossing.
    for (let y = 0; y < H; y++) {
      const cx = Math.round(v.x[y]);
      // is this row inside any horizontal rule's band (at this column)?
      let onHRule = false;
      for (const r of rules) {
        if (cx >= r.y.length) continue;
        const rhb = Math.min(r.thickness, maxT) / 2 + Math.round(p.rmBandPad) + 1;
        if (Math.abs(y - r.y[cx]) <= rhb) { onHRule = true; break; }
      }
      for (let off = -hb; off <= hb; off++) {
        const x = cx + off;
        if (x < 0 || x >= W) continue;
        if (onHRule) { mask[y * W + x] = 1; continue; } // intersection: always erase
        const outlier = gray[y * W + x] + p.rmDelta < expected[off + hb];
        let isText = outlier;
        if (isText) {
          let left = x, right = x;
          while (left > 0 && x - left < reach && ink[y * W + left - 1]) left--;
          while (right < W - 1 && right - x < reach && ink[y * W + right + 1]) right++;
          isText = (cx - hb) - left >= extend || right - (cx + hb) >= extend;
        }
        mask[y * W + x] = isText ? 2 : 1;
      }
    }

    // Shape prune: erase ink shapes hugging the vertical rule that never reach
    // more than `keep` px past the band (rule remnants). Restricted to a window
    // around the trace, so a crossing stroke — which reaches the window edge —
    // is kept while a blob lying along the margin is dropped. Same idea as the
    // horizontal pruneHorizontalShapes, done column-wise on the full page.
    const keep = clamp(Math.round(p.rmShapePrune), 0, 40);
    if (keep > 0) {
      const winHalf = hb + keep + 2;
      const visited = new Uint8Array(W * H);
      const isInk = (idx: number) => ink[idx] === 1 && mask[idx] !== 1;
      const nearRule = (x: number, y: number) => Math.abs(x - Math.round(v.x[y])) <= winHalf;
      const stack: number[] = [];
      for (let y = 0; y < H; y++) {
        const cx = Math.round(v.x[y]);
        for (let off = -winHalf; off <= winHalf; off++) {
          const sx = cx + off;
          if (sx < 0 || sx >= W) continue;
          const s = y * W + sx;
          if (visited[s] || !isInk(s)) continue;
          // Flood this shape within the window; track max horizontal distance
          // from the rule and remember its pixels.
          stack.length = 0;
          stack.push(s);
          visited[s] = 1;
          const pix: number[] = [];
          let maxDist = 0;
          while (stack.length) {
            const i = stack.pop() as number;
            const yy = (i / W) | 0, xx = i - yy * W;
            pix.push(i);
            const d = Math.abs(xx - Math.round(v.x[yy]));
            if (d > maxDist) maxDist = d;
            for (let dy = -1; dy <= 1; dy++) {
              const ny = yy + dy;
              if (ny < 0 || ny >= H) continue;
              for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue;
                const nx = xx + dx;
                if (nx < 0 || nx >= W) continue;
                const q = ny * W + nx;
                if (!visited[q] && isInk(q) && nearRule(nx, ny)) { visited[q] = 1; stack.push(q); }
              }
            }
          }
          if (maxDist <= hb + keep) for (const i of pix) mask[i] = 1; // remnant → erase
        }
      }
    }

    // erase (mask 1) by filling from the LIGHTER paper side (not a blend of the
    // two) so nothing darker than the surrounding paper is left behind.
    for (let y = 0; y < H; y++) {
      const cx = Math.round(v.x[y]);
      for (let off = -hb; off <= hb; off++) {
        const x = cx + off;
        if (x < 0 || x >= W || mask[y * W + x] !== 1) continue;
        let xa = -1, xb = -1;
        for (let d = 1; d <= reach; d++) {
          if (xa < 0 && x - d >= 0 && mask[y * W + x - d] === 0 && gray[y * W + x - d] >= inkT) xa = x - d;
          if (xb < 0 && x + d < W && mask[y * W + x + d] === 0 && gray[y * W + x + d] >= inkT) xb = x + d;
          if (xa >= 0 && xb >= 0) break;
        }
        let nv: number;
        if (xa >= 0 && xb >= 0) nv = Math.max(gray[y * W + xa], gray[y * W + xb]);
        else if (xa >= 0) nv = gray[y * W + xa];
        else if (xb >= 0) nv = gray[y * W + xb];
        else nv = 250;
        gray[y * W + x] = Math.round(nv);
      }
    }
  }
}

/**
 * Scrub vertical-rule RESIDUE from the CLEAN (stage-8, binarized) page before
 * word segmentation. Pass A erases the traced vrules, but imperfect edges can
 * leave small dark blobs hugging the band; the segmenter reads everything —
 * word boxes, ink mask, orphan absorption — from this page, so a residue
 * blob gets absorbed into the line's first word and drags its box left over
 * where the rule was. Every dark component seeded on or near a vrule band is
 * erased unless it reaches at least `minExtend` px past the rule's edge on
 * either side (a crossing stroke does; residue doesn't). Mutates `clean`.
 */
export function removeVRuleResidue(
  clean: ImageData, rulesJson: RulesJson, p: Params, minExtend = 5,
): void {
  const vrules = rulesJson.vrules ?? [];
  if (!vrules.length) return;
  const { width: W, height: H, data } = clean;
  const maxT = clamp(Math.round(p.rmMaxThick), 1, 40);
  const dark = (i: number) => data[i * 4] < 128;
  const stack: number[] = [];
  const px: number[] = [];

  for (const v of vrules) {
    if (v.x.length < H) continue;
    const half = Math.max(1, Math.min(v.thickness, maxT) >> 1);
    // Seed anywhere the removeVRules erase band could have left residue, plus
    // the keep margin itself ("next to" the rule, not just touching it).
    const seedPad = half + Math.round(p.rmBandPad) + minExtend;
    // Fresh per vrule: a component kept for one line must still be judged
    // against the next (double margins).
    const visited = new Uint8Array(W * H);

    for (let y = 0; y < H; y++) {
      const cx = Math.round(v.x[y]);
      const sx0 = Math.max(0, cx - seedPad), sx1 = Math.min(W - 1, cx + seedPad);
      for (let sx = sx0; sx <= sx1; sx++) {
        const start = y * W + sx;
        if (visited[start] || !dark(start)) continue;
        // Flood-fill the whole component, measuring its farthest reach past
        // the rule edge per-row (the trace drifts, so no single x cutoff).
        visited[start] = 1;
        stack.length = 0;
        px.length = 0;
        stack.push(start);
        let reach = -Infinity;
        while (stack.length) {
          const i = stack.pop()!;
          px.push(i);
          const ix = i % W, iy = (i / W) | 0;
          const c = Math.round(v.x[iy]);
          const out = Math.max(ix - (c + half), (c - half) - ix);
          if (out > reach) reach = out;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              const nx = ix + dx, ny = iy + dy;
              if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
              const j = ny * W + nx;
              if (!visited[j] && dark(j)) { visited[j] = 1; stack.push(j); }
            }
          }
        }
        if (reach < minExtend) {
          for (const i of px) {
            const o = i * 4;
            data[o] = data[o + 1] = data[o + 2] = 255;
          }
        }
      }
    }
  }
}

/** Classification tint of a cleaned crop (removed = red, protected = green),
 *  same rendering as better's stage-6 preview. */
export function tintClean(rec: WordRec): ImageData | undefined {
  if (!rec.clean || !rec.mask) return rec.clean;
  const { width: w, height: h } = rec.clean;
  const out = new ImageData(w, h);
  out.data.set(rec.clean.data);
  for (let i = 0; i < w * h; i++) {
    const m = rec.mask[i];
    if (!m) continue;
    const o = i * 4, v = rec.clean.data[o];
    if (m === 1) {
      out.data[o] = v + ((255 - v) * 45) / 100;
      out.data[o + 1] = (v * 62) / 100;
      out.data[o + 2] = (v * 62) / 100;
    } else {
      out.data[o] = (v * 62) / 100;
      out.data[o + 1] = v + ((255 - v) * 55) / 100;
      out.data[o + 2] = (v * 62) / 100;
    }
  }
  return out;
}

/** Stage 4: measure core height and stroke thickness on the cleaned crop. */
export function measureWords(recs: WordRec[], p: Params): void {
  for (const rec of recs) {
    rec.measure = undefined;
    if (!rec.clean || rec.baselineRow === undefined) continue;
    const { width: w, height: h } = rec.clean;
    const bl = rec.baselineRow;
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) gray[i] = rec.clean.data[i * 4];

    // ink row-projection above the baseline, box-smoothed
    const raw = new Array<number>(bl).fill(0);
    for (let y = 0; y < bl; y++)
      for (let x = 0; x < w; x++)
        if (gray[y * w + x] < p.inkThreshold) raw[y]++;
    const rad = Math.round(p.xhSmooth);
    const proj = raw.map((_, y) => {
      let s = 0, n = 0;
      for (let d = -rad; d <= rad; d++)
        if (y + d >= 0 && y + d < bl) { s += raw[y + d]; n++; }
      return n ? s / n : 0;
    });
    const projMax = Math.max(0, ...proj);
    if (projMax === 0) continue; // no ink above the baseline

    // x-height band: among contiguous runs of rows with projection >= the
    // threshold, take the one with the largest ink mass (the core letters);
    // ascender-only runs are narrow and lose
    const thresh = p.xhFrac * projMax;
    let bandTop = bl - 1, bestSum = -1;
    for (let y = 0; y < bl;) {
      if (proj[y] < thresh) { y++; continue; }
      const top = y;
      let sum = 0;
      while (y < bl && proj[y] >= thresh) { sum += raw[y]; y++; }
      if (sum > bestSum) { bestSum = sum; bandTop = top; }
    }
    const xHeight = bl - bandTop;

    // ascent / descent from raw ink extents
    let topInk = -1, botInk = -1;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (gray[y * w + x] < p.inkThreshold) {
          if (topInk < 0) topInk = y;
          botInk = y;
          break;
        }
    const ascent = topInk >= 0 ? Math.max(0, bl - topInk) : 0;
    const descent = botInk >= 0 ? Math.max(0, botInk - bl) : 0;

    // thickness: median over dark pixels of min(horizontal, vertical run),
    // at a stricter cutoff so anti-aliased edges don't inflate the runs
    const thickness = runThickness(gray, w, h, p.thickDark);

    rec.measure = { xHeight, ascent, descent, thickness, proj, projMax };
  }
}

/** Stroke thickness: median over pixels darker than `cut` of
 *  min(horizontal dark-run, vertical dark-run) through the pixel. */
export function runThickness(
  gray: Uint8Array, w: number, h: number, cut: number,
): number {
  const dark = (i: number) => gray[i] < cut;
  const hrun = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w;) {
      if (!dark(y * w + x)) { x++; continue; }
      const x0 = x;
      while (x < w && dark(y * w + x)) x++;
      for (let k = x0; k < x; k++) hrun[y * w + k] = x - x0;
    }
  }
  // The median of min(horizontal, vertical run) over dark pixels — counted
  // into a histogram of run lengths (a run is at most the crop's longer side)
  // rather than collected and selected: the same k-th smallest value.
  const hist = new Int32Array(Math.max(w, h) + 1);
  let n = 0;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h;) {
      if (!dark(y * w + x)) { y++; continue; }
      const y0 = y;
      while (y < h && dark(y * w + x)) y++;
      const vrun = y - y0;
      for (let k = y0; k < y; k++) {
        const hr = hrun[k * w + x];
        hist[hr < vrun ? hr : vrun]++;
        n++;
      }
    }
  }
  if (!n) return 0;
  const k = clamp(Math.round(0.5 * (n - 1)), 0, n - 1);
  let seen = 0;
  for (let v = 0; v < hist.length; v++) {
    seen += hist[v];
    if (seen > k) return v;
  }
  return hist.length - 1;
}

/** Stage 5: rescale each cleaned crop so its x-height matches the page
 *  median, clamped to 1 ± scaleClamp. Returns the target x-height. */
export function normalizeHeights(recs: WordRec[], p: Params): number {
  const xhs = recs
    .filter((r) => r.measure && r.measure.xHeight > 0)
    .map((r) => r.measure!.xHeight);
  const targetXh = xhs.length ? percentile(xhs, 50) : 0;

  for (const rec of recs) {
    rec.scale = 1;
    rec.scaled = undefined;
    rec.scaledBaselineRow = rec.baselineRow;
    if (!rec.clean || rec.baselineRow === undefined) continue;

    let s = 1;
    if (targetXh > 0 && rec.measure && rec.measure.xHeight > 0)
      s = clamp(targetXh / rec.measure.xHeight, 1 - p.scaleClamp, 1 + p.scaleClamp);
    rec.scale = s;

    const w = rec.clean.width, h = rec.clean.height;
    const ow = Math.max(1, Math.round(w * s));
    const oh = Math.max(1, Math.round(h * s));
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) gray[i] = rec.clean.data[i * 4];

    const out = new ImageData(ow, oh);
    for (let oy = 0; oy < oh; oy++) {
      for (let ox = 0; ox < ow; ox++) {
        const v = sampleBilinear(gray, w, h, ox / s, oy / s);
        const o = (oy * ow + ox) * 4;
        out.data[o] = out.data[o + 1] = out.data[o + 2] = v;
        out.data[o + 3] = 255;
      }
    }
    rec.scaled = out;
    rec.scaledBaselineRow = clamp(Math.round(rec.baselineRow * s), 0, oh - 1);
  }
  return targetXh;
}

/* ---------- signed distance field (shared by stages 6 and 7) ---------- */

const EDT_INF = 1e12;

/** 1D squared distance transform (Felzenszwalb & Huttenlocher).
 *  The three work arrays are module scratch, grown on demand: `edt` calls
 *  this once per column and once per row of every crop and copies the result
 *  out before the next call, so nothing is ever live across two calls. */
let dtD = new Float64Array(0);
let dtV = new Int32Array(0);
let dtZ = new Float64Array(0);
function dt1d(f: Float64Array, n: number): Float64Array {
  if (dtD.length < n) {
    dtD = new Float64Array(n);
    dtV = new Int32Array(n);
    dtZ = new Float64Array(n + 1);
  }
  const d = dtD, v = dtV, z = dtZ;
  let k = 0;
  v[0] = 0; z[0] = -EDT_INF; z[1] = EDT_INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q; z[k] = s; z[k + 1] = EDT_INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
  return d;
}

/** Exact Euclidean distance (px) to the nearest feature pixel. */
function edt(feature: Uint8Array, w: number, h: number): Float32Array {
  const f = new Float64Array(Math.max(w, h));
  const colSq = new Float64Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = feature[y * w + x] ? 0 : EDT_INF;
    const d = dt1d(f.subarray(0, h) as Float64Array, h);
    for (let y = 0; y < h; y++) colSq[y * w + x] = d[y];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = colSq[y * w + x];
    const d = dt1d(f.subarray(0, w) as Float64Array, w);
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]);
  }
  return out;
}

export interface Sdf {
  d: Float32Array; // signed px distance to the ink surface; negative inside
  ink: number;     // per-word ink core gray level
  paper: number;   // per-word paper gray level
}

/** Width (px) of the anti-aliased edge assumed when READING sub-pixel
 *  boundary positions from the gray ramp. Independent of the rendered edge
 *  softness so softening the output can't distort the geometry. */
const DETECT_EDGE = 1.2;

export interface InkLevels { ink: number; paper: number }

/** Per-word ink core / paper gray levels. Null if the crop has no ink.
 *  inkOverride > 0 forces the ink level. */
export function estimateLevels(gray: Uint8Array, inkOverride = 0): InkLevels | null {
  // One histogram answers all three questions (the darkest gray, the median
  // of the near-darkest band, the median of the bright band) — the same
  // medians the collected-array form selected, read off the counts.
  const hist = new Int32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  let minG = 255;
  for (let v = 0; v < 256; v++) if (hist[v]) { minG = v; break; }
  const medianIn = (lo: number, hi: number): number => {
    let n = 0;
    for (let v = lo; v <= hi; v++) n += hist[v];
    if (!n) return -1;
    const k = clamp(Math.round(0.5 * (n - 1)), 0, n - 1);
    let seen = 0;
    for (let v = lo; v <= hi; v++) { seen += hist[v]; if (seen > k) return v; }
    return hi;
  };
  const brightMed = medianIn(230, 255);
  const paper = brightMed >= 0 ? brightMed : 250;
  if (minG > paper - 60) return null; // no real ink
  const ink = inkOverride > 0 ? inkOverride : medianIn(minG, Math.min(255, minG + 30));
  return { ink, paper };
}

/** The gray value at ink-coverage `surface` — pixels darker than this are
 *  inside the stroke boundary that the SDF moves. */
export function surfaceCut(levels: InkLevels, surface: number): number {
  return levels.paper - surface * (levels.paper - levels.ink);
}

/** Sub-pixel signed distance field of the ink in a grayscale crop: exact
 *  EDT away from the boundary, the anti-aliased gray ramp near it. The
 *  boundary sits at ink-coverage `surface` (0.5 = halfway gray). */
export function buildSdf(
  gray: Uint8Array, w: number, h: number, levels: InkLevels, surface: number,
): Sdf {
  const { ink, paper } = levels;
  const alpha = new Float32Array(w * h); // ink coverage, 0..1
  const inside = new Uint8Array(w * h);
  const outside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = (paper - gray[i]) / (paper - ink);
    alpha[i] = a < 0 ? 0 : a > 1 ? 1 : a;
    inside[i] = alpha[i] >= surface ? 1 : 0;
    outside[i] = inside[i] ^ 1;
  }
  const toInk = edt(inside, w, h);
  const toPaper = edt(outside, w, h);
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    d[i] = inside[i] ? -(toPaper[i] - 0.5) : toInk[i] - 0.5;
    // near the surface the gray ramp carries sub-pixel position
    if (d[i] >= -1 && d[i] <= 1) d[i] = (surface - alpha[i]) * DETECT_EDGE;
  }
  return { d, ink, paper };
}

/** Inside the surface, coverage saturates to 1 within this depth (px) —
 *  independent of edge softness, so the ridge/centerline of even a
 *  hairline stroke always renders at full ink darkness. */
const INNER_EDGE = 0.8;

/** Render an SDF back to grayscale with the surface moved outward by
 *  `offset` px (negative = thinner). The AA ramp is asymmetric: edgeW-wide
 *  falloff outside the surface, but full darkness within INNER_EDGE/2
 *  inside it. */
export function renderSdf(
  sdf: Sdf, w: number, h: number, offset: number, edgeW: number,
): ImageData {
  const out = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const dd = sdf.d[i] - offset;
    let a = dd >= 0 ? 0.5 - dd / edgeW : 0.5 - dd / INNER_EDGE;
    a = a < 0 ? 0 : a > 1 ? 1 : a;
    const v = Math.round(sdf.paper - a * (sdf.paper - sdf.ink));
    const o = i * 4;
    out.data[o] = out.data[o + 1] = out.data[o + 2] = v;
    out.data[o + 3] = 255;
  }
  return out;
}

/** Darkness normalization: push `pct`% of a rendered crop's stroke pixels
 *  (gray < cut) to maximum black. The black point is set at that percentile
 *  of the stroke-darkness distribution, and the remap is anchored at the
 *  paper level: pixels at or above `paper` are untouched (background stays
 *  fully transparent), darker pixels interpolate down to pure black — so
 *  darkening focuses entirely on the dark pixels. In place. */
export function normalizeDarkness(
  img: ImageData, cut: number, pct: number, paper: number,
): void {
  const n = img.width * img.height;
  const hist = new Int32Array(256);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const g = img.data[i * 4];
    if (g < cut) { hist[g]++; count++; }
  }
  if (!count) return;
  // the pct-th percentile of the stroke grays, off the histogram
  const k = clamp(Math.round((pct / 100) * (count - 1)), 0, count - 1);
  let bp = 255, seen = 0;
  for (let v = 0; v < 256; v++) { seen += hist[v]; if (seen > k) { bp = v; break; } }
  if (bp <= 0 || paper - bp <= 0) return;
  const scale = paper / (paper - bp);
  for (let i = 0; i < n; i++) {
    const g = img.data[i * 4];
    if (g >= paper) continue; // background untouched
    const v = g <= bp ? 0 : Math.round((g - bp) * scale);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
  }
}

/** Per-pixel local stroke thickness: 2 × the inside-depth of the nearest
 *  ridge (3×3 local maximum of the depth map). Ridge depths propagate
 *  outward via chamfer passes carrying the source value, then get a light
 *  blur so the offset field changes smoothly along a stroke. */
export function localThickness(
  d: Float32Array, w: number, h: number, fallback: number,
): Float32Array {
  const n = w * h;
  const D = new Float32Array(n);
  for (let i = 0; i < n; i++) D[i] = d[i] < 0 ? -d[i] : 0;

  const INF = 1e9;
  const dist = new Float32Array(n).fill(INF);
  const val = new Float32Array(n);
  let any = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (D[i] <= 0) continue;
      let ridge = true;
      for (let dy = -1; dy <= 1 && ridge; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
          if (D[yy * w + xx] > D[i] + 1e-6) { ridge = false; break; }
        }
      }
      if (ridge) { dist[i] = 0; val[i] = D[i]; any = true; }
    }
  }
  const out = new Float32Array(n).fill(fallback);
  if (!any) return out;

  // two chamfer sweeps ×2: nearest-ridge distance with value carry (the four
  // relaxations are written out, in the same order, so the hot loop makes no
  // calls)
  const D1 = 1, D2 = Math.SQRT2;
  for (let it = 0; it < 2; it++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let di = dist[i];
        if (x > 0) { const q = i - 1; const c = dist[q] + D1; if (c < di) { di = c; val[i] = val[q]; } }
        if (y > 0) { const q = i - w; const c = dist[q] + D1; if (c < di) { di = c; val[i] = val[q]; } }
        if (x > 0 && y > 0) { const q = i - w - 1; const c = dist[q] + D2; if (c < di) { di = c; val[i] = val[q]; } }
        if (x < w - 1 && y > 0) { const q = i - w + 1; const c = dist[q] + D2; if (c < di) { di = c; val[i] = val[q]; } }
        dist[i] = di;
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        let di = dist[i];
        if (x < w - 1) { const q = i + 1; const c = dist[q] + D1; if (c < di) { di = c; val[i] = val[q]; } }
        if (y < h - 1) { const q = i + w; const c = dist[q] + D1; if (c < di) { di = c; val[i] = val[q]; } }
        if (x < w - 1 && y < h - 1) { const q = i + w + 1; const c = dist[q] + D2; if (c < di) { di = c; val[i] = val[q]; } }
        if (x > 0 && y < h - 1) { const q = i + w - 1; const c = dist[q] + D2; if (c < di) { di = c; val[i] = val[q]; } }
        dist[i] = di;
      }
    }
  }
  for (let i = 0; i < n; i++) out[i] = dist[i] < INF ? 2 * val[i] : fallback;
  boxBlur(out, w, h, 1);
  return out;
}

/** Stage 6: move every word's stroke surface toward the target thickness
 *  (tnTarget, or the page median when 0), capped at ±tnMaxChange/2 px per
 *  side. Thickness is measured on the scaled crop at the SAME coverage
 *  surface the SDF moves (not stage 4's fixed cutoff), so applied offsets
 *  land on target. The offset is a per-pixel field driven by local
 *  thickness: only parts on the wrong side of the target move.
 *  Returns the target thickness. */
export function normalizeThickness(
  recs: WordRec[], p: Params,
  /** Render `rec.thick` (the un-smoothed thickness-normalized crop) for words
   *  that have an SDF. `smoothWords` re-renders those from `sdfAdj`, so a
   *  caller that only wants `rec.smooth` — cleanPage — skips this render;
   *  words without ink still get their pass-through `thick`. */
  renderThick = true,
): number {
  // pass 1: levels + surface-consistent thickness per word
  const grays = new Map<number, Uint8Array>();
  for (const rec of recs) {
    rec.thick = undefined;
    rec.thickCur = undefined;
    rec.thickOffset = 0;
    rec.sdf = undefined;
    rec.sdfAdj = undefined;
    if (!rec.scaled) continue;
    const { width: w, height: h } = rec.scaled;
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) gray[i] = rec.scaled.data[i * 4];
    grays.set(rec.index, gray);
    const levels = estimateLevels(gray, p.tnInk);
    if (!levels) continue;
    const t = runThickness(gray, w, h, surfaceCut(levels, p.tnSurface));
    if (t > 0) rec.thickCur = t;
  }
  const ts = recs.filter((r) => r.thickCur).map((r) => r.thickCur!);
  const target = p.tnTarget > 0 ? p.tnTarget : ts.length ? percentile(ts, 50) : 0;

  // pass 2: adaptive per-pixel offset and re-render
  const half = p.tnMaxChange / 2;
  for (const rec of recs) {
    if (!rec.scaled) continue;
    const { width: w, height: h } = rec.scaled;
    const gray = grays.get(rec.index)!;
    const levels = estimateLevels(gray, p.tnInk);
    if (!levels || !rec.thickCur || target <= 0) { // no ink: pass through
      rec.thick = new ImageData(new Uint8ClampedArray(rec.scaled.data), w, h);
      continue;
    }
    rec.sdf = buildSdf(gray, w, h, levels, p.tnSurface);
    const tloc = localThickness(rec.sdf.d, w, h, rec.thickCur);
    const dAdj = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const o = clamp((target - tloc[i]) / 2, -half, half);
      dAdj[i] = rec.sdf.d[i] - o;
    }
    rec.sdfAdj = { d: dAdj, ink: rec.sdf.ink, paper: rec.sdf.paper };
    rec.thickOffset = clamp((target - rec.thickCur) / 2, -half, half);
    if (!renderThick) continue;
    rec.thick = renderSdf(rec.sdfAdj, w, h, 0, p.tnEdge);
    if (p.dkPct > 0)
      normalizeDarkness(rec.thick, surfaceCut(levels, p.tnSurface), p.dkPct,
        levels.paper);
  }
  return target;
}

/** Background-removed render of each scaled crop straight from its SDF with
 *  ZERO offset — the word exactly as measured, no thickness normalization.
 *  Paper maps to pure white so only the ink remains. */
export function cleanRenders(recs: WordRec[], p: Params): void {
  for (const rec of recs) {
    rec.bgclean = undefined;
    if (!rec.sdf || !rec.scaled) continue;
    const { width: w, height: h } = rec.scaled;
    const img = renderSdf(rec.sdf, w, h, 0, p.tnEdge);
    if (p.dkPct > 0)
      normalizeDarkness(img, surfaceCut(rec.sdf, p.tnSurface), p.dkPct, rec.sdf.paper);
    const k = 255 / Math.max(rec.sdf.paper, 1);
    for (let i = 0; i < w * h; i++) {
      const v = Math.min(255, Math.round(img.data[i * 4] * k));
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    }
    rec.bgclean = img;
  }
}

/** Separable box blur with replicated edges, in place. */
export function boxBlur(d: Float32Array, w: number, h: number, r: number): void {
  const tmp = new Float32Array(Math.max(w, h));
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += d[row + clamp(k, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[x] = sum * norm;
      sum += d[row + clamp(x + r + 1, 0, w - 1)] - d[row + clamp(x - r, 0, w - 1)];
    }
    for (let x = 0; x < w; x++) d[row + x] = tmp[x];
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += d[clamp(k, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      tmp[y] = sum * norm;
      sum += d[clamp(y + r + 1, 0, h - 1) * w + x] - d[clamp(y - r, 0, h - 1) * w + x];
    }
    for (let y = 0; y < h; y++) d[y * w + x] = tmp[y];
  }
}

/** Stage 7 (SDF finisher): blur the offset SDF and re-render. Blurring the
 *  distance field smooths every level set consistently — contours cannot
 *  cross — so stroke wobble rounds off while thickness stays put. */
export function smoothWords(recs: WordRec[], p: Params): void {
  const r = Math.round(p.smRadius);
  for (const rec of recs) {
    rec.smooth = undefined;
    if (!rec.scaled) continue;
    if (!rec.sdfAdj) { // pass-through words (no ink)
      if (rec.thick)
        rec.smooth = new ImageData(new Uint8ClampedArray(rec.thick.data),
          rec.thick.width, rec.thick.height);
      continue;
    }
    const { width: w, height: h } = rec.scaled;
    const dd = Float32Array.from(rec.sdfAdj.d);
    if (r > 0) { boxBlur(dd, w, h, r); boxBlur(dd, w, h, r); }
    rec.smooth = renderSdf(
      { d: dd, ink: rec.sdfAdj.ink, paper: rec.sdfAdj.paper }, w, h, 0, p.tnEdge);
    if (p.dkPct > 0)
      normalizeDarkness(rec.smooth, surfaceCut(rec.sdfAdj, p.tnSurface), p.dkPct,
        rec.sdfAdj.paper);
  }
}

export interface CompositeTile { x: number; y: number; w: number; h: number; idx: number }

/** Stage 8: composite finished words onto a blank W×H page. Returns the
 *  page gray buffer, the placement rect per word (for hit-testing), and the
 *  straightened rule y positions. */
export function compositeWords(
  recs: WordRec[], rulesJson: RulesJson, W: number, H: number, p: Params,
): { gray: Uint8Array; tiles: CompositeTile[]; ruleY: number[] } {
  const gray = new Uint8Array(W * H).fill(255);
  const tiles: CompositeTile[] = [];
  const rules = [...rulesJson.rules]
    .sort((a, b) => a.y[a.y.length >> 1] - b.y[b.y.length >> 1]);
  const ruleY = rules.map((r) => Math.round(percentile(r.y, 50)));

  if (p.cpRules > 0.5) {
    for (const y of ruleY) {
      if (y < 0 || y >= H) continue;
      for (let x = 0; x < W; x++)
        gray[y * W + x] = Math.min(gray[y * W + x], 215);
    }
  }

  const pick = (r: WordRec): ImageData | undefined =>
    p.cpSource === 1 ? r.traced ?? r.smooth ?? r.thick
      : p.cpSource === 2 ? r.thick
      : r.smooth ?? r.thick;

  for (const rec of recs) {
    const src = pick(rec);
    if (!src || rec.scaledBaselineRow === undefined) continue;
    const baseY = rec.ruleIdx >= 0
      ? ruleY[rec.ruleIdx]
      : Math.round(rec.baselineY);
    const cx = Math.round(rec.box.x + rec.box.w / 2);
    const x0 = Math.round(cx - src.width / 2);
    const y0 = baseY - rec.scaledBaselineRow;
    const paper = rec.sdf?.paper ?? 250;
    const k = 255 / paper; // remap crop paper -> pure white
    for (let yy = 0; yy < src.height; yy++) {
      const py = y0 + yy;
      if (py < 0 || py >= H) continue;
      for (let xx = 0; xx < src.width; xx++) {
        const px = x0 + xx;
        if (px < 0 || px >= W) continue;
        const v = Math.min(255, Math.round(src.data[(yy * src.width + xx) * 4] * k));
        const i = py * W + px;
        if (v < gray[i]) gray[i] = v; // min blend: darker wins
      }
    }
    tiles.push({ x: x0, y: y0, w: src.width, h: src.height, idx: rec.index });
  }
  return { gray, tiles, ruleY };
}
