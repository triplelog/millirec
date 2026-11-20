// SDF-based thickness re-rendering for v2 (grayscale-pipeline) words. Bold and
// weight changes move the ink surface of the stored base-weight matte via a
// signed distance field, giving smooth strokes of differing thickness — the
// same mechanism as Pass B's thickness stage, applied on demand in the editor.

import * as passB from './passB/pipeline';

/** Edge softness (px) of the re-rendered stroke. Matches Pass B's default feel. */
const EDGE_W = 2.0;

let work: HTMLCanvasElement | null = null;
function scratch(w: number, h: number): CanvasRenderingContext2D {
  if (!work) work = document.createElement('canvas');
  work.width = w;
  work.height = h;
  return work.getContext('2d', { willReadFrequently: true })!;
}

/** Decode a data URL to an HTMLImageElement. */
function decode(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('crop decode failed'));
    img.src = url;
  });
}

/**
 * Re-render an alpha-matte crop with its ink surface moved by `deltaPx`
 * (positive = thicker/bolder, negative = thinner). Rebuilds the SDF from the
 * matte's coverage each call, so any weight is reachable from the one stored
 * base crop. `deltaPx` is in crop pixels. `deltaPx ≈ 0` returns the input.
 */
export async function sdfThickenCrop(matteUrl: string, deltaPx: number): Promise<string> {
  if (Math.abs(deltaPx) < 0.02) return matteUrl;

  const img = await decode(matteUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return matteUrl;

  const ctx = scratch(w, h);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;

  // Matte → grayscale coverage: the ink is black (RGB 0) at alpha `a`, over
  // white paper, so gray = 255 − a. Feed that to the shared SDF builder.
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = 255 - data[i * 4 + 3];

  const levels = passB.estimateLevels(gray);
  if (!levels) return matteUrl; // no real ink

  const sdf = passB.buildSdf(gray, w, h, levels, 0.5);
  const rendered = passB.renderSdf(sdf, w, h, deltaPx, EDGE_W); // grayscale, thicker

  // Grayscale → matte: alpha = paper − gray (ink opaque, paper transparent).
  const out = new ImageData(w, h);
  const range = Math.max(1, sdf.paper - sdf.ink);
  for (let i = 0; i < w * h; i++) {
    const g = rendered.data[i * 4];
    let a = Math.round(((sdf.paper - g) / range) * 255);
    a = a < 0 ? 0 : a > 255 ? 255 : a;
    out.data[i * 4 + 3] = a;
  }
  ctx.putImageData(out, 0, 0);
  return work!.toDataURL('image/png');
}

/**
 * Re-render a matte with its strokes PULLED TOWARD a target thickness — the
 * import's own adaptive normalization (`normalizeThickness` pass 2) applied to
 * a stored crop.
 *
 * A flat surface offset (`sdfThickenCrop`) moves every boundary equally, so
 * thinning starves the hairline joining two letters before the heavy
 * downstroke has visibly moved. The local offset measures each part's own
 * thickness (`localThickness` over the SDF ridge) and moves it by
 * (target − local)/2 per side: thick parts thin hardest, parts already at or
 * below target stay put — and even THICKEN toward the target during an
 * overall thinning, so the thin parts can never be starved. The same holds in
 * reverse when thickening: thin parts grow the most.
 */
export async function sdfThicknessAdapt(
  matteUrl: string,
  targetPx: number,
  opts?: {
    maxChangePx?: number;
    /** RELATIVE mode: move this crop's strokes by `deltaPx` from their OWN
     *  measured thickness (target = current + delta) instead of toward the
     *  absolute `targetPx`. With natural (un-normalized) pen weight this is
     *  what a weight slider must do — an absolute target thickens the thin
     *  words, holds the average ones and THINS the thick ones, which reads
     *  as "only some words respond". Per-part adaptivity still applies. */
    deltaPx?: number;
    /** NORMALIZE mode: a uniform shift toward this absolute width, computed
     *  as delta = clamp(normalizeToPx − current, ±maxShiftPx) and applied
     *  through the SAME single-pass uniform-delta path (hairline floor
     *  included) — gentle cross-word weight equalization without the
     *  per-part machinery that ate details. */
    normalizeToPx?: number;
    /** Cap for normalize mode's shift (default 1.5 px). */
    maxShiftPx?: number;
    /** Blur the (adjusted) distance field by this radius before rendering —
     *  level sets cannot cross under a blur of d, so stroke wobble and pixel
     *  stairs round off while thickness stays put (smoothWords' own trick,
     *  applied to a stored matte). */
    smoothPx?: number;
  },
): Promise<string> {
  const wantsWork = (targetPx > 0)
    || (opts && (opts.deltaPx !== undefined || opts.normalizeToPx !== undefined
      || (opts.smoothPx ?? 0) > 0));
  if (!wantsWork) return matteUrl;

  const img = await decode(matteUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return matteUrl;

  const ctx = scratch(w, h);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = 255 - data[i * 4 + 3];

  const levels = passB.estimateLevels(gray);
  if (!levels) return matteUrl; // no real ink

  const cut = passB.surfaceCut(levels, 0.5);
  const cur = passB.runThickness(gray, w, h, cut);
  if (!(cur > 0)) return matteUrl;
  let deltaPx = opts?.deltaPx;
  if (deltaPx === undefined && opts?.normalizeToPx !== undefined) {
    const cap = opts.maxShiftPx ?? 1.5;
    deltaPx = Math.max(-cap, Math.min(cap, opts.normalizeToPx - cur));
  }
  if (deltaPx !== undefined) targetPx = Math.max(0.5, cur + deltaPx);
  if (deltaPx === undefined && !(targetPx > 0)) { deltaPx = 0; targetPx = cur; }

  const sdf = passB.buildSdf(gray, w, h, levels, 0.5);
  const tloc = passB.localThickness(sdf.d, w, h, cur);
  // CLOSED LOOP (absolute mode only): the render's edge ramp puts the
  // APPARENT width over the SDF surface by a near-constant amount, so the
  // first render is measured and the target corrected once — `targetPx`
  // means apparent width, matching cleanPage's import render.
  // DELTA mode renders ONCE, uncorrected: the ramp offset applies equally
  // before and after a surface shift, so it cancels in the difference — and
  // the measurement the loop leans on is exactly what a thickened dense word
  // breaks (grown strokes merge, the run measure explodes, the "correction"
  // drives the change back to zero on some words and not others).
  const single = deltaPx !== undefined;
  let goal = targetPx;
  let rendered!: ImageData;
  for (let attempt = 0; attempt < 2; attempt++) {
    // The cap bounds what any ONE part may move (a mis-measured ridge cannot
    // blow a stroke up), while auto-widening with the requested change so a
    // large slider swing is actually reachable.
    const half = (opts?.maxChangePx ?? Math.max(4, Math.abs(goal - cur) + 1)) / 2;
    const dAdj = new Float32Array(w * h);
    if (single) {
      // DELTA mode: the surface moves by exactly delta/2 per side — a uniform
      // shift, so every word (and every part) changes by the requested amount
      // and the ramp offset cancels between before and after. The one
      // adaptive piece kept is the FLOOR: when thinning, a part already near
      // hairline width (its local thickness within ~1.2 px) gives up less
      // than the full delta rather than being starved.
      const d2 = (deltaPx as number) / 2;
      for (let i = 0; i < w * h; i++) {
        let o = d2;
        if (d2 < 0) o = Math.max(d2, -Math.max(0, tloc[i] - 1.2) / 2);
        dAdj[i] = sdf.d[i] - o;
      }
    } else {
      for (let i = 0; i < w * h; i++) {
        const o = Math.max(-half, Math.min(half, (goal - tloc[i]) / 2));
        dAdj[i] = sdf.d[i] - o;
      }
    }
    const r = Math.round(opts?.smoothPx ?? 0);
    if (r > 0) { passB.boxBlur(dAdj, w, h, r); passB.boxBlur(dAdj, w, h, r); }
    rendered = passB.renderSdf({ d: dAdj, ink: sdf.ink, paper: sdf.paper }, w, h, 0, EDGE_W);
    if (single || attempt === 1) break;
    const rg = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) rg[i] = rendered.data[i * 4];
    const app = passB.runThickness(rg, w, h,
      passB.surfaceCut({ ink: sdf.ink, paper: sdf.paper }, 0.5));
    if (!(app > 0) || Math.abs(targetPx - app) <= 0.3) break;
    goal = Math.max(0.5, goal + (targetPx - app));
  }

  const out = new ImageData(w, h);
  const range = Math.max(1, sdf.paper - sdf.ink);
  for (let i = 0; i < w * h; i++) {
    const g = rendered.data[i * 4];
    let a = Math.round(((sdf.paper - g) / range) * 255);
    a = a < 0 ? 0 : a > 255 ? 255 : a;
    out.data[i * 4 + 3] = a;
  }
  ctx.putImageData(out, 0, 0);
  return work!.toDataURL('image/png');
}

/**
 * RASTER-DOMAIN matte normalization — no SDF re-render, no resampling: the
 * pixels stay the segPage cut's own (the look every re-render kept spoiling),
 * adjusted in place by grayscale morphology and an alpha gain.
 *
 * - `thickenToPx`: words THINNER than this are dilated up toward it
 *   (sub-pixel: whole-px 3x3 max-filter passes with a linear blend for the
 *   fraction), capped at `maxGrowPx`. DILATION ONLY, by design — every
 *   erosion-based normalization was measured or reported eating character
 *   details, so at-or-above-target words are left untouched.
 * - `gain`: alpha multiplier (capped at 255). Solid ink is already at 255 in
 *   a segPage matte, so this deepens the anti-aliased edge ramp — a slightly
 *   darker, crisper edge without moving the boundary.
 * - `darkTo`: PER-CHARACTER tone normalization, the darkness step that
 *   actually equalizes the ink. The per-char render normalizes stroke CORES
 *   to one level, but the anti-aliased rim is a far larger fraction of a
 *   thin stroke than a thick one, so rim-heavy characters read lighter at
 *   equal width. Each connected component (≈ one character) gets its OWN
 *   S-curve threshold, taken from its own alpha distribution: hi = the
 *   quantile that puts at least DARK_FRAC (0.5) of the character's ink
 *   pixels (α ≥ 48) at full darkness, capped at the fixed 160 so characters
 *   that are already dark keep exactly the fixed curve's look (measured:
 *   under the fixed curve alone the per-char dark fraction ran 17%..99%,
 *   median 93% — the light tail is what still read grey). Feather pixels
 *   join their nearest character by BFS so a character and its rim move
 *   through one curve (a core-only remap bands at the α=128 seam). The
 *   curve runs LAST, so it also re-sharpens the smoothing feather. History:
 *   a per-word linear gain measured INVERTED (the feather dominates any
 *   mean), and the fixed curve under-darkened the thin tail — quantiles
 *   are feather-robust where means are not. Any darkTo > 0 enables it.
 * - `smooth`/`smoothPasses`: GAP-PROOF edge smoothing. Blur the alpha (r=1),
 *   contrast-restore it with a smoothstep (rounding the pixel stairs in BOTH
 *   directions: convex corners feather out, concave notches fill in), then
 *   take the MAX with the original — every original ink pixel keeps at least
 *   its original opacity, so by construction nothing can thin, break, or open
 *   a gap; the pass can only add. `smoothPasses` ITERATES the whole pass for
 *   a wider effect: iterating small passes reaches a ~2 px feel while a
 *   single large-radius blur would bridge tight counters (the blurred field
 *   in a 2 px gap between strokes clears the band and the smoothstep welds
 *   them) — each iteration restores contrast before the next spreads, so a
 *   gap that survived one pass stays near zero in the next.
 */
export interface MatteNormalizeOpts {
  thickenToPx?: number; maxGrowPx?: number; gain?: number;
  smooth?: boolean; smoothPasses?: number; darkTo?: number;
}

/**
 * The normalization itself, on the ALPHA PLANE — no canvas, no image decode,
 * no PNG.
 *
 * `matteNormalize` below is exactly this with a data-URL round trip either
 * side, which is what every caller wanted when there was only one of them. The
 * editor cuts a matte, normalizes it and then traces it, so going through a
 * PNG at each seam cost two encodes and two decodes PER WORD — on a
 * hundred-word page that is four hundred codec passes and as many event-loop
 * hops, for pixels that never leave the tab. A caller holding the alpha can
 * now hand it straight over.
 *
 * Returns the input array untouched when there is nothing to do; otherwise a
 * new array (the input is never modified).
 */
export function matteNormalizeAlpha(
  alpha: Uint8ClampedArray,
  w: number,
  h: number,
  opts: MatteNormalizeOpts,
): Uint8ClampedArray {
  const smoothPasses = opts.smoothPasses ?? (opts.smooth ? 1 : 0);
  const wantsWork = (opts.thickenToPx ?? 0) > 0 || (opts.gain ?? 1) !== 1 || smoothPasses > 0
    || (opts.darkTo ?? 0) > 0;
  if (!wantsWork || !w || !h) return alpha;
  let a: Uint8ClampedArray = new Uint8ClampedArray(alpha);

  if ((opts.thickenToPx ?? 0) > 0) {
    // MEDIAN LOCAL WIDTH over FOUR directions: per core pixel take the
    // shortest run through it — horizontal, vertical, and BOTH diagonals
    // (each diagonal step covers √2 px) — and use the MEDIAN over ink
    // pixels. History, each replacement measured: vertical runs alone read
    // an arch as its own height ("an"/"on" falsely thick); the word-global
    // ribbon (2·area/perimeter) is an AVERAGE, so one compact or
    // double-stroked part inflated the whole word and the serifed "I" —
    // highest reading on its line — was denied its growth and ended the
    // THINNEST word visible; min(runH, runV) alone over-reads a SLANTED
    // stroke by up to ×1.41, so this italic-leaning hand's slant-heavy
    // words measured 4 on a 3px pen, landed over the 3.8 target and got
    // ZERO growth while upright words got 0.8. With diagonals the
    // worst-case over-read (22.5°) is ~8%. The median ignores a locally
    // thick part unless it is most of the word — a genuinely heavy word
    // still skips the grow. UNIT: true stroke-width px, but diagonal runs
    // quantize in √2 steps (1.41, 2.83, 4.24 — nothing near 3), so a 3px
    // pen medians 2.83 here where the 2-dir measure read 3 (~0.94×);
    // the editor's UNIVERSAL_THICKNESS_XH moved 0.20 → 0.19 with it to keep
    // the same rendered growth.
    const best = new Float32Array(w * h).fill(1e9);
    const note = (i: number, v: number): void => { if (v < best[i]) best[i] = v; };
    for (let y = 0; y < h; y++) {
      let s = -1;
      for (let x = 0; x <= w; x++) {
        const on = x < w && a[y * w + x] >= 128;
        if (on && s < 0) s = x;
        if (!on && s >= 0) { for (let k = s; k < x; k++) note(y * w + k, x - s); s = -1; }
      }
    }
    for (let x = 0; x < w; x++) {
      let s = -1;
      for (let y = 0; y <= h; y++) {
        const on = y < h && a[y * w + x] >= 128;
        if (on && s < 0) s = y;
        if (!on && s >= 0) { for (let k = s; k < y; k++) note(k * w + x, y - s); s = -1; }
      }
    }
    const SQ2 = Math.SQRT2;
    for (const dy of [1, -1]) {
      // diagonal lines (dx = +1): start on the left column and the top/bottom row
      const starts: [number, number][] = [];
      for (let y = 0; y < h; y++) starts.push([0, y]);
      for (let x = 1; x < w; x++) starts.push([x, dy === 1 ? 0 : h - 1]);
      for (const [sx, sy] of starts) {
        let n = 0;
        let x = sx, y = sy;
        while (x < w && y >= 0 && y < h) {
          const on = a[y * w + x] >= 128;
          if (on) n++;
          else if (n) {
            for (let k = 1; k <= n; k++) note((y - k * dy) * w + (x - k), n * SQ2);
            n = 0;
          }
          x++; y += dy;
        }
        if (n) for (let k = 1; k <= n; k++) note((y - k * dy) * w + (x - k), n * SQ2);
      }
    }
    const samples: number[] = [];
    for (let i = 0; i < w * h; i++) if (a[i] >= 128 && best[i] < 1e9) samples.push(best[i]);
    samples.sort((p, q) => p - q);
    const cur = samples.length ? samples[samples.length >> 1] : 0;
    if (cur > 0 && cur < opts.thickenToPx!) {
      const grow = Math.min(opts.maxGrowPx ?? 1.5, opts.thickenToPx! - cur);
      let r = grow / 2; // per side
      const maxFilter = (src: Uint8ClampedArray): Uint8ClampedArray => {
        const out = new Uint8ClampedArray(w * h);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            let m = 0;
            for (let dy = -1; dy <= 1; dy++) {
              const yy = y + dy;
              if (yy < 0 || yy >= h) continue;
              for (let dx = -1; dx <= 1; dx++) {
                const xx = x + dx;
                if (xx < 0 || xx >= w) continue;
                const v = src[yy * w + xx];
                if (v > m) m = v;
              }
            }
            out[y * w + x] = m;
          }
        }
        return out;
      };
      while (r >= 1) { a = maxFilter(a); r -= 1; }
      if (r > 0.02) {
        const next = maxFilter(a);
        for (let i = 0; i < w * h; i++) a[i] = Math.round(a[i] + (next[i] - a[i]) * r);
      }
    }
  }

  for (let pass = 0; pass < smoothPasses; pass++) {
    const b = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) b[i] = a[i];
    passB.boxBlur(b, w, h, 1);
    // smoothstep between t0..t1 restores edge contrast around the midpoint,
    // so the blur rounds the boundary rather than washing it out
    const t0 = 96, t1 = 176;
    for (let i = 0; i < w * h; i++) {
      let t = (b[i] - t0) / (t1 - t0);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const sm = Math.round(t * t * (3 - 2 * t) * 255);
      if (sm > a[i]) a[i] = sm;   // MAX with the original: gap-proof
    }
  }

  const gain = opts.gain ?? 1;
  if (gain !== 1) {
    for (let i = 0; i < w * h; i++) a[i] = Math.min(255, Math.round(a[i] * gain));
  }

  if ((opts.darkTo ?? 0) > 0) {
    const DARK_FRAC = 0.5;    // min fraction of a char's ink pixels at full alpha
    const HI_CAP = 160;       // the fixed curve — already-dark chars keep this look
    const HI_FLOOR = 64;      // never let a quantile push the ramp into the noise
    // Label cores (α >= 128), then grow labels into the feather (α >= 8) by
    // multi-source BFS so every rim pixel maps through its character's curve.
    const lab = new Int32Array(w * h).fill(-1);
    let nlab = 0;
    const stack: number[] = [];
    for (let i = 0; i < w * h; i++) {
      if (a[i] < 128 || lab[i] >= 0) continue;
      const id = nlab++;
      lab[i] = id;
      stack.length = 0;
      stack.push(i);
      while (stack.length) {
        const p = stack.pop()!;
        const px = p % w, py = (p / w) | 0;
        if (px > 0 && a[p - 1] >= 128 && lab[p - 1] < 0) { lab[p - 1] = id; stack.push(p - 1); }
        if (px < w - 1 && a[p + 1] >= 128 && lab[p + 1] < 0) { lab[p + 1] = id; stack.push(p + 1); }
        if (py > 0 && a[p - w] >= 128 && lab[p - w] < 0) { lab[p - w] = id; stack.push(p - w); }
        if (py < h - 1 && a[p + w] >= 128 && lab[p + w] < 0) { lab[p + w] = id; stack.push(p + w); }
      }
    }
    let frontier: number[] = [];
    for (let i = 0; i < w * h; i++) if (lab[i] >= 0) frontier.push(i);
    while (frontier.length) {
      const next: number[] = [];
      for (const p of frontier) {
        const id = lab[p];
        const px = p % w, py = (p / w) | 0;
        if (px > 0 && a[p - 1] >= 8 && lab[p - 1] < 0) { lab[p - 1] = id; next.push(p - 1); }
        if (px < w - 1 && a[p + 1] >= 8 && lab[p + 1] < 0) { lab[p + 1] = id; next.push(p + 1); }
        if (py > 0 && a[p - w] >= 8 && lab[p - w] < 0) { lab[p - w] = id; next.push(p - w); }
        if (py < h - 1 && a[p + w] >= 8 && lab[p + w] < 0) { lab[p + w] = id; next.push(p + w); }
      }
      frontier = next;
    }
    // Per character: hi = the (1 - DARK_FRAC) quantile of its ink alphas.
    const inkOf: number[][] = Array.from({ length: nlab }, () => []);
    for (let i = 0; i < w * h; i++) if (lab[i] >= 0 && a[i] >= 48) inkOf[lab[i]].push(a[i]);
    const hiOf = new Float32Array(nlab).fill(HI_CAP);
    for (let l = 0; l < nlab; l++) {
      const v = inkOf[l];
      if (v.length < 12) continue;  // dots/specks: too few pixels to fit — fixed curve
      v.sort((x, y) => x - y);
      const q = v[Math.floor((1 - DARK_FRAC) * (v.length - 1))];
      hiOf[l] = Math.min(HI_CAP, Math.max(HI_FLOOR, q));
    }
    for (let i = 0; i < w * h; i++) {
      const hi = lab[i] >= 0 ? hiOf[lab[i]] : HI_CAP;
      const lo = hi * 0.3;
      let t = (a[i] - lo) / (hi - lo);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      a[i] = Math.round(t * t * (3 - 2 * t) * 255);
    }
  }

  return a;
}

export async function matteNormalize(
  matteUrl: string,
  opts: MatteNormalizeOpts,
): Promise<string> {
  const smoothPasses = opts.smoothPasses ?? (opts.smooth ? 1 : 0);
  const wantsWork = (opts.thickenToPx ?? 0) > 0 || (opts.gain ?? 1) !== 1 || smoothPasses > 0
    || (opts.darkTo ?? 0) > 0;
  if (!wantsWork) return matteUrl;

  const img = await decode(matteUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return matteUrl;

  const ctx = scratch(w, h);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  const alpha = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = data[i * 4 + 3];

  const a = matteNormalizeAlpha(alpha, w, h, opts);
  const out = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) out.data[i * 4 + 3] = a[i];
  ctx.putImageData(out, 0, 0);
  return work!.toDataURL('image/png');
}
