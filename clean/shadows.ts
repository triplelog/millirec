/**
 * Edge-shadow removal, after Pass A.
 *
 * Photographed pages carry dark bands at their edges — the shadow a curled
 * page casts on itself, the phone's shadow, or a sliver of dark background the
 * page crop kept. Pass A's illumination flatten normalizes gradual lighting
 * but leaves these: near the frame its background model has nothing outside
 * the band to anchor on, and a deep shadow reads as content. Downstream they
 * binarize as ink — the phantom-word family the edge-junk filter fights
 * ("rococo.", "it's", the border "I"s) — and they ship in the cleaned display.
 *
 * What separates a shadow from writing is THICKNESS, not darkness: a pen
 * stroke at working resolution is 2-5 px wide in at least one direction, while
 * a shadow band is tens of pixels thick in both. So:
 *
 *   dark pixel        = darker than paper by `delta`
 *   THICK dark pixel  = its horizontal AND vertical dark runs both exceed
 *                       `strokeMax` — no pen stroke qualifies, whatever its ink
 *   shadow core       = thick pixels 8-connected to the frame's border band
 *   fringe            = the softer rim around the core (still clearly darker
 *                       than paper, still not stroke-thin)
 *
 * Core + fringe lift to the paper level, in the gray AND the display planes.
 * Writing INSIDE a shadow survives by construction: its strokes are thin, so
 * they are never core and never fringe — they stay dark on the lifted paper,
 * which is exactly what the binarizer needs. A page that is mostly dark (a
 * failed photo) is left alone via `capFrac`: lifting a third of the page is
 * not shadow removal, it is deleting the image.
 */

export interface EdgeShadowResult {
  /** pixels lifted to paper */
  lifted: number;
  /** why nothing was done, when nothing was */
  skipped?: 'no-dark-border' | 'over-cap';
}

export interface EdgeShadowOptions {
  /** a dark run must exceed this in BOTH directions to count as shadow-thick
   *  (px at the working resolution; the widest pen stroke is ~5) */
  strokeMax?: number;
  /** how far under the paper level "dark" starts */
  delta?: number;
  /** abort when the shadow set would exceed this fraction of the page */
  capFrac?: number;
}

export function removeEdgeShadows(
  gray: Uint8Array, W: number, H: number,
  extras: Uint8ClampedArray[] = [],
  opts: EdgeShadowOptions = {},
): EdgeShadowResult {
  const strokeMax = opts.strokeMax ?? 9;
  const delta = opts.delta ?? 24;
  const capFrac = opts.capFrac ?? 0.3;

  // paper level from a sparse sample
  const samp: number[] = [];
  for (let i = 0; i < W * H; i += 499) samp.push(gray[i]);
  samp.sort((a, b) => a - b);
  const paper = samp[Math.floor(samp.length * 0.85)] ?? 235;
  const darkT = paper - delta;
  const fringeT = paper - Math.max(8, delta * 0.4);

  // per-pixel dark run lengths, horizontal then vertical
  const runH = new Int16Array(W * H);
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (gray[y * W + x] >= darkT) { x++; continue; }
      let e = x;
      while (e < W && gray[y * W + e] < darkT) e++;
      const len = Math.min(32767, e - x);
      for (let k = x; k < e; k++) runH[y * W + k] = len;
      x = e;
    }
  }
  const runV = new Int16Array(W * H);
  for (let x = 0; x < W; x++) {
    let y = 0;
    while (y < H) {
      if (gray[y * W + x] >= darkT) { y++; continue; }
      let e = y;
      while (e < H && gray[e * W + x] < darkT) e++;
      const len = Math.min(32767, e - y);
      for (let k = y; k < e; k++) runV[k * W + x] = len;
      y = e;
    }
  }

  const thick = (i: number) => runH[i] > strokeMax && runV[i] > strokeMax;

  // flood the thick pixels from the border band
  const state = new Uint8Array(W * H);   // 1 = core, 2 = fringe
  const stack: number[] = [];
  const push = (i: number) => { if (!state[i] && thick(i)) { state[i] = 1; stack.push(i); } };
  const BAND = 2;
  for (let x = 0; x < W; x++) {
    for (let b = 0; b <= BAND; b++) { push(b * W + x); push((H - 1 - b) * W + x); }
  }
  for (let y = 0; y < H; y++) {
    for (let b = 0; b <= BAND; b++) { push(y * W + b); push(y * W + (W - 1 - b)); }
  }
  if (!stack.length) return { lifted: 0, skipped: 'no-dark-border' };
  let core = 0;
  while (stack.length) {
    const i = stack.pop()!;
    core++;
    const x = i % W, y = (i / W) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        push(ny * W + nx);
      }
    }
  }

  // fringe: the anti-aliased rim — near-dark, not stroke-thin, touching the
  // core. Two dilation rounds cover the soft ramp a shadow edge has.
  let total = core;
  let ring: number[] = [];
  for (let i = 0; i < W * H; i++) if (state[i] === 1) ring.push(i);
  for (let round = 0; round < 2; round++) {
    const next: number[] = [];
    for (const i of ring) {
      const x = i % W, y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (state[j] || gray[j] >= fringeT) continue;
          // stroke-thin stays: a thin dark structure inside the rim is ink
          if (gray[j] < darkT && !(runH[j] > 3 && runV[j] > 3)) continue;
          state[j] = 2;
          total++;
          next.push(j);
        }
      }
    }
    ring = next;
  }

  if (total > capFrac * W * H) return { lifted: 0, skipped: 'over-cap' };

  for (let i = 0; i < W * H; i++) {
    if (!state[i]) continue;
    gray[i] = paper;
    for (const ex of extras) {
      const p = i * 4;
      ex[p] = paper; ex[p + 1] = paper; ex[p + 2] = paper;
    }
  }
  return { lifted: total };
}
