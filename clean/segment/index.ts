/**
 * word-segmenter
 *
 * Detects word bounding boxes in a cleaned (black-on-white) handwriting image.
 *
 * Pipeline:
 *  1. Extract binary ink mask from the image (dark pixels = ink). The threshold
 *     is computed per-image with Otsu's method unless autoThreshold is off.
 *  2. Optionally dilate horizontally so a word's letters fuse into one blob.
 *  3. Smooth with a 3×3 morphological CLOSE + anti-aliased halo (boxBlur3).
 *  4. Find word boxes + reading order by horizontal/vertical projection.
 *     (This path once took its boxes from Tesseract.js; that dependency is
 *     gone — cleanPage() segments with ccWordBoxes and never used it.)
 *  5. Flag boxes that look mis-segmented. Gap metrics are normalized by a
 *     blended reference height (per-line median shrunk toward the page median)
 *     before z-scoring, so mixed writing sizes don't skew the statistics.
 *     Page-wide gap/distance statistics are computed once, on the first
 *     refinement round, and frozen for later rounds — otherwise each round's
 *     merges remove the small distances from the distribution and drag the
 *     z-scores of the surviving pairs toward "merge":
 *     - SPLIT candidates: internal stroke gap ≥ splitZ σ above page average
 *       (might be two words run together).
 *     - MERGE candidates: distance to the next box ≤ −mergeZ σ below average
 *       OR smaller than mergeAbsFrac × reference height in absolute terms
 *       (might be one word split in two).
 *  6. Geometry decides each candidate, recording a signed margin from the
 *     decision boundary. The absolute height-normalized gap (splitMinGapFrac /
 *     mergeAbsFrac) is the primary signal; the z-score is a page-relative
 *     sanity check. Flag → decide → apply iterates up to 3 rounds.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WordBox {
  x: number
  y: number
  w: number
  h: number
  confidence?: number
  text?: string
}

export interface WordLine {
  words: WordBox[]
}

export type BoxFlag = 'normal' | 'split-candidate' | 'merge-candidate'

export interface FlaggedBox {
  box: WordBox
  flag: BoxFlag
  geo: number          // z-score excess past the flagging threshold
  internalGap: number  // largest empty-column gap inside the box (px) — max of outer/inner
  internalGapAt: number  // centre x of that gap (−1 if none)
  /** Top-k internal gaps from the full outer box, largest first. */
  internalGaps: { gap: number; at: number }[]
  /** X-range after trimming the outermost 25 ink columns per side (null if too narrow). */
  innerBox: { x: number; w: number } | null
  /** Top-k gaps computed within the inner box only. */
  innerGaps: { gap: number; at: number }[]
  distNext: number | null  // gap to the next box on the same line (null for last)
  /** z-score of the effective gap (max of inner/outer) normalized by effH. */
  zGap: number
  /** z-score of distNext normalized by effH (null for last box in line). */
  zDist: number | null
  /** Blended per-line/page reference height used for normalization. */
  effH: number
}

export interface FlaggedLine {
  boxes: FlaggedBox[]
}

export interface PageStats {
  /** Mean/std of internal gaps, in units of the blended reference height. */
  gapAvg: number; gapStd: number
  /** Mean/std of inter-box distances, in units of the blended reference height. */
  distAvg: number; distStd: number
  medianWidth: number
  medianHeight: number
}

export interface SegmenterOptions {
  /** Darkness threshold — pixels with luminance < this are ink (0–255, default 128). */
  inkThreshold: number
  /** Compute the ink threshold per-image with Otsu's method (default true). */
  autoThreshold: boolean
  /** Horizontal dilation (px) applied before binarization to join letter blobs (default 1). */
  dilateX: number
  /** Word-gap factor for the projection fallback: gap ≥ round(lineH × factor) (default 0.55). */
  wordGapFactor: number
  /** Z-score threshold above which a box's internal gap is flagged for a split (default 2.4). */
  splitZ: number
  /** Z-score threshold below which a pair's inter-box gap is flagged for a merge (default 1.5). */
  mergeZ: number
  /** Absolute inter-box gap fraction of reference height that also triggers a merge (default 0.40). */
  mergeAbsFrac: number
  /** Minimum box width to keep (default 8 px). */
  minWidth: number
  /** Minimum box height to keep (default 10 px). */
  minHeight: number
  /** Stroke trim per row as fraction of effective word height (default 0.30). */
  strokeTrimFrac: number
  /** Minimum gap÷height ratio required to commit a split (default 0.40). */
  splitMinGapFrac: number
  /** Additional z-score margin beyond splitZ required to commit a split (default 0.5). */
  splitZExtra: number
}

export const DEFAULT_SEGMENTER_OPTIONS: SegmenterOptions = {
  inkThreshold: 128,
  autoThreshold: true,
  dilateX: 1,
  wordGapFactor: 0.55,
  splitZ: 2.4,
  mergeZ: 1.5,
  mergeAbsFrac: 0.40,
  minWidth: 8,
  minHeight: 10,
  strokeTrimFrac: 0.30,
  splitMinGapFrac: 0.40,
  splitZExtra: 0.5,
}

export interface SegmentResult {
  source: 'projection'
  /** Cleaned black-on-white canvas the boxes were found on. */
  binaryCanvas: HTMLCanvasElement
  /** Binary ink mask (1 = ink, 0 = background). */
  inkMask: Uint8Array
  W: number
  H: number
  /** Ink threshold actually used (Otsu result when autoThreshold). */
  inkThresholdUsed: number
  /** Raw word boxes from projection (before box-division review). */
  rawLines: WordLine[]
  /** Same lines, each box annotated with its split/merge flag. */
  flaggedLines: FlaggedLine[]
  /** Per-candidate geometry decisions with signed boundary margins. */
  geoDecisions: GeoDecision[]
  /** Lines after orphan mark absorption (before gap analysis). */
  absorbedLines: WordLine[]
  /** Lines after geometry-only split/merge refinement. */
  refinedLines: WordLine[]
  /** Page-wide statistics used for z-score flagging. */
  pageStats: PageStats
  /** Flagging + geometry data from every iteration round (final round last). */
  allRounds: Array<{ flaggedLines: FlaggedLine[]; geoDecisions: GeoDecision[] }>
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function meanStd(xs: number[]): { avg: number; std: number } {
  if (!xs.length) return { avg: 0, std: 0 }
  const avg = xs.reduce((s, v) => s + v, 0) / xs.length
  const std = Math.sqrt(xs.reduce((s, v) => s + (v - avg) ** 2, 0) / xs.length)
  return { avg, std }
}

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[s.length >> 1]
}

/** Scale converting reference-height fractions to σ-comparable margin units. */
const FRAC_TO_Z = 5

/** How many top internal gaps to try as split positions. */
const TOP_GAPS = 2

/** Pseudo-count of page-median boxes blended into each line's height estimate. */
const HEIGHT_PRIOR = 3

// ── Ink mask ─────────────────────────────────────────────────────────────────

/** Convert a cleaned image to a binary ink mask: dark pixels → 1, light → 0. */
export function inkMaskFromImageData(imageData: ImageData, threshold = 128): Uint8Array {
  const { data, width, height } = imageData
  const mask = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const lum = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3
    mask[i] = lum < threshold ? 1 : 0
  }
  return mask
}

/**
 * Otsu's threshold on the luminance histogram: picks the cut that maximizes
 * between-class variance. Result is clamped so degenerate (near-blank) images
 * still binarize sensibly; ink = luminance < returned value.
 */
export function otsuThreshold(imageData: ImageData): number {
  const { data, width, height } = imageData
  const n = width * height
  const hist = new Float64Array(256)
  for (let i = 0; i < n; i++) {
    const lum = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3
    hist[lum > 255 ? 255 : Math.round(lum)]++
  }
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]
  let sumB = 0, wB = 0, best = -1, bestT = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = n - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) ** 2
    if (between > best) { best = between; bestT = t }
  }
  return Math.min(240, Math.max(16, bestT + 1))
}

// ── Morphological smoothing ───────────────────────────────────────────────────

/** 3×3 morphological CLOSE (dilate then erode, replicate borders). Fills 1px nicks. */
export function morphClose3(mask: Uint8Array, W: number, H: number): Uint8Array {
  const at = (m: Uint8Array, x: number, y: number) =>
    m[Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))]
  // dilate
  const dil = new Uint8Array(W * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let v = 0
      for (let dy = -1; dy <= 1 && !v; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (at(mask, x + dx, y + dy)) { v = 1; break }
      dil[y * W + x] = v
    }
  // erode
  const ero = new Uint8Array(W * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let v = 1
      for (let dy = -1; dy <= 1 && v; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (!at(dil, x + dx, y + dy)) { v = 0; break }
      ero[y * W + x] = v
    }
  return ero
}

/** 3×3 box blur (replicate borders) of a 0/1 mask → 0..1 float (anti-aliased halo). */
export function boxBlur3(mask: Uint8Array, W: number, H: number): Float32Array {
  const at = (x: number, y: number) =>
    mask[Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))]
  const out = new Float32Array(W * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let s = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += at(x + dx, y + dy)
      out[y * W + x] = s / 9
    }
  return out
}

// ── Binary canvas ─────────────────────────────────────────────────────────────

/**
 * Build the black-on-white canvas and the ink mask used for
 * gap analysis. Mirrors the app's `binaryCanvas(a, dilateX)`.
 *
 * @param imageData  Source image (ideally already cleaned / black-on-white).
 * @param dilateX    Horizontal dilation px to fuse letter blobs into word blobs.
 * @param inkThreshold  Pixels with luminance < this are ink.
 */
export function buildBinaryCanvas(
  imageData: ImageData,
  dilateX = 1,
  inkThreshold = 128,
): { canvas: HTMLCanvasElement; inkMask: Uint8Array } {
  const { width: W, height: H } = imageData

  // Raw ink mask from image darkness.
  const rawMask = inkMaskFromImageData(imageData, inkThreshold)

  // Dilate horizontally so letters within a word fuse into one blob.
  const m = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!rawMask[y * W + x]) continue
      const lo = Math.max(0, x - dilateX)
      const hi = Math.min(W - 1, x + dilateX)
      for (let xx = lo; xx <= hi; xx++) m[y * W + xx] = 1
    }
  }

  // Smooth contours: close → anti-aliased halo on the outside only.
  const sm = morphClose3(m, W, H)
  const bl = boxBlur3(sm, W, H)

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  const id = ctx.createImageData(W, H)
  const d = id.data
  for (let i = 0; i < W * H; i++) {
    // Core stroke pixel ⇒ solid black; outside edge ⇒ grey AA from the blur.
    const g = sm[i] ? 0 : Math.round(255 * (1 - bl[i]))
    d[i * 4] = g; d[i * 4 + 1] = g; d[i * 4 + 2] = g; d[i * 4 + 3] = 255
  }
  ctx.putImageData(id, 0, 0)

  return { canvas, inkMask: rawMask }
}

// ── Projection-based fallback ─────────────────────────────────────────────────

/**
 * Segment words by horizontal projection.
 * Finds text-band rows via row ink sum, then splits within each band at
 * column gaps wider than `wordGapFactor × lineHeight`.
 */
export function segmentByProjection(
  inkMask: Uint8Array,
  W: number,
  H: number,
  wordGapFactor = 0.55,
  minWidth = 8,
  minHeight = 10,
): WordLine[] {
  // Row ink sums → text bands.
  const rowInk = new Float32Array(H)
  let maxRow = 0
  for (let y = 0; y < H; y++) {
    let s = 0
    for (let x = 0; x < W; x++) s += inkMask[y * W + x]
    rowInk[y] = s
    if (s > maxRow) maxRow = s
  }
  const rowThresh = Math.max(1, maxRow * 0.06)
  const bands: { top: number; bottom: number }[] = []
  let by = -1
  for (let y = 0; y < H; y++) {
    if (rowInk[y] > rowThresh) {
      if (by < 0) by = y
    } else if (by >= 0) {
      bands.push({ top: by, bottom: y - 1 })
      by = -1
    }
  }
  if (by >= 0) bands.push({ top: by, bottom: H - 1 })

  // Merge bands that are ≤3px apart.
  const merged: { top: number; bottom: number }[] = []
  for (const b of bands) {
    const last = merged[merged.length - 1]
    if (last && b.top - last.bottom < 4) last.bottom = b.bottom
    else merged.push({ ...b })
  }

  const lines: WordLine[] = []
  for (const b of merged) {
    const h = b.bottom - b.top + 1
    if (h < minHeight) continue

    const colInk = new Float32Array(W)
    for (let x = 0; x < W; x++) {
      let s = 0
      for (let y = b.top; y <= b.bottom; y++) s += inkMask[y * W + x]
      colInk[x] = s
    }

    const gapThresh = Math.max(4, Math.round(h * wordGapFactor))
    const words: WordBox[] = []
    let wx = -1
    let gap = 0
    for (let x = 0; x < W; x++) {
      if (colInk[x] > 0) {
        if (wx < 0) wx = x
        gap = 0
      } else if (wx >= 0) {
        gap++
        if (gap >= gapThresh) {
          const w = x - gap - wx
          if (w >= minWidth) words.push({ x: wx, y: b.top, w, h })
          wx = -1
        }
      }
    }
    if (wx >= 0) {
      const w = W - wx
      if (w >= minWidth) words.push({ x: wx, y: b.top, w, h })
    }
    if (words.length) lines.push({ words })
  }
  return lines
}

// ── Internal gap analysis ─────────────────────────────────────────────────────

/**
 * The k largest empty-column runs INSIDE a box (each bounded by ink on both
 * sides), largest first. Big internal gaps indicate the box may hold two words.
 */
export function topInternalGaps(
  inkMask: Uint8Array,
  W: number,
  box: WordBox,
  k = TOP_GAPS,
): { gap: number; at: number }[] {
  const runs: { gap: number; at: number }[] = []
  let runStart = -1, seenInk = false
  const x1 = box.x + box.w - 1
  const y1 = box.y + box.h - 1
  for (let x = box.x; x <= x1; x++) {
    let has = false
    for (let y = box.y; y <= y1; y++) {
      if (inkMask[y * W + x]) { has = true; break }
    }
    if (has) {
      if (runStart >= 0) {
        runs.push({ gap: x - runStart, at: Math.round((runStart + x - 1) / 2) })
        runStart = -1
      }
      seenInk = true
    } else if (seenInk && runStart < 0) {
      runStart = x
    }
  }
  runs.sort((a, b) => b.gap - a.gap)
  return runs.slice(0, k)
}

/**
 * Per-row stroke-trimmed gap analysis. For each pixel row, find the leftmost
 * and rightmost ink pixel, then discard the outermost `trimPx` pixels from each
 * end of that row. A column is "occupied" if surviving ink from any row lands on
 * it. This strips thin horizontal strokes (t-bars, f-bars, underlines) that
 * extend past word boundaries and hide the inter-word gap.
 */
function innerBoxGaps(
  inkMask: Uint8Array,
  W: number,
  box: WordBox,
  trimPx = 25,
  k = TOP_GAPS,
): { innerBox: { x: number; w: number } | null; gaps: { gap: number; at: number }[] } {
  const bx = box.x, by = box.y, bx1 = box.x + box.w - 1, by1 = box.y + box.h - 1
  const occupied = new Uint8Array(box.w)

  for (let y = by; y <= by1; y++) {
    let rowLeft = -1, rowRight = -1
    for (let x = bx; x <= bx1; x++) {
      if (inkMask[y * W + x]) {
        if (rowLeft < 0) rowLeft = x
        rowRight = x
      }
    }
    if (rowLeft < 0) continue
    const sl = rowLeft + trimPx, sr = rowRight - trimPx
    if (sl > sr) continue
    for (let x = Math.max(bx, sl); x <= Math.min(bx1, sr); x++) {
      if (inkMask[y * W + x]) occupied[x - bx] = 1
    }
  }

  let innerLeft = -1, innerRight = -1
  for (let i = 0; i < box.w; i++) {
    if (occupied[i]) {
      if (innerLeft < 0) innerLeft = bx + i
      innerRight = bx + i
    }
  }
  if (innerLeft < 0) return { innerBox: null, gaps: [] }

  const innerBox = { x: innerLeft, w: innerRight - innerLeft + 1 }
  const runs: { gap: number; at: number }[] = []
  let runStart = -1, seenInk = false
  for (let x = innerLeft; x <= innerRight; x++) {
    if (occupied[x - bx]) {
      if (runStart >= 0) {
        runs.push({ gap: x - runStart, at: Math.round((runStart + x - 1) / 2) })
        runStart = -1
      }
      seenInk = true
    } else if (seenInk && runStart < 0) {
      runStart = x
    }
  }
  runs.sort((a, b) => b.gap - a.gap)
  return { innerBox, gaps: runs.slice(0, k) }
}

/** Largest empty-column run inside a box (see topInternalGaps). */
export function maxInternalGap(
  inkMask: Uint8Array,
  W: number,
  box: WordBox,
): { gap: number; at: number } {
  const [best] = topInternalGaps(inkMask, W, box, 1)
  return best ?? { gap: 0, at: -1 }
}

// ── Box-division flagging ─────────────────────────────────────────────────────

/**
 * Annotate each box with a split/merge flag based on page-wide z-score
 * statistics. No OCR is used here — purely geometric.
 *
 * Gap metrics are normalized by a blended reference height before z-scoring:
 * each line's median box height is shrunk toward the page-wide median with a
 * pseudo-count prior, so short lines borrow strength from the page while big
 * and small handwriting on the same page are still judged at their own scale.
 *
 * When `fixedStats` is given, its gap/distance mean and std are used for the
 * z-scores instead of statistics recomputed from `lines`. Refinement rounds
 * after the first pass the first round's stats here — recomputing after each
 * round's merges removes the small distances from the distribution and drags
 * the z-scores of every surviving pair toward "merge".
 */
export function flagBoxDivisions(
  lines: WordLine[],
  inkMask: Uint8Array,
  W: number,
  opts: Pick<SegmenterOptions, 'splitZ' | 'mergeZ' | 'mergeAbsFrac' | 'strokeTrimFrac'>,
  fixedStats?: Pick<PageStats, 'gapAvg' | 'gapStd' | 'distAvg' | 'distStd'>,
): { lines: FlaggedLine[]; stats: PageStats } {
  const lineWords = lines.map((ln) => [...ln.words].sort((a, b) => a.x - b.x))

  // Blended reference height per line.
  const allHeights = lineWords.flatMap((ws) => ws.map((w) => w.h))
  const pageH = median(allHeights) || 1
  const effHs = lineWords.map((ws) => {
    const lineH = median(ws.map((w) => w.h)) || pageH
    return (ws.length * lineH + HEIGHT_PRIOR * pageH) / (ws.length + HEIGHT_PRIOR)
  })

  // Page-wide samples of height-normalized gaps and distances.
  const normGaps: number[] = []
  const normDists: number[] = []
  const widths: number[] = []
  const lineGaps: { gap: number; at: number }[][][] = []
  const lineInner: Array<Array<{ box: { x: number; w: number } | null; gaps: { gap: number; at: number }[] }>> = []
  lineWords.forEach((ws, li) => {
    const effH = effHs[li]
    const gapsPerBox: { gap: number; at: number }[][] = []
    const innerPerBox: Array<{ box: { x: number; w: number } | null; gaps: { gap: number; at: number }[] }> = []
    for (let i = 0; i < ws.length; i++) {
      const gaps = topInternalGaps(inkMask, W, ws[i])
      gapsPerBox.push(gaps)
      const trimPx = Math.max(1, Math.round(opts.strokeTrimFrac * effH))
      const { innerBox: ib, gaps: innerGaps } = innerBoxGaps(inkMask, W, ws[i], trimPx)
      innerPerBox.push({ box: ib, gaps: innerGaps })
      // Use the max of outer/inner gap for the page-wide z-score distribution.
      const effectiveGap = Math.max(gaps[0]?.gap ?? 0, innerGaps[0]?.gap ?? 0)
      normGaps.push(effectiveGap / effH)
      widths.push(ws[i].w)
      if (i < ws.length - 1) normDists.push((ws[i + 1].x - (ws[i].x + ws[i].w)) / effH)
    }
    lineGaps.push(gapsPerBox)
    lineInner.push(innerPerBox)
  })
  const gS = fixedStats ? { avg: fixedStats.gapAvg, std: fixedStats.gapStd } : meanStd(normGaps)
  const dS = fixedStats ? { avg: fixedStats.distAvg, std: fixedStats.distStd } : meanStd(normDists)

  const flagged = lineWords.map((ws, li) => {
    const effH = effHs[li]
    const boxes: FlaggedBox[] = ws.map((box, i) => {
      const gaps = lineGaps[li][i]
      const { box: innerBox, gaps: innerGaps } = lineInner[li][i]
      const outerGap = gaps[0]?.gap ?? 0
      const innerGap = innerGaps[0]?.gap ?? 0
      // Effective gap = max of outer (original) and inner (stroke-trimmed) analyses.
      const effectiveGap = Math.max(outerGap, innerGap)
      const gap = effectiveGap
      const at = effectiveGap > outerGap ? (innerGaps[0]?.at ?? -1) : (gaps[0]?.at ?? -1)
      const distNext = i < ws.length - 1 ? ws[i + 1].x - (box.x + box.w) : null

      const zGap = gS.std > 0 ? (gap / effH - gS.avg) / gS.std : 0
      const zDist = distNext !== null && dS.std > 0 ? (distNext / effH - dS.avg) / dS.std : null

      let flag: BoxFlag = 'normal'
      let geo = 0

      // Split candidate: big internal gap.
      if (zGap >= opts.splitZ) {
        flag = 'split-candidate'
        geo = zGap - opts.splitZ
      }

      // Merge candidate: suspiciously close to next box.
      if (distNext !== null && flag === 'normal') {
        const mZ = zDist !== null ? -zDist - opts.mergeZ : -Infinity
        const mAbs = FRAC_TO_Z * (opts.mergeAbsFrac - distNext / effH)
        const m = Math.max(mZ, mAbs)
        if (m >= 0) {
          flag = 'merge-candidate'
          geo = m
        }
      }

      return { box, flag, geo, internalGap: gap, internalGapAt: at, internalGaps: gaps, innerBox, innerGaps, distNext, zGap, zDist, effH }
    })
    return { boxes }
  })

  return {
    lines: flagged,
    stats: {
      gapAvg: gS.avg, gapStd: gS.std,
      distAvg: dS.avg, distStd: dS.std,
      medianWidth: median(widths),
      medianHeight: pageH,
    },
  }
}

// ── Geometry decisions ────────────────────────────────────────────────────────

export interface GeoDecision {
  kind: 'split' | 'merge'
  lineIdx: number
  /** Index of the (first) box involved, in x-sorted line order. */
  boxIdx: number
  /** Split column (image x) for split decisions. */
  at?: number
  committed: boolean
  /** Signed distance from the decision boundary in σ-comparable units; ≥0 = commit. */
  margin: number
  z: number   // unified z-score: zGap for splits, -zDist for merges (positive = stronger signal)
}

/**
 * Decide every potential split/merge purely from geometry, with a signed
 * margin from the decision boundary. Decisions are emitted for ALL boxes with
 * an internal gap and ALL adjacent pairs — not just flagged ones — so the OCR
 * recheck can also rescue near-misses just outside the flag thresholds.
 *
 * - SPLIT commits when zGap ≥ splitZ + splitZExtra AND gap ≥ splitMinGapFrac
 *   of the reference height (margin = min of both distances).
 * - MERGE commits exactly when the pair meets a merge-flag condition
 *   (margin = strongest condition's excess).
 */
export function decideGeometry(
  flaggedLines: FlaggedLine[],
  opts: Pick<SegmenterOptions, 'splitZ' | 'mergeZ' | 'mergeAbsFrac' | 'splitMinGapFrac' | 'splitZExtra'>,
): GeoDecision[] {
  const out: GeoDecision[] = []
  flaggedLines.forEach((fl, li) => {
    fl.boxes.forEach((fb, i) => {
      if (fb.internalGapAt >= 0 && fb.internalGap > 0) {
        const margin = Math.min(
          fb.zGap - opts.splitZ - opts.splitZExtra,
          FRAC_TO_Z * (fb.internalGap / fb.effH - opts.splitMinGapFrac),
        )
        out.push({
          kind: 'split', lineIdx: li, boxIdx: i, at: fb.internalGapAt,
          committed: margin >= 0, margin, z: fb.zGap,
        })
      }
      if (fb.distNext !== null) {
        const mZ = fb.zDist !== null ? -fb.zDist - opts.mergeZ : -Infinity
        const mAbs = FRAC_TO_Z * (opts.mergeAbsFrac - fb.distNext / fb.effH)
        const margin = Math.max(mZ, mAbs)
        out.push({ kind: 'merge', lineIdx: li, boxIdx: i, committed: margin >= 0, margin, z: fb.zDist !== null ? -fb.zDist : 0 })
      }
    })
  })
  return out
}

// ── Change application ────────────────────────────────────────────────────────

export type LineChange =
  | { kind: 'split'; idx: number; at: number; strength: number }
  | { kind: 'merge'; idx: number; strength: number }

/** Apply the strongest non-overlapping split/merge changes to one line's boxes. */
export function applyLineChanges(boxes: WordBox[], changes: LineChange[]): WordBox[] {
  const sorted = [...changes].sort((a, b) => b.strength - a.strength)
  const used = new Set<number>()
  const splitAt = new Map<number, number>()
  const mergeNext = new Set<number>()
  for (const ch of sorted) {
    if (ch.kind === 'split') {
      if (used.has(ch.idx)) continue
      used.add(ch.idx)
      splitAt.set(ch.idx, ch.at)
    } else {
      if (used.has(ch.idx) || used.has(ch.idx + 1)) continue
      used.add(ch.idx); used.add(ch.idx + 1)
      mergeNext.add(ch.idx)
    }
  }

  const out: WordBox[] = []
  for (let i = 0; i < boxes.length; i++) {
    if (mergeNext.has(i)) {
      const u = boxes[i], v = boxes[i + 1]
      const x = Math.min(u.x, v.x), y = Math.min(u.y, v.y)
      out.push({
        x, y,
        w: Math.max(u.x + u.w, v.x + v.w) - x,
        h: Math.max(u.y + u.h, v.y + v.h) - y,
      })
      i++
    } else if (splitAt.has(i)) {
      const w = boxes[i], at = splitAt.get(i)!
      const leftW = Math.max(1, at - w.x)
      const rightX = Math.min(w.x + w.w - 1, at)
      out.push({ x: w.x, y: w.y, w: leftW, h: w.h })
      out.push({ x: rightX, y: w.y, w: w.x + w.w - rightX, h: w.h })
    } else {
      out.push(boxes[i])
    }
  }
  return out
}

/** Apply committed geometry decisions to the flagged lines. */
export function applyGeometryDivision(
  flaggedLines: FlaggedLine[],
  decisions: GeoDecision[],
): WordLine[] {
  return flaggedLines.map((fl, li) => {
    const changes: LineChange[] = decisions
      .filter((d) => d.lineIdx === li && d.committed)
      .map((d) => d.kind === 'split'
        ? { kind: 'split', idx: d.boxIdx, at: d.at!, strength: d.margin }
        : { kind: 'merge', idx: d.boxIdx, strength: d.margin })
    return { words: applyLineChanges(fl.boxes.map((fb) => fb.box), changes) }
  })
}

// ── Rendering helpers ─────────────────────────────────────────────────────────

/** Draw word boxes onto an existing canvas context. */
export function drawBoxes(
  ctx: CanvasRenderingContext2D,
  boxes: WordBox[],
  color = '#a78bfa',
): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(1, Math.round(ctx.canvas.height / 800))
  ctx.setLineDash([])
  for (const b of boxes) ctx.strokeRect(b.x, b.y, b.w, b.h)
  ctx.restore()
}

/** Render word lines as colored boxes onto a copy of `source`. */
export function renderWordBoxes(
  source: ImageData,
  lines: WordLine[],
  color = '#22c55e',
): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = source.width; c.height = source.height
  const ctx = c.getContext('2d')!
  ctx.putImageData(source, 0, 0)
  const allWords = lines.flatMap((ln) => ln.words)
  drawBoxes(ctx, allWords, color)
  return c
}

/**
 * Render flagged lines on a copy of `source`:
 * - Normal boxes → green
 * - Split candidates → orange (+ red dotted line at gap centre)
 * - Merge candidates → magenta
 * Labels each box with its internal-gap z-score (red) and dist-to-next z-score (blue).
 */
export function renderFlaggedBoxes(
  source: ImageData,
  flaggedLines: FlaggedLine[],
): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = source.width; c.height = source.height
  const ctx = c.getContext('2d')!
  ctx.putImageData(source, 0, 0)

  const lw = Math.max(1, Math.round(source.height / 800))
  const fs = Math.max(9, Math.round(source.height / 95))
  ctx.font = `${fs}px sans-serif`
  ctx.textBaseline = 'top'

  const sign = (z: number) => `${z >= 0 ? '+' : ''}${z.toFixed(1)}σ`

  for (const fl of flaggedLines) {
    for (const fb of fl.boxes) {
      const { box, flag, internalGap, internalGapAt } = fb

      if (flag === 'split-candidate') {
        ctx.fillStyle = 'rgba(249,115,22,0.28)'
        ctx.fillRect(box.x, box.y, box.w, box.h)
      }

      ctx.setLineDash([])
      ctx.lineWidth = flag === 'merge-candidate' ? lw * 2 : lw
      ctx.strokeStyle =
        flag === 'split-candidate' ? '#f97316'
        : flag === 'merge-candidate' ? '#d946ef'
        : '#16a34a'
      ctx.strokeRect(box.x, box.y, box.w, box.h)

      // Red dotted line at the largest internal gap.
      if (internalGap > 0 && internalGapAt >= 0) {
        ctx.strokeStyle = '#dc2626'
        ctx.setLineDash([4, 3])
        ctx.lineWidth = lw
        ctx.beginPath()
        ctx.moveTo(internalGapAt, box.y)
        ctx.lineTo(internalGapAt, box.y + box.h)
        ctx.stroke()
        ctx.setLineDash([])
      }

      // Labels: gap z-score (red) + dist-to-next z-score (blue).
      ctx.fillStyle = '#dc2626'
      ctx.fillText(`g ${sign(fb.zGap)}`, box.x, box.y + box.h + 2)
      if (fb.zDist !== null) {
        ctx.fillStyle = '#2563eb'
        ctx.fillText(`→ ${sign(fb.zDist)}`, box.x, box.y + box.h + 2 + fs + 1)
      }
    }
  }
  return c
}

// ── Orphan mark absorption ────────────────────────────────────────────────────

type Rect = { x: number; y: number; w: number; h: number }

function rectUnion(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

function rectGap(a: Rect, b: Rect): number {
  const hGap = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w))
  const vGap = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h))
  return Math.sqrt(hGap * hGap + vGap * vGap)
}

/**
 * Find connected ink blobs that fall entirely outside all word boxes. Any
 * orphan whose axis-aligned distance to the nearest box is ≤ maxGap is absorbed
 * — the box is expanded to the union of itself and the blob's bounding rect.
 * Uses the raw (undilated) ink mask so noise from dilation is ignored.
 */
export function absorbOrphanMarks(
  lines: WordLine[],
  inkMask: Uint8Array,
  W: number,
  H: number,
  maxGap: number,
  minBlobPx = 4,
): WordLine[] {
  if (maxGap <= 0 || !lines.length) return lines

  // Dense coverage mask: 1 for every pixel inside any word box.
  const covered = new Uint8Array(W * H)
  for (const l of lines)
    for (const b of l.words)
      for (let y = Math.max(0, b.y); y < Math.min(H, b.y + b.h); y++)
        for (let x = Math.max(0, b.x); x < Math.min(W, b.x + b.w); x++)
          covered[y * W + x] = 1

  // BFS connected-component labeling of ink pixels NOT covered by any box.
  const visited = new Uint8Array(W * H)
  const orphans: Rect[] = []

  for (let i0 = 0; i0 < W * H; i0++) {
    if (!inkMask[i0] || visited[i0] || covered[i0]) continue
    let minX = i0 % W, maxX = minX, minY = (i0 / W) | 0, maxY = minY
    const q: number[] = [i0]
    visited[i0] = 1
    let area = 0, head = 0
    while (head < q.length) {
      const cur = q[head++]
      const cx = cur % W, cy = (cur / W) | 0
      if (cx < minX) minX = cx; else if (cx > maxX) maxX = cx
      if (cy < minY) minY = cy; else if (cy > maxY) maxY = cy
      area++
      for (const n of [cur - 1, cur + 1, cur - W, cur + W]) {
        if (n >= 0 && n < W * H && !visited[n] && inkMask[n] && !covered[n]) {
          visited[n] = 1
          q.push(n)
        }
      }
    }
    if (area >= minBlobPx)
      orphans.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 })
  }

  if (!orphans.length) return lines

  // Flatten boxes with stable indices, track per-box accumulated expansion.
  const flatBoxes: WordBox[] = lines.flatMap(l => l.words)
  const expanded: Rect[] = flatBoxes.map(b => ({ x: b.x, y: b.y, w: b.w, h: b.h }))

  for (const orph of orphans) {
    let bestIdx = -1, bestDist = Infinity
    for (let i = 0; i < expanded.length; i++) {
      const d = rectGap(orph, expanded[i])
      if (d <= maxGap && d < bestDist) { bestDist = d; bestIdx = i }
    }
    if (bestIdx >= 0) expanded[bestIdx] = rectUnion(expanded[bestIdx], orph)
  }

  // Rebuild line structure with expanded boxes.
  let bi = 0
  return lines.map(l => ({
    words: l.words.map(b => {
      const e = expanded[bi++]
      return e.x === b.x && e.y === b.y && e.w === b.w && e.h === b.h
        ? b
        : { ...b, x: e.x, y: e.y, w: e.w, h: e.h }
    }),
  }))
}

// ── Main entry ────────────────────────────────────────────────────────────────

/**
 * Full word-segmentation pipeline: binary canvas → projection boxes →
 * orphan absorption → iterative box-division flagging + geometry decisions.
 */
export async function segmentWords(
  imageData: ImageData,
  opts: Partial<SegmenterOptions> = {},
): Promise<SegmentResult> {
  const o: SegmenterOptions = { ...DEFAULT_SEGMENTER_OPTIONS, ...opts }
  const { width: W, height: H } = imageData

  // Step 1+2: build binary canvas + ink mask.
  const inkThresholdUsed = o.autoThreshold ? otsuThreshold(imageData) : o.inkThreshold
  const { canvas: binaryCanvas, inkMask } = buildBinaryCanvas(imageData, o.dilateX, inkThresholdUsed)

  // Step 3: detect word boxes.
  const rawLines: WordLine[] = segmentByProjection(inkMask, W, H, o.wordGapFactor, o.minWidth, o.minHeight)
  const source = 'projection' as const

  // Absorb orphan ink marks before gap analysis so gaps reflect final box boundaries.
  const rawHeights = rawLines.flatMap(l => l.words.map(w => w.h))
  rawHeights.sort((a, b) => a - b)
  const roughMedianH = rawHeights[Math.floor(rawHeights.length / 2)] ?? 20
  const absorbedLines = absorbOrphanMarks(rawLines, inkMask, W, H, roughMedianH * 0.4)

  // Steps 4–5: iterative flag → geometry → apply (up to 3 rounds). Each round
  // re-examines the output of the previous one; a split may reveal adjacent
  // boxes should merge, or vice versa. Stops early when no decisions commit.
  let roundInput: WordLine[] = absorbedLines
  let flaggedLines: FlaggedLine[] = []
  let pageStats: PageStats = { gapAvg: 0, gapStd: 0, distAvg: 0, distStd: 0, medianWidth: 0, medianHeight: 0 }
  let geoDecisions: GeoDecision[] = []
  let refinedLines: WordLine[] = absorbedLines
  const allRounds: Array<{ flaggedLines: FlaggedLine[]; geoDecisions: GeoDecision[] }> = []

  let frozenStats: Pick<PageStats, 'gapAvg' | 'gapStd' | 'distAvg' | 'distStd'> | undefined
  for (let round = 0; round < 3; round++) {
    const fl = flagBoxDivisions(roundInput, inkMask, W, o, frozenStats)
    flaggedLines = fl.lines
    pageStats = fl.stats
    frozenStats ??= {
      gapAvg: fl.stats.gapAvg, gapStd: fl.stats.gapStd,
      distAvg: fl.stats.distAvg, distStd: fl.stats.distStd,
    }
    geoDecisions = decideGeometry(flaggedLines, o)
    refinedLines = applyGeometryDivision(flaggedLines, geoDecisions)
    allRounds.push({ flaggedLines, geoDecisions })
    if (!geoDecisions.some(d => d.committed)) break
    roundInput = refinedLines
  }

  return {
    source, binaryCanvas, inkMask, W, H, inkThresholdUsed,
    rawLines, absorbedLines, flaggedLines, geoDecisions, refinedLines,
    pageStats, allRounds,
  }
}
