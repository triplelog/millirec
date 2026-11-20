/**
 * Rule-guided dewarp: make every traced rule exactly straight.
 *
 * The page-quad dewarp corrects PERSPECTIVE; it cannot flatten paper
 * CURVATURE, and the traces prove the corpus has plenty (doubledia bows 32px
 * at a 50px line height). The tracer follows the bend faithfully — and then
 * every consumer of a baseline collapses the trace to one flat y, so a letter
 * sitting ON the curved rule in the image measures half a line away from the
 * baseline the pipeline hands it. Marks, x-heights, band cuts and Pass B's
 * baseline attach all inherit that error.
 *
 * The traces themselves are the calibration: each rule's smoothed curve maps
 * to its median y, columns are remapped by piecewise-linear interpolation
 * between rules (clamped shift beyond the first/last), and the warp is
 * VERTICAL-ONLY, so x positions — vertical rule traces included — survive.
 * After the remap the traces are rewritten flat, which is what makes the
 * downstream flat-baseline assumption TRUE instead of wrong.
 *
 * In-place on every buffer handed in (the gray page + any RGBA planes), so
 * Pass B's crops, the segmentation scratch page and the labs all see one
 * geometry. No-ops (and reports why) when there is nothing to do: fewer than
 * two rules, deviation under `minDev`, or traces that cross after smoothing —
 * crossing traces are garbage, and warping by garbage is worse than the bend.
 */

export interface DewarpResult {
  applied: boolean
  maxDev: number
  reason?: 'few-rules' | 'flat' | 'crossing'
}

export function dewarpByRules(
  gray: Uint8Array | null,
  rgba: (Uint8ClampedArray | null)[],
  W: number,
  H: number,
  rules: { y: Float32Array | number[]; thickness: number }[],
  opts: { minDev?: number; smoothR?: number } = {},
): DewarpResult {
  const minDev = opts.minDev ?? 1.5
  const smoothR = opts.smoothR ?? 15
  if (rules.length < 2) return { applied: false, maxDev: 0, reason: 'few-rules' }

  // Smoothed trace per rule + its flat target (the median).
  const K = rules.length
  const sm: Float32Array[] = []
  const target = new Float32Array(K)
  for (let k = 0; k < K; k++) {
    const raw = rules[k].y
    const t = new Float32Array(W)
    // box-smooth along x, tolerant of traces shorter than W
    let acc = 0
    let n = 0
    const at = (x: number) => Number(raw[Math.max(0, Math.min(raw.length - 1, x))])
    for (let x = -smoothR; x <= smoothR; x++) { acc += at(x); n++ }
    for (let x = 0; x < W; x++) {
      t[x] = acc / n
      acc += at(x + smoothR + 1) - at(x - smoothR)
    }
    sm.push(t)
    const s = Array.from(t).sort((a, b) => a - b)
    target[k] = s[s.length >> 1]
  }
  const order = Array.from({ length: K }, (_, k) => k).sort((a, b) => target[a] - target[b])

  let maxDev = 0
  for (let k = 0; k < K; k++) {
    const t = sm[k]
    for (let x = 0; x < W; x++) maxDev = Math.max(maxDev, Math.abs(t[x] - target[k]))
  }
  if (maxDev < minDev) return { applied: false, maxDev, reason: 'flat' }

  // Monotonicity: smoothed traces must not cross anywhere.
  for (let x = 0; x < W; x++) {
    for (let j = 1; j < K; j++) {
      if (sm[order[j]][x] - sm[order[j - 1]][x] < 2) return { applied: false, maxDev, reason: 'crossing' }
    }
  }

  const planes: { data: Uint8Array | Uint8ClampedArray; stride: number }[] = []
  if (gray) planes.push({ data: gray, stride: 1 })
  for (const p of rgba) if (p) planes.push({ data: p, stride: 4 })

  // ROW BY ROW, not column by column. The mapping is per column, which is why
  // the first version walked columns — but a column walk on a row-major buffer
  // misses cache on every single pixel, and it re-solved the piecewise-linear
  // knot search per pixel even though the knots (`target`) do not depend on x.
  // Per destination ROW the knot pair and the interpolation weight are FIXED,
  // so the inner loop is two smoothed traces blended, and both the source
  // reads (srcY varies smoothly with x, so they stay within a row or two) and
  // the destination writes are sequential. Same arithmetic, same rounding.
  const dstCol = new Float32Array(K)
  for (let j = 0; j < K; j++) dstCol[j] = target[order[j]]
  const srcs = planes.map((p) => (p.data as Uint8Array).slice())
  // AN RGBA PLANE THAT IS THE GRAY PLANE IN FOUR CHANNELS IS WARPED ONCE.
  // `pass.flat` is the render `pass.gray` was read from (R = G = B = gray,
  // A = 255), and nothing between Pass A and here tells them apart on most
  // pages — so its warp is the gray's warp, written four times. Checked, not
  // assumed: a plane is only mirrored when every pixel matches, and a plane
  // that differs anywhere (a dot lattice erased from the gray alone) is
  // interpolated on its own as before. Same output either way.
  const mirrorOfGray = planes.map((p, pi) => {
    if (p.stride !== 4 || !gray) return false
    const g = srcs[0], q = srcs[pi]
    for (let i = 0, o = 0; i < W * H; i++, o += 4) {
      const v = g[i]
      if (q[o] !== v || q[o + 1] !== v || q[o + 2] !== v || q[o + 3] !== 255) return false
    }
    return true
  })
  // rowFy is float64: the weight was a float64 in the per-pixel form, and a float32 copy of it rounds the interpolation differently
  const rowYa = new Int32Array(W), rowYb = new Int32Array(W), rowFy = new Float64Array(W)
  let knot = 1
  for (let y = 0; y < H; y++) {
    // which pair of rules this row falls between, and how far along it sits
    let A: Float32Array, B: Float32Array | null = null, f = 0, shift = 0
    if (y <= dstCol[0]) { A = sm[order[0]]; shift = -dstCol[0] }
    else if (y >= dstCol[K - 1]) { A = sm[order[K - 1]]; shift = -dstCol[K - 1] }
    else {
      if (knot < 1) knot = 1
      while (dstCol[knot] < y) knot++
      while (knot > 1 && dstCol[knot - 1] >= y) knot--
      f = (y - dstCol[knot - 1]) / Math.max(1e-6, dstCol[knot] - dstCol[knot - 1])
      A = sm[order[knot - 1]]
      B = sm[order[knot]]
    }
    const row = y * W
    // the source rows and weights of this destination row, once per row
    for (let x = 0; x < W; x++) {
      const a = A[x]
      const srcY = B ? a + f * (B[x] - a) : y + (a + shift)
      const y0 = Math.floor(srcY)
      const fy = srcY - y0
      rowYa[x] = (y0 < 0 ? 0 : y0 > H - 1 ? H - 1 : y0) * W + x
      const yb0 = y0 + 1
      rowYb[x] = (yb0 < 0 ? 0 : yb0 > H - 1 ? H - 1 : yb0) * W + x
      rowFy[x] = fy
    }
    for (let pi = 0; pi < planes.length; pi++) {
      const { data, stride } = planes[pi]
      const src = srcs[pi]
      if (stride === 1) {
        for (let x = 0; x < W; x++) {
          const fy = rowFy[x]
          data[row + x] = Math.round(src[rowYa[x]] * (1 - fy) + src[rowYb[x]] * fy)
        }
      } else if (mirrorOfGray[pi]) {
        const g = planes[0].data
        for (let x = 0, o = row * 4; x < W; x++, o += 4) {
          const v = g[row + x]
          data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255
        }
      } else {
        // The RGBA planes are grayscale renders (R = G = B, A = 255 — see
        // gray_to_rgba, and every later writer keeps it so), so the three
        // colour channels are one interpolation and alpha interpolates to
        // itself. Each channel is still checked against the first: a plane
        // that ever differed would be computed per channel, exactly as before.
        for (let x = 0; x < W; x++) {
          const fy = rowFy[x]
          const o = (row + x) * 4, oa = rowYa[x] * 4, ob = rowYb[x] * 4
          const a0 = src[oa], b0 = src[ob]
          const v0 = Math.round(a0 * (1 - fy) + b0 * fy)
          data[o] = v0
          for (let ch = 1; ch < 4; ch++) {
            const ac = src[oa + ch], bc = src[ob + ch]
            data[o + ch] = ac === a0 && bc === b0 ? v0
              : ac === bc ? ac
              : Math.round(ac * (1 - fy) + bc * fy)
          }
        }
      }
    }
  }

  // The traces are now the geometry they describe: flat at their targets.
  for (let k = 0; k < K; k++) {
    const raw = rules[k].y
    for (let x = 0; x < raw.length; x++) raw[x] = target[k]
  }
  return { applied: true, maxDev }
}
