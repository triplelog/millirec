/**
 * PAIR-COUPLED rule tracing.
 *
 * A single rule's seam is easy to fool on faint ruling: a dark character
 * resting on the line pulls the seam toward its own ink, and where the rule is
 * faint the seam has nothing to hold it. The writer's observation fixes this:
 * printed rules come at a fixed pitch, so trace them in PAIRS — the two rules
 * of a pair share ONE vertical offset profile, and a deviation that helps one
 * rule reach a character must ALSO be paid on its partner, where there is
 * usually nothing but paper. A character can bend one seam; it cannot bend two
 * rules a pitch apart.
 *
 * Mechanics, per adjacent seed pair (y_k, y_{k+1}):
 *   cost(x, d)  = darkness at (x, y_k + d) + darkness at (x, y_{k+1} + d)
 *   1-D DP over x with a smoothness penalty on |d(x) - d(x-1)| — curvature is
 *   slow, ~0.03 px/px on the worst measured page, so the profile may wander
 *   far (±0.45 pitch) but never jump.
 * Each rule belongs to two pairs; its offset is their average. A final
 * PER-RULE micro-refine (±2 px, same DP) then lets the pair distance drift
 * slowly — the perspective/warp does change the local pitch — without
 * reopening the character trap: ±2 px is not enough to leave the rule for a
 * letter.
 *
 * |d| is capped under half the pitch so the comb cannot alias one period over
 * (rule k landing on rule k+1's print scores identically without the cap).
 *
 * On top of the independent pass sits the PROPAGATION SWEEP (opts.order,
 * default 'propagate-pair'): anchor on the most confident independent trace,
 * then walk up and down the page re-tracing each frontier pair in a narrow
 * residual band around its accepted neighbour's shape, with a flatness prior
 * — "once the local warp is known, the next rule is nearly straight in that
 * frame". The warp is carried purely as coordinates (base curves); no pixel
 * is ever resampled during the search.
 */

export interface PairTraceOptions {
  /** search radius as a fraction of the pitch (default 0.45) */
  radiusFrac?: number;
  /** smoothness penalty per px of offset change per column, gray units (default 6) */
  smooth?: number;
  /** CURVATURE penalty per px of SLOPE change per column (default 10). This is
   *  the spike killer: a dip toward a character and back is two sharp slope
   *  changes, and each pays this; a real warp changes slope gradually and
   *  pays almost nothing however far it wanders. */
  curve?: number;
  /** how much nearby INK amplifies the curvature penalty (default 2.5): where
   *  the band around the pair is busy with character pixels, the data term is
   *  least trustworthy, so the trace should coast on its current slope —
   *  curvature there costs (1 + charW * inkFrac/0.25) times more. */
  charW?: number;
  /** darkness clip below paper — ink darker than paper-clip counts as exactly
   *  paper-clip, so text cannot out-pull a faint rule (default 26) */
  clip?: number;
  /** per-rule micro-refine radius, px (default 2) */
  refineR?: number;
  /** sample every n-th column in the DP (default 2; offsets are interpolated) */
  stepX?: number;
  /** 'gate' (default): flanks are a thinness GATE and darkness is band-passed
   *  around the measured rule ink level; 'legacy': the original
   *  centre-minus-mean-flanks cost, kept for A/B. */
  costMode?: 'gate' | 'legacy';
  /** gray levels BELOW the measured rule ink that still earn full credit
   *  (default 20) — writing pressure varies more than print does */
  darkSlack?: number;
  /** fade width past the slack: credit decays linearly to darkFloor over this
   *  many gray levels (default 60). Darker than a rule can plausibly be is
   *  CHARACTER evidence, not better rule evidence. */
  darkDecay?: number;
  /** credit fraction retained for arbitrarily dark ink (default 0.15) — a
   *  double-inked rule segment should dim, not vanish */
  darkFloor?: number;
  /** thinness gate: mean flank brightness ABOVE the floor that earns full
   *  credit, gray levels (default = clip). Below it credit scales linearly —
   *  a rule with a letter resting on it keeps most of its strength, a row
   *  inside a text band (dark both sides) keeps none. */
  thinT?: number;
  /** 'propagate-pair' (default, best measured): after the independent pass,
   *  re-trace OUTWARD from the most confident rule, advancing two rules per
   *  step through the pair DP with a shared residual — each frontier pair is
   *  searched in a NARROW band (propRadiusFrac) around its accepted
   *  neighbour's shape shifted by the seed gap, with a flatness prior on the
   *  residual. In the neighbour's warped frame a real rule is nearly
   *  straight, so the radiusFrac cap stops binding on steep warps (each step
   *  only catches the warp's INCREMENT). Coordinate-space only: no pixel is
   *  ever resampled during the search (the iterative REWARP was measured
   *  worse at the decode). 'propagate' is the single-rule sweep — a measured
   *  NEGATIVE (coverage 25% vs 43/49%: one row of data per column cannot pay
   *  for the flat prior on a faint dashed rule). 'independent' is the plain
   *  full-radius pass. Weirdpage coverage: independent 42.8%, propagate-pair
   *  50.1%, and the bottom-region radius-cap artifact is FIXED (33.9% →
   *  46.9%, traces follow the steep dive to the page edge). */
  order?: 'independent' | 'propagate' | 'propagate-pair';
  /** propagation search radius as a fraction of the pitch (default 0.18) */
  propRadiusFrac?: number;
  /** flatness prior for propagation: cost per px of residual from the
   *  neighbour-predicted shape (default 0.4, a measured interior optimum:
   *  0/0.2/0.4/0.8/1.5 → bottom-region coverage 40.4/44.3/46.9/46.4/45.3%)
   *  — "after dewarp, rules are horizontal" */
  flatW?: number;
  /** low-pass window for the FINAL traces, px (default 0.3 × pitch, forced
   *  odd; 0 disables — a measured interior optimum on the weirdpage decode:
   *  raw 13 errs / 0.15×pitch 13 / 0.3× **10** / 0.6× 15, so the jitter was
   *  costing words and over-smoothing loses real bend). A printed rule's real bend is hundreds of columns
   *  long; the DP's per-column snap jitters at a few — two passes of a box
   *  mean (triangular kernel) keep the bend and kill the jitter, at the
   *  source, so the rule remover, the dewarp and the panels all see the
   *  same smooth curve. */
  smoothWin?: number;
}

/** LINE-NESS cost per pixel: dark at y with PAPER just above and below.
 *
 *  Two traps shaped this, both watched happen in the trace render. Raw
 *  darkness as reward pulled every trace into the x-height band of the
 *  written lines (dark across most of their width, far stronger than a faint
 *  rule). Clipping the darkness helped nothing: a text band still beats a
 *  DASHED faint rule on summed continuity. What text does NOT have is
 *  thinness — a printed rule is dark in a 1-3 px band with paper on both
 *  sides, a text band is dark for twenty.
 *
 *  'legacy' is the original form,
 *      clip(min3(y)) - 0.5 * (clip(min3(y-5)) + clip(min3(y+5)))
 *  whose flaw is that the FLANKS are the reference: characters within 5 px
 *  dim the rule's score exactly where the page is busiest (half strength
 *  under a written baseline, zero inside dense ink).
 *
 *  'gate' (default) separates the two jobs the flanks were doing:
 *    - the CONTRAST reference is absolute — the page's global paper level,
 *      which is sound because pa.gray is illumination-flattened;
 *    - the flanks are only a THINNESS GATE in [0,1]: full credit while the
 *      mean flank is paper-like, fading to zero inside a band, so nearby ink
 *      gates the credit rather than subtracting from it;
 *    - darkness is BAND-PASSED around the rule's own measured ink level
 *      (`ruleInk`, sampled along the seed rows): full credit down to
 *      ruleInk - darkSlack, then decaying to darkFloor. Ink much darker than
 *      a rule can plausibly be is a character crossing, not a better rule —
 *      the saturating clip made it score no BETTER than a rule; the decay
 *      makes it score WORSE. */
function lineCost(
  gray: Uint8Array, W: number, H: number, floor: number,
  o: { costMode: 'gate' | 'legacy'; clip: number; ruleInk: number;
       darkSlack: number; darkDecay: number; darkFloor: number; thinT: number },
): Int16Array {
  const min3 = new Uint8Array(W * H);
  const clip3 = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - 1), y1 = Math.min(H - 1, y + 1);
    for (let x = 0; x < W; x++) {
      let v = gray[y * W + x];
      if (gray[y0 * W + x] < v) v = gray[y0 * W + x];
      if (gray[y1 * W + x] < v) v = gray[y1 * W + x];
      min3[y * W + x] = v;
      clip3[y * W + x] = v < floor ? floor : v;
    }
  }
  const out = new Int16Array(W * H);
  const F = 5;
  if (o.costMode === 'legacy') {
    for (let y = 0; y < H; y++) {
      const ya = Math.max(0, y - F), yb = Math.min(H - 1, y + F);
      for (let x = 0; x < W; x++) {
        out[y * W + x] = clip3[y * W + x] - ((clip3[ya * W + x] + clip3[yb * W + x]) >> 1);
      }
    }
    return out;
  }
  const lo = o.ruleInk - o.darkSlack;
  for (let y = 0; y < H; y++) {
    const ya = Math.max(0, y - F), yb = Math.min(H - 1, y + F);
    for (let x = 0; x < W; x++) {
      const v = min3[y * W + x];
      if (v >= floor) continue;                       // paper: 0
      let d = 1;
      if (v < lo) d = Math.max(o.darkFloor, 1 - (lo - v) / o.darkDecay);
      const fl = ((clip3[ya * W + x] + clip3[yb * W + x]) >> 1) - floor;
      const t = fl >= o.thinT ? 1 : fl <= 0 ? 0 : fl / o.thinT;
      out[y * W + x] = Math.round(-o.clip * d * t);
    }
  }
  return out;
}

/**
 * Shared-offset profile for one pair via a SECOND-ORDER DP.
 *
 * State per sampled column = (offset d, last step δ ∈ [-2, 2]). Two penalties:
 *   smooth · |δ|        — wandering costs a little, always;
 *   curveEff · |δ - δ'| — CHANGING slope costs a lot, and `curveEff` grows
 *                         with the local ink density (`inkNear`): a dip
 *                         toward a character and back is two sharp slope
 *                         changes right where the band is busiest, so it pays
 *                         maximally, while a real warp bends gradually over
 *                         hundreds of columns and pays almost nothing.
 * Returns d per SAMPLED column.
 */
function pairProfile(
  minV: Int16Array, inkNear: Float32Array, W: number, H: number,
  yA: number, yB: number, R: number,
  smooth: number, curve: number, charW: number, stepX: number,
  // propagation: full-width BASE CURVES replace the flat seeds (offset is then
  // a residual from the predicted shape) and flatW charges |residual| per
  // sampled column — the "rules are horizontal after dewarp" prior.
  baseA?: Float32Array | null, baseB?: Float32Array | null, flatW = 0,
): Float32Array {
  const D = 2 * R + 1;
  const S = 2, NS = 2 * S + 1;
  const nx = Math.ceil(W / stepX);
  const at = (x: number, y: number): number => {
    const yy = Math.round(y);
    if (yy < 0 || yy >= H) return 0;
    return minV[yy * W + x];
  };
  const rowA = (x: number): number => (baseA ? baseA[x] : yA);
  const rowB = (x: number): number => (baseB ? baseB[x] : yB);
  const N = D * NS;
  let prev = new Float32Array(N).fill(Infinity);
  let cur = new Float32Array(N);
  const back = new Int16Array(nx * N);
  for (let d = 0; d < D; d++) {
    const off = d - R;
    const data = at(0, rowA(0) + off) + at(0, rowB(0) + off) + flatW * Math.abs(off);
    for (let sl = 0; sl < NS; sl++) prev[d * NS + sl] = data;
  }
  for (let xi = 1; xi < nx; xi++) {
    const x = Math.min(W - 1, xi * stepX);
    const curveEff = curve * (1 + charW * Math.min(1, inkNear[xi] / 0.25));
    cur.fill(Infinity);
    for (let d = 0; d < D; d++) {
      const off = d - R;
      const data = at(x, rowA(x) + off) + at(x, rowB(x) + off) + flatW * Math.abs(off);
      for (let sl = 0; sl < NS; sl++) {
        const step = sl - S;                     // this column's δ
        const pd = d - step;                     // previous offset
        if (pd < 0 || pd >= D) continue;
        let best = Infinity, arg = 0;
        for (let ps = 0; ps < NS; ps++) {
          const v = prev[pd * NS + ps] + curveEff * Math.abs(step - (ps - S));
          if (v < best) { best = v; arg = ps; }
        }
        const c = best + smooth * Math.abs(step) + data;
        if (c < cur[d * NS + sl]) {
          cur[d * NS + sl] = c;
          back[xi * N + d * NS + sl] = arg;
        }
      }
    }
    const t = prev; prev = cur; cur = t;
  }
  // backtrack over (d, δ)
  let bi = 0;
  for (let k = 1; k < N; k++) if (prev[k] < prev[bi]) bi = k;
  const prof = new Float32Array(nx);
  for (let xi = nx - 1; xi >= 0; xi--) {
    const d = (bi / NS) | 0, sl = bi % NS;
    prof[xi] = d - R;
    if (xi > 0) {
      const ps = back[xi * N + bi];
      bi = (d - (sl - S)) * NS + ps;
    }
  }
  return prof;
}

/** two passes of a centred box mean (= triangular kernel) over a trace's y
 *  profile, prefix-summed so each pass is O(W). The window shrinks at the
 *  page edges rather than padding, so the ends are not dragged flat. */
function lowPassY(y: Float32Array, W: number, win: number): Float32Array {
  const R = win >> 1;
  if (R < 1) return y;
  let cur = y;
  for (let pass = 0; pass < 2; pass++) {
    const pre = new Float64Array(W + 1);
    for (let x = 0; x < W; x++) pre[x + 1] = pre[x] + cur[x];
    const out = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const a = Math.max(0, x - R), b = Math.min(W - 1, x + R);
      out[x] = (pre[b + 1] - pre[a]) / (b - a + 1);
    }
    cur = out;
  }
  return cur;
}

/** small per-rule DP around a baseline trace — the slow pair-distance drift.
 *  flatW > 0 additionally charges |offset| from the base, the propagation
 *  sweep's horizontal prior. */
function refineAround(
  minV: Int16Array, W: number, H: number,
  base: Float32Array, R: number, smooth: number, flatW = 0,
): Float32Array {
  const D = 2 * R + 1;
  const at = (x: number, y: number): number => {
    const yy = Math.round(y);
    if (yy < 0 || yy >= H) return 0;
    return minV[yy * W + x];
  };
  const prev = new Float32Array(D);
  const back = new Int8Array(W * D);
  for (let d = 0; d < D; d++) prev[d] = at(0, base[0] + d - R) + flatW * Math.abs(d - R);
  const cur = new Float32Array(D);
  for (let x = 1; x < W; x++) {
    for (let d = 0; d < D; d++) {
      let best = Infinity, arg = 0;
      for (let dd = -1; dd <= 1; dd++) {
        const p = d + dd;
        if (p < 0 || p >= D) continue;
        const v = prev[p] + smooth * Math.abs(dd);
        if (v < best) { best = v; arg = dd; }
      }
      cur[d] = best + at(x, base[x] + d - R) + flatW * Math.abs(d - R);
      back[x * D + d] = arg;
    }
    prev.set(cur);
  }
  let d = 0;
  for (let k = 1; k < D; k++) if (prev[k] < prev[d]) d = k;
  const out = new Float32Array(W);
  for (let x = W - 1; x >= 0; x--) {
    out[x] = base[x] + d - R;
    if (x > 0) d -= back[x * D + d];
  }
  return out;
}

/**
 * Trace every seed with pair coupling. `seedYs` must be sorted ascending and
 * roughly evenly pitched (the rescue's seed builder guarantees both).
 */
export function pairTraceRules(
  gray: Uint8Array, W: number, H: number,
  seedYs: number[], pitch: number,
  opts: PairTraceOptions = {},
): { thickness: number; y: number[] }[] {
  const R = Math.max(3, Math.round(pitch * (opts.radiusFrac ?? 0.45)));
  const smooth = opts.smooth ?? 6;
  const refineR = opts.refineR ?? 2;
  const stepX = Math.max(1, opts.stepX ?? 2);
  const samp: number[] = [];
  for (let i = 0; i < W * H; i += 499) samp.push(gray[i]);
  samp.sort((a, b) => a - b);
  const paper = samp[Math.floor(samp.length * 0.85)] ?? 235;
  const clip = opts.clip ?? 26;
  const floor = paper - clip;
  const K = seedYs.length;
  if (K === 0) return [];
  // THE RULE'S OWN INK LEVEL, sampled along the seed rows (min3 vertical, so a
  // seed 1 px off the rule still reads it). Characters pollute the dark tail,
  // but along a full-width row the rule dominates the sub-floor COUNT, so the
  // median is the print and the tail is the writing — which is exactly the
  // separation the band-pass needs.
  const inkSamp: number[] = [];
  for (const sy of seedYs) {
    const yy = Math.round(sy);
    if (yy < 1 || yy >= H - 1) continue;
    for (let x = 0; x < W; x += 7) {
      let v = gray[yy * W + x];
      if (gray[(yy - 1) * W + x] < v) v = gray[(yy - 1) * W + x];
      if (gray[(yy + 1) * W + x] < v) v = gray[(yy + 1) * W + x];
      if (v < floor) inkSamp.push(v);
    }
  }
  inkSamp.sort((a, b) => a - b);
  const ruleInk = inkSamp.length >= 30 ? inkSamp[inkSamp.length >> 1] : floor - 10;
  const minV = lineCost(gray, W, H, floor, {
    costMode: opts.costMode ?? 'gate', clip, ruleInk,
    darkSlack: opts.darkSlack ?? 20, darkDecay: opts.darkDecay ?? 60,
    darkFloor: opts.darkFloor ?? 0.15, thinT: opts.thinT ?? clip,
  });
  // the final low-pass window: pitch-scaled and odd, 0 disables
  const winRaw = opts.smoothWin ?? Math.round(pitch * 0.3);
  const smoothWin = winRaw >= 3 ? winRaw | 1 : 0;
  const finish = (t: Float32Array): { thickness: number; y: number[] } =>
    ({ thickness: 2, y: Array.from(smoothWin ? lowPassY(t, W, smoothWin) : t) });
  if (K === 1) {
    const base = new Float32Array(W).fill(seedYs[0]);
    return [finish(refineAround(minV, W, H, base, Math.max(refineR, 3), smooth))];
  }
  // per-pair ink density at the sampled columns — how busy the band between
  // (and just around) the pair is with real character pixels; this is what
  // scales the curvature penalty up where the data term is least trustworthy
  const darkT = paper - 30;
  const nx0 = Math.ceil(W / stepX);
  const inkNearOf = (yA: number, yB: number): Float32Array => {
    const g = Math.max(4, yB - yA);
    const y0 = Math.max(0, Math.round(yA - g * 0.3));
    const y1 = Math.min(H - 1, Math.round(yB + g * 0.3));
    const out = new Float32Array(nx0);
    for (let xi = 0; xi < nx0; xi++) {
      const x = Math.min(W - 1, xi * stepX);
      let dark = 0, n = 0;
      for (let y = y0; y <= y1; y += 2) { n++; if (gray[y * W + x] < darkT) dark++; }
      out[xi] = n ? dark / n : 0;
    }
    return out;
  };
  const curve = opts.curve ?? 10;
  const charW = opts.charW ?? 2.5;
  // shared profile per adjacent pair, at the sampled columns
  const profs: Float32Array[] = [];
  for (let k = 0; k + 1 < K; k++) {
    profs.push(pairProfile(minV, inkNearOf(seedYs[k], seedYs[k + 1]), W, H,
      seedYs[k], seedYs[k + 1], R, smooth * 2, curve, charW, stepX));
  }
  const nx = profs[0].length;
  // per rule: average of its pairs' profiles, expanded to full width
  const rules: { thickness: number; y: number[] }[] = [];
  for (let k = 0; k < K; k++) {
    const left = k > 0 ? profs[k - 1] : null;
    const right = k < K - 1 ? profs[k] : null;
    const base = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const xi = Math.min(nx - 1, Math.floor(x / stepX));
      const l = left ? left[xi] : null;
      const r = right ? right[xi] : null;
      const d = l != null && r != null ? (l + r) / 2 : (l ?? r ?? 0);
      base[x] = seedYs[k] + d;
    }
    const t = refineAround(minV, W, H, base, refineR, smooth);
    rules.push({ thickness: 2, y: Array.from(t) });
  }
  const order = opts.order ?? 'propagate-pair';
  if (order === 'independent') return rules.map((r) => finish(Float32Array.from(r.y)));

  // PROPAGATION SWEEP. The independent traces above are stage 1; their only
  // job now is to say WHICH rule the page is most confident about. From that
  // anchor, sweep up and down: each frontier rule is re-traced in a narrow
  // band around its accepted neighbour's shape shifted by the seed gap, with
  // a flatness prior on the residual — in the neighbour's warped frame a real
  // rule is nearly straight, which is what lets the band shrink ~3x and stops
  // the radiusFrac cap binding on steep warps (each step only has to catch
  // the INCREMENT of the warp, never the whole of it). No pixel is resampled:
  // the "warp" lives entirely in the predicted base curves.
  const flatW = opts.flatW ?? 0.4;
  const R2 = Math.max(3, Math.round(pitch * (opts.propRadiusFrac ?? 0.18)));
  const confOf = (y: number[] | Float32Array): number => {
    let dark = 0, n = 0;
    for (let x = 0; x < W; x += 4) {
      const yy = Math.round(Number(y[x]));
      if (yy < 0 || yy >= H) continue;
      n++;
      if (minV[yy * W + x] <= -(clip >> 1)) dark++;
    }
    return n ? dark / n : 0;
  };
  const conf = rules.map((r) => confOf(r.y));
  let anchor = 0;
  for (let k = 1; k < K; k++) if (conf[k] > conf[anchor]) anchor = k;
  const prop: Float32Array[] = new Array(K);
  prop[anchor] = Float32Array.from(rules[anchor].y);
  const predict = (from: number, k: number): Float32Array => {
    const gap = seedYs[k] - seedYs[from];
    const out = new Float32Array(W);
    for (let x = 0; x < W; x++) out[x] = prop[from][x] + gap;
    return out;
  };
  // one frontier rule through the flat-prior refine, or two through the pair
  // DP with a shared residual ('propagate-pair')
  const advance = (from: number, k: number, k2: number | null): void => {
    const baseA = predict(from, k);
    if (k2 == null) {
      prop[k] = refineAround(minV, W, H, baseA, R2, smooth, flatW);
      return;
    }
    const baseB = predict(from, k2);
    const lo = Math.min(seedYs[k], seedYs[k2]), hi = Math.max(seedYs[k], seedYs[k2]);
    const pr = pairProfile(minV, inkNearOf(lo, hi), W, H, 0, 0, R2,
      smooth * 2, curve, charW, stepX, baseA, baseB, flatW);
    const nx2 = pr.length;
    const withRes = (b: Float32Array): Float32Array => {
      const out = new Float32Array(W);
      for (let x = 0; x < W; x++) out[x] = b[x] + pr[Math.min(nx2 - 1, Math.floor(x / stepX))];
      return out;
    };
    prop[k] = refineAround(minV, W, H, withRes(baseA), refineR, smooth);
    prop[k2] = refineAround(minV, W, H, withRes(baseB), refineR, smooth);
  };
  const pairStep = order === 'propagate-pair';
  let up = anchor - 1, dn = anchor + 1;
  while (up >= 0 || dn < K) {
    if (up >= 0) {
      if (pairStep && up - 1 >= 0) { advance(up + 1, up, up - 1); up -= 2; }
      else { advance(up + 1, up, null); up -= 1; }
    }
    if (dn < K) {
      if (pairStep && dn + 1 < K) { advance(dn - 1, dn, dn + 1); dn += 2; }
      else { advance(dn - 1, dn, null); dn += 1; }
    }
  }
  return prop.map((t) => finish(t));
}
