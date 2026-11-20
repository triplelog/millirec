// Word merge/split for v2 (grayscale-pipeline) words, done from the stored crops
// rather than re-cropping the page (the old color path's `recropUnionBoxes` needs
// a cached page analysis, which v2 words don't have). Because each v2 word keeps
// its alpha-matte `src` + base-weight `baseSrc` + baseline, we can slice one crop
// in two or composite two crops side-by-side directly — and carry `baseSrc`
// through so the merged/split word still bolds via its SDF.

export interface InkCrop {
  src: string;            // display matte (data URL)
  baseSrc: string | null; // base-weight matte for SDF bold (data URL)
  width: number;
  height: number;
  baselineRatio: number;  // baseline row / height (0..1)
  heightEm: number;
}

function decode(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('crop decode failed'));
    img.src = url;
  });
}

/** Whitest (least-ink) column near `frac` of the width — a clean split point. */
function findSplitCol(img: HTMLImageElement, W: number, H: number, frac: number): number {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, W, H).data;
  const lo = Math.max(1, Math.floor(W * (frac - 0.18)));
  const hi = Math.min(W - 1, Math.ceil(W * (frac + 0.18)));
  let best = Infinity;
  let col = Math.max(1, Math.min(W - 1, Math.round(W * frac)));
  for (let x = lo; x < hi; x++) {
    let ink = 0;
    for (let y = 0; y < H; y++) ink += data[(y * W + x) * 4 + 3]; // alpha = ink coverage
    const cost = ink + Math.abs(x / W - frac) * W * 20; // prefer low ink, break ties toward frac
    if (cost < best) { best = cost; col = x; }
  }
  return col;
}

/** Split one v2 word crop into two at a clean column near `frac` (0..1).
 *  `opt.exact` cuts AT the fraction instead of snapping to the whitest valley
 *  nearby — a deliberate boundary nudge must not be fought by the snap. */
export async function splitInkCrop(w: InkCrop, frac: number, opt: { exact?: boolean } = {}): Promise<[InkCrop, InkCrop]> {
  const img = await decode(w.src);
  const base = w.baseSrc ? await decode(w.baseSrc) : null;
  const W = w.width, H = w.height;
  const col = opt.exact
    ? Math.max(1, Math.min(W - 1, Math.round(W * frac)))
    : findSplitCol(img, W, H, frac);
  const emPerPx = H > 0 ? w.heightEm / H : 0;

  const sliceUrl = (im: HTMLImageElement, x0: number, x1: number): string => {
    const sw = Math.max(1, x1 - x0);
    const c = document.createElement('canvas');
    c.width = sw;
    c.height = H;
    c.getContext('2d')!.drawImage(im, x0, 0, sw, H, 0, 0, sw, H);
    return c.toDataURL('image/png');
  };
  const make = (x0: number, x1: number): InkCrop => ({
    src: sliceUrl(img, x0, x1),
    baseSrc: base ? sliceUrl(base, x0, x1) : null,
    width: Math.max(1, x1 - x0),
    height: H,
    baselineRatio: w.baselineRatio,
    heightEm: H * emPerPx, // full height kept, so unchanged
  });
  return [make(0, col), make(col, W)];
}

/**
 * MOVE THE BOUNDARY between two adjacent word crops — Review's `⇤ cut` /
 * `cut ⇥` when no page session is alive. `mergeInkCrops` + `splitInkCrop`
 * was the wrong tool for it: the composite inserts a 12%-of-height GAP
 * between the words and the re-slice then carries that gap, so every nudge
 * left paper where the words used to meet. Here the two crops are laid
 * edge to edge with NO gap, the cut lands on the thinnest column near the
 * requested position (a stroke is never cut through where a valley is
 * within reach), and each side is trimmed back to its own ink. `stepFrac`
 * is the nudge as a fraction of the pair's width.
 */
export async function shiftInkBoundary(
  a: InkCrop,
  b: InkCrop,
  dir: -1 | 1,
  opt: { stepFrac?: number; minStep?: number; snap?: boolean } = {},
): Promise<[InkCrop, InkCrop] | null> {
  const [ai, bi, ab, bb] = await Promise.all([
    decode(a.src), decode(b.src),
    a.baseSrc ? decode(a.baseSrc) : Promise.resolve(null),
    b.baseSrc ? decode(b.baseSrc) : Promise.resolve(null),
  ]);
  const aAsc = a.baselineRatio * a.height;
  const bAsc = b.baselineRatio * b.height;
  const maxAsc = Math.max(aAsc, bAsc);
  const maxDesc = Math.max(a.height - aAsc, b.height - bAsc);
  const cw = Math.max(2, Math.round(a.width + b.width));
  const ch = Math.max(1, Math.ceil(maxAsc + maxDesc));
  const emPerPx = a.height > 0 ? a.heightEm / a.height : 0;
  const draw = (ia: HTMLImageElement, ib: HTMLImageElement): HTMLCanvasElement => {
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(ia, 0, maxAsc - aAsc, a.width, a.height);
    ctx.drawImage(ib, a.width, maxAsc - bAsc, b.width, b.height);
    return c;
  };
  const main = draw(ai, bi);
  const base = ab && bb ? draw(ab, bb) : null;
  const data = main.getContext('2d')!.getImageData(0, 0, cw, ch).data;
  const colInk = new Float64Array(cw);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) colInk[x] += data[(y * cw + x) * 4 + 3] / 255;
  const step = Math.max(opt.minStep ?? 3, Math.round(cw * (opt.stepFrac ?? 0.04)));
  let cut = Math.round(a.width + dir * step);
  if (cut < 2 || cut > cw - 2) return null;
  if (opt.snap !== false) {
    // the thinnest column within half a step of the target, ties to the target
    let best = cut, bestInk = colInk[cut];
    const r = Math.max(1, Math.floor(step / 2));
    for (let x = Math.max(1, cut - r); x <= Math.min(cw - 2, cut + r); x++) {
      if (colInk[x] < bestInk - 1e-9 || (colInk[x] <= bestInk + 1e-9 && Math.abs(x - cut) < Math.abs(best - cut))) { best = x; bestInk = colInk[x]; }
    }
    cut = best;
  }
  // trim each side to its ink columns (one pixel of pad), keeping the height
  const bounds = (x0: number, x1: number): [number, number] => {
    let lo = -1, hi = -1;
    for (let x = x0; x < x1; x++) if (colInk[x] > 0.02) { if (lo < 0) lo = x; hi = x; }
    if (lo < 0) return [x0, x1];
    return [Math.max(x0, lo - 1), Math.min(x1, hi + 2)];
  };
  const slice = (c: HTMLCanvasElement, x0: number, x1: number): string => {
    const sw = Math.max(1, x1 - x0);
    const o = document.createElement('canvas');
    o.width = sw;
    o.height = ch;
    o.getContext('2d')!.drawImage(c, x0, 0, sw, ch, 0, 0, sw, ch);
    return o.toDataURL('image/png');
  };
  const make = (x0: number, x1: number): InkCrop => ({
    src: slice(main, x0, x1),
    baseSrc: base ? slice(base, x0, x1) : null,
    width: Math.max(1, x1 - x0),
    height: ch,
    baselineRatio: maxAsc / ch,
    heightEm: ch * emPerPx,
  });
  const [l0, l1] = bounds(0, cut);
  const [r0, r1] = bounds(cut, cw);
  return [make(l0, l1), make(r0, r1)];
}

/** Composite two v2 word crops side-by-side, baseline-aligned, into one. */
export async function mergeInkCrops(a: InkCrop, b: InkCrop): Promise<InkCrop> {
  const [ai, bi, ab, bb] = await Promise.all([
    decode(a.src), decode(b.src),
    a.baseSrc ? decode(a.baseSrc) : Promise.resolve(null),
    b.baseSrc ? decode(b.baseSrc) : Promise.resolve(null),
  ]);

  const aAsc = a.baselineRatio * a.height;
  const bAsc = b.baselineRatio * b.height;
  const maxAsc = Math.max(aAsc, bAsc);
  const maxDesc = Math.max(a.height - aAsc, b.height - bAsc);
  const gap = Math.round(Math.max(a.height, b.height) * 0.12);
  const cw = Math.max(1, Math.round(a.width + gap + b.width));
  const ch = Math.max(1, Math.ceil(maxAsc + maxDesc));
  const emPerPx = a.height > 0 ? a.heightEm / a.height : 0;

  const composite = (ia: HTMLImageElement, ib: HTMLImageElement): string => {
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(ia, 0, maxAsc - aAsc, a.width, a.height);
    ctx.drawImage(ib, a.width + gap, maxAsc - bAsc, b.width, b.height);
    return c.toDataURL('image/png');
  };

  return {
    src: composite(ai, bi),
    baseSrc: ab && bb ? composite(ab, bb) : null,
    width: cw,
    height: ch,
    baselineRatio: maxAsc / ch,
    heightEm: ch * emPerPx,
  };
}
