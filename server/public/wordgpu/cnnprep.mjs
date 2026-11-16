// The CNN's INPUT: ink pixels -> the 32x32 raster the model was trained on.
//
// This is its own module for two reasons, and both have already cost something
// once. The first is correctness: the model's accuracy is a property of the
// exact raster it is handed, `cnnlab/embed-bank.cjs` exists partly to prove
// that a JS port of `embed.py`'s `normalize` reproduces the Python numbers, and
// every additional copy is another chance to drift — silently, since a shifted
// distribution degrades scores rather than throwing. Three callers need it now:
// the page scorer (`cnnscorer.mjs`), the wordphoto LIBRARY product
// (`library/src/cnnscore.js`), and the offline embedder that builds the tables
// they both compare against (`scripts/build-wordphoto-training.mjs`). All three
// must agree by construction, not by review.
//
// The second is bundling. `cnnscorer.mjs` reaches `charscore.mjs` through a
// SERVER-ABSOLUTE dynamic import, which is right for a page served from `/` and
// unresolvable for esbuild — so importing the preprocessing from there dragged
// the whole attach path into the library bundle and broke the build. Nothing in
// this file imports anything.

const DIM = 64, SIZE = 32, INK = 24
export const CNN_DIM = DIM, CNN_SIZE = SIZE, CNN_INK = INK

/**
 * Ink plane -> the net's 32x32 input: crop to ink, per-crop contrast
 * normalisation, fit the long side to 24px preserving aspect (area average),
 * centre. `size`/`inkBox` default to the shipped 32/24; the 24x24 `tiny`
 * architecture (cnnlab/embed.py ARCHES) passes 24/18.
 *
 * CONTRAST NORMALISATION is measured, not cosmetic: the glyph crops the model
 * trained on are pure black on white (ink 1.000) while `segPage` re-renders
 * page ink at ONE normalised darkness (0.647). A raster CNN sees those as
 * different images; the matcher never did, because it thresholds to a binary
 * mask first. Rescaling each crop by its own peak closes the gap and is a NO-OP
 * on the saturated training crops, so the model did not need retraining.
 *
 * The resize is AREA AVERAGING rather than canvas `drawImage`, whose downscale
 * filter is implementation-defined — that would make the preprocessing depend
 * on which canvas implementation is installed.
 */
export function normalizeInk(ink, w, h, size = SIZE, inkBox = INK) {
  let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    if (ink[y * w + x] > 0.15) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  const out = new Float32Array(size * size)
  if (maxX < 0) return out
  const cw = maxX - minX + 1, ch = maxY - minY + 1
  const crop = new Float32Array(cw * ch)
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) crop[y * cw + x] = ink[(y + minY) * w + (x + minX)]
  let peak = 0
  for (let i = 0; i < crop.length; i++) if (crop[i] > peak) peak = crop[i]
  if (peak > 0.05 && peak < 0.999) for (let i = 0; i < crop.length; i++) crop[i] = Math.min(1, crop[i] / peak)
  const s = inkBox / Math.max(ch, cw)
  const nh = Math.max(1, Math.round(ch * s)), nw = Math.max(1, Math.round(cw * s))
  const r = new Float32Array(nw * nh)
  const fx = cw / nw, fy = ch / nh
  for (let y = 0; y < nh; y++) {
    const y0 = y * fy, y1 = (y + 1) * fy, iy0 = Math.floor(y0), iy1 = Math.min(ch, Math.ceil(y1))
    for (let x = 0; x < nw; x++) {
      const x0 = x * fx, x1 = (x + 1) * fx, ix0 = Math.floor(x0), ix1 = Math.min(cw, Math.ceil(x1))
      let ss = 0, wsum = 0
      for (let yy = iy0; yy < iy1; yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy)
        if (wy <= 0) continue
        for (let xx = ix0; xx < ix1; xx++) {
          const wx = Math.min(x1, xx + 1) - Math.max(x0, xx)
          if (wx <= 0) continue
          ss += crop[yy * cw + xx] * wx * wy
          wsum += wx * wy
        }
      }
      r[y * nw + x] = wsum > 0 ? ss / wsum : 0
    }
  }
  const oy = (size - nh) >> 1, ox = (size - nw) >> 1
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) out[(y + oy) * size + x + ox] = r[y * nw + x]
  return out
}

/** A lattice segment's pixels as an ink plane — segmentCloud's crop exactly:
 *  the same 3px margin and the same 3x3 min over the source. */
export function cropInk(src, natW, natH, pixels) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const [x, y] of pixels) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const m = 3, W = maxX - minX + 1 + 2 * m, H = maxY - minY + 1 + 2 * m
  const lum = new Float32Array(W * H).fill(255)
  for (const [x, y] of pixels)
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const sx = x + dx, sy = y + dy
      if (sx < 0 || sy < 0 || sx >= natW || sy >= natH) continue
      const si = (sy * natW + sx) * 4
      const di = (sy - minY + m) * W + (sx - minX + m)
      const l = src[si] * 0.299 + src[si + 1] * 0.587 + src[si + 2] * 0.114
      if (l < lum[di]) lum[di] = l
    }
  const ink = new Float32Array(W * H)
  for (let i = 0; i < ink.length; i++) ink[i] = 1 - lum[i] / 255
  return { ink, W, H }
}
