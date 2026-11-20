/**
 * Contour-based margin-symbol recognition — a millirec-style point matcher applied
 * to the OUTLINE of a glyph instead of its pen strokes.
 *
 * The margin symbols come from a PHOTO, so we have a binary ink MASK, not strokes.
 * To reuse millirec's idea (compare a shape to templates by optimally MATCHING its
 * sampled points against each template's points), we first TRACE the glyph's
 * contour(s) — the closed outlines around the ink, holes included (marching
 * squares) — then resample each contour to a fixed number of points with a tangent
 * direction, normalise (centre + RMS scale), and compare to a small TRAINING SET of
 * the same kind: one hand-defined exemplar per symbol, rendered to a mask and run
 * through the identical contour pipeline.
 *
 * Matching is millirec's core step: a LINEAR ASSIGNMENT (Hungarian) between the two
 * point sets, with a per-point cost = position distance + a tangent-direction
 * penalty (capped so a few outliers don't dominate). The template with the lowest
 * mean assignment cost wins; a softmax over the negative costs gives a probability
 * per symbol (shown, like before, in the 📋 Margin overlay).
 *
 * Everything here is pure geometry on a binary mask — no WASM, no worker — so it
 * runs synchronously inside the import pipeline.
 *
 * The training set is data/symbolset.json — a millirec localStorage dump whose
 * `points-symbols` holds, per symbol, a handful of point-sampled exemplars
 * (delta-encoded, with pen-up jumps between strokes). We reconstruct each
 * exemplar's strokes, rasterise them to a mask, and run the SAME contour pipeline
 * as a glyph — so training and test contours are directly comparable.
 */

import symbolset from './data/symbolset.json'

// The five trained symbols (data/symbolset.json). '?' is what the writer uses for
// the RETURN/line-break mark (⏎) — there's no key to type that glyph, so it's saved
// under '?'. It maps to the 'linebreak' directive (see imageImport's marginMarksFrom).
export type MarginSymbol = '#' | '>' | '-' | '1' | '?'
export const MARGIN_SYMBOLS: MarginSymbol[] = ['#', '>', '-', '1', '?']

export interface Pt {
  x: number
  y: number
}
export interface ContourPoint {
  x: number
  y: number
  dx: number // unit tangent
  dy: number
}

// ---- Tunables -------------------------------------------------------------
const N_POINTS = 50 // sampled points per shape (test + each template)
const MIN_PER_LOOP = 4 // a contour loop gets at least this many sample points
const MIN_LOOP_PERIM = 4 // drop loops shorter than this (px) as noise
const SMOOTH_ITERS = 3 // moving-average smoothing passes on each contour loop
const DIR_W = 0.3 // weight of the tangent-direction term in the point cost
const MAX_COST = 1.5 // per-point cost cap (outlier limit)
const SOFTMAX_TEMP = 0.05 // smaller = sharper/more confident distribution
// Glyphs from photos are noisy; clean the mask before tracing so the contour is
// stable: drop specks (components below this fraction of total ink) and fill pin-
// hole gaps (background holes below this fraction of the bbox area). The real '#'
// cells are far larger than the hole threshold, so they survive.
const SPECK_FRAC = 0.04
const HOLE_FILL_FRAC = 0.02
// Blend the contour match with a few cheap, scale-invariant shape features
// (aspect, holes, vertical/horizontal-ness, density, centre of mass). The symbols
// are very distinct in these, so this anchors the contour score.
const FEAT_W = 0.25

// ---- Mask cleanup + shape features ----------------------------------------

/** 8-connected component labels with per-label area. */
function components(mask: Uint8Array, w: number, h: number): { label: Int32Array; areas: number[] } {
  const label = new Int32Array(w * h).fill(-1)
  const areas: number[] = []
  const stack: number[] = []
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || label[i] >= 0) continue
    const id = areas.length
    let area = 0
    label[i] = id
    stack.length = 0
    stack.push(i)
    while (stack.length) {
      const p = stack.pop()!
      area++
      const px = p % w
      const py = (p / w) | 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const nx = px + dx
          const ny = py + dy
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
          const ni = ny * w + nx
          if (mask[ni] && label[ni] < 0) {
            label[ni] = id
            stack.push(ni)
          }
        }
    }
    areas.push(area)
  }
  return { label, areas }
}

/** Drop tiny ink specks and fill pin-hole background gaps so the traced contour is
 *  stable. Gentle: thresholds are fractions of the ink / bbox, so real '#' cells
 *  (large) survive while photo noise (small) is removed. */
function cleanMask(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(mask)
  const { label, areas } = components(out, w, h)
  let totalInk = 0
  for (const a of areas) totalInk += a
  if (!totalInk) return out
  const minArea = Math.max(2, SPECK_FRAC * totalInk)
  // Keep only the largest component plus any other component above minArea (so a
  // dotted '?'/multi-stroke '#' keeps its real parts but loses specks).
  let maxArea = 0
  for (const a of areas) if (a > maxArea) maxArea = a
  for (let i = 0; i < w * h; i++) {
    const l = label[i]
    if (l >= 0 && areas[l] < minArea && areas[l] !== maxArea) out[i] = 0
  }
  // Fill small enclosed background holes (flood the outside, then fill the rest).
  const outside = new Uint8Array(w * h)
  const stack: number[] = []
  const pushBg = (i: number) => {
    if (!out[i] && !outside[i]) {
      outside[i] = 1
      stack.push(i)
    }
  }
  for (let x = 0; x < w; x++) {
    pushBg(x)
    pushBg((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    pushBg(y * w)
    pushBg(y * w + w - 1)
  }
  while (stack.length) {
    const p = stack.pop()!
    const px = p % w
    const py = (p / w) | 0
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const nx = px + dx
        const ny = py + dy
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
        pushBg(ny * w + nx)
      }
  }
  // Enclosed holes = background not reached from the border; fill the small ones.
  const holeThresh = HOLE_FILL_FRAC * w * h
  const bg = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) bg[i] = out[i] || outside[i] ? 0 : 1
  const { label: hl, areas: hareas } = components(bg, w, h)
  for (let i = 0; i < w * h; i++) {
    const l = hl[i]
    if (l >= 0 && hareas[l] < holeThresh) out[i] = 1
  }
  return out
}

/** Number of enclosed background holes (≥ a small area) — the '#' grid encloses ≥1. */
function countHoles(mask: Uint8Array, w: number, h: number): number {
  const outside = new Uint8Array(w * h)
  const stack: number[] = []
  const pushBg = (i: number) => {
    if (!mask[i] && !outside[i]) {
      outside[i] = 1
      stack.push(i)
    }
  }
  for (let x = 0; x < w; x++) {
    pushBg(x)
    pushBg((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    pushBg(y * w)
    pushBg(y * w + w - 1)
  }
  while (stack.length) {
    const p = stack.pop()!
    const px = p % w
    const py = (p / w) | 0
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const nx = px + dx
        const ny = py + dy
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
        pushBg(ny * w + nx)
      }
  }
  const bg = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) bg[i] = mask[i] || outside[i] ? 0 : 1
  const { areas } = components(bg, w, h)
  const thresh = HOLE_FILL_FRAC * w * h
  let holes = 0
  for (const a of areas) if (a >= thresh) holes++
  return holes
}

/**
 * Cheap scale-invariant shape features of a binary mask (tight bbox assumed):
 * [ log2(aspect), holes, vertical-ness, horizontal-ness, density, comX-0.5,
 * comY-0.5 ]. The margin symbols are very distinct here, so these anchor the
 * contour match.
 */
export function maskFeatures(mask: Uint8Array, w: number, h: number): number[] {
  let ink = 0
  let sx = 0
  let sy = 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (mask[y * w + x]) {
        ink++
        sx += x
        sy += y
      }
  if (!ink) return [0, 0, 0, 0, 0, 0, 0]
  // Vertical-ness: mean over columns of (longest vertical ink run / h).
  let vsum = 0
  for (let x = 0; x < w; x++) {
    let run = 0
    let best = 0
    for (let y = 0; y < h; y++) {
      if (mask[y * w + x]) {
        run++
        if (run > best) best = run
      } else run = 0
    }
    vsum += best / h
  }
  let hsum = 0
  for (let y = 0; y < h; y++) {
    let run = 0
    let best = 0
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        run++
        if (run > best) best = run
      } else run = 0
    }
    hsum += best / w
  }
  return [
    Math.log2(w / Math.max(1, h)),
    Math.min(2, countHoles(mask, w, h)),
    vsum / w,
    hsum / h,
    ink / (w * h),
    sx / ink / Math.max(1, w - 1) - 0.5,
    sy / ink / Math.max(1, h - 1) - 0.5,
  ]
}

const FEAT_WEIGHTS = [1.0, 1.3, 1.4, 1.4, 0.5, 0.6, 0.6]
function featureDistance(a: number[], b: number[]): number {
  let d = 0
  for (let i = 0; i < a.length; i++) {
    const e = a[i] - b[i]
    d += FEAT_WEIGHTS[i] * e * e
  }
  return Math.sqrt(d)
}

// ---- Contour tracing (marching squares over the binary mask) --------------

/**
 * Trace every closed contour of `mask` (outer boundaries AND hole boundaries) via
 * marching squares at the 0.5 iso-level. Returns each contour as an ordered loop of
 * points in mask-pixel coordinates (the loop's last point connects back to its
 * first). Crossing points sit on cell-edge midpoints, so loops hug the ink edge.
 */
export function traceContours(mask: Uint8Array, w: number, h: number): Pt[][] {
  // Segment endpoints live on a half-integer grid; key them as integers (×2).
  const BIG = (w + 2) * 2 + 4
  const key = (px: number, py: number) => py * BIG + px
  const coord = new Map<number, Pt>()
  // edge id: 0=top 1=right 2=bottom 3=left, midpoint of that cell edge (×2 coords).
  const edgePt = (x: number, y: number, e: number): number => {
    let px: number
    let py: number
    if (e === 0) {
      px = 2 * x + 1
      py = 2 * y
    } else if (e === 1) {
      px = 2 * x + 2
      py = 2 * y + 1
    } else if (e === 2) {
      px = 2 * x + 1
      py = 2 * y + 2
    } else {
      px = 2 * x
      py = 2 * y + 1
    }
    const k = key(px, py)
    if (!coord.has(k)) coord.set(k, { x: px / 2, y: py / 2 })
    return k
  }
  // For each case (corner bitmask tl|tr<<1|br<<2|bl<<3) the edge pairs to connect.
  const CASES: number[][][] = [
    [], // 0
    [[3, 0]], // 1  tl
    [[0, 1]], // 2  tr
    [[3, 1]], // 3  tl tr
    [[1, 2]], // 4  br
    [[3, 0], [1, 2]], // 5  tl br (saddle)
    [[0, 2]], // 6  tr br
    [[3, 2]], // 7  tl tr br
    [[2, 3]], // 8  bl
    [[0, 2]], // 9  tl bl
    [[0, 1], [2, 3]], // 10 tr bl (saddle)
    [[1, 2]], // 11 tl tr bl
    [[3, 1]], // 12 br bl
    [[0, 1]], // 13 tl br bl
    [[3, 0]], // 14 tr br bl
    [], // 15
  ]
  const segA: number[] = []
  const segB: number[] = []
  const at = (x: number, y: number) => (x >= 0 && x < w && y >= 0 && y < h && mask[y * w + x] ? 1 : 0)
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const c = at(x, y) | (at(x + 1, y) << 1) | (at(x + 1, y + 1) << 2) | (at(x, y + 1) << 3)
      const pairs = CASES[c]
      for (const [e0, e1] of pairs) {
        segA.push(edgePt(x, y, e0))
        segB.push(edgePt(x, y, e1))
      }
    }
  }

  // Link segments sharing an endpoint into loops.
  const adj = new Map<number, number[]>()
  for (let i = 0; i < segA.length; i++) {
    ;(adj.get(segA[i]) ?? adj.set(segA[i], []).get(segA[i])!).push(i)
    ;(adj.get(segB[i]) ?? adj.set(segB[i], []).get(segB[i])!).push(i)
  }
  const used = new Uint8Array(segA.length)
  const loops: Pt[][] = []
  for (let s = 0; s < segA.length; s++) {
    if (used[s]) continue
    const loop: Pt[] = []
    let cur = segA[s]
    let seg = s
    while (seg >= 0 && !used[seg]) {
      used[seg] = 1
      loop.push(coord.get(cur)!)
      const next = segA[seg] === cur ? segB[seg] : segA[seg]
      cur = next
      // pick an unused segment at `cur`
      seg = -1
      for (const cand of adj.get(cur) ?? []) {
        if (!used[cand]) {
          seg = cand
          break
        }
      }
    }
    if (loop.length >= 3) loops.push(loop)
  }
  return loops
}

// ---- Resample + normalise → feature points --------------------------------

function perimeter(loop: Pt[]): number {
  let p = 0
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]
    const b = loop[(i + 1) % loop.length]
    p += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return p
}

/** Smooth a closed loop with `iters` passes of a [1 2 1]/4 moving average (wrap
 *  around). Removes the marching-squares pixel staircase so the sampled points and
 *  tangents reflect the real curve, not the rasterisation. */
export function smoothLoop(loop: Pt[], iters: number): Pt[] {
  const n = loop.length
  if (n < 5) return loop
  let pts = loop
  for (let it = 0; it < iters; it++) {
    const next: Pt[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n]
      const b = pts[i]
      const c = pts[(i + 1) % n]
      next[i] = { x: (a.x + 2 * b.x + c.x) / 4, y: (a.y + 2 * b.y + c.y) / 4 }
    }
    pts = next
  }
  return pts
}

/** Resample a closed loop to exactly `m` arc-length-equispaced points (correct
 *  cumulative-length walk). */
function resampleLoop(loop: Pt[], m: number): Pt[] {
  const n = loop.length
  const seg: number[] = new Array(n)
  let total = 0
  for (let i = 0; i < n; i++) {
    const a = loop[i]
    const b = loop[(i + 1) % n]
    seg[i] = Math.hypot(b.x - a.x, b.y - a.y)
    total += seg[i]
  }
  if (total < 1e-6) return Array.from({ length: m }, () => ({ ...loop[0] }))
  const step = total / m
  const out: Pt[] = []
  let i = 0
  let segStart = 0 // cumulative length at the start of segment i
  for (let k = 0; k < m; k++) {
    const target = k * step
    while (i < n - 1 && segStart + seg[i] < target) {
      segStart += seg[i]
      i++
    }
    const a = loop[i]
    const b = loop[(i + 1) % n]
    const t = seg[i] > 1e-9 ? (target - segStart) / seg[i] : 0
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
  }
  return out
}

/**
 * Clean `mask`, trace it, SMOOTH each contour loop, resample to N_POINTS points
 * (split across loops by length), compute tangents, and normalise UNIFORMLY by the
 * bounding box so the longer side = 1 — a single scale factor that PRESERVES ASPECT
 * (a flat dash stays flat, a tall '1' stays tall). Also returns the cheap shape
 * `feat`ures of the cleaned mask. Returns null if there's no usable contour.
 */
export function maskToFeature(
  mask: Uint8Array,
  w: number,
  h: number,
): { pts: ContourPoint[]; loops: Pt[][]; feat: number[] } | null {
  const cleaned = cleanMask(mask, w, h)
  let loops = traceContours(cleaned, w, h).filter((l) => perimeter(l) >= MIN_LOOP_PERIM)
  if (!loops.length) return null
  const feat = maskFeatures(cleaned, w, h)
  // Cap the number of loops so every kept loop can hold ≥ MIN_PER_LOOP points.
  const maxLoops = Math.max(1, Math.floor(N_POINTS / MIN_PER_LOOP))
  loops = loops
    .sort((a, b) => perimeter(b) - perimeter(a))
    .slice(0, maxLoops)
    .map((l) => smoothLoop(l, SMOOTH_ITERS))

  const lens = loops.map(perimeter)
  const total = lens.reduce((a, b) => a + b, 0)
  const counts = lens.map((l) => Math.max(MIN_PER_LOOP, Math.round((N_POINTS * l) / total)))
  let sum = counts.reduce((a, b) => a + b, 0)
  // Reconcile to exactly N_POINTS.
  while (sum > N_POINTS) {
    let bi = -1
    for (let i = 0; i < counts.length; i++) if (counts[i] > MIN_PER_LOOP && (bi < 0 || counts[i] > counts[bi])) bi = i
    if (bi < 0) break
    counts[bi]--
    sum--
  }
  while (sum < N_POINTS) {
    let bi = 0
    for (let i = 1; i < counts.length; i++) if (lens[i] > lens[bi]) bi = i
    counts[bi]++
    sum++
  }

  const pts: ContourPoint[] = []
  loops.forEach((loop, li) => {
    const m = counts[li]
    if (m <= 0) return
    const rs = resampleLoop(loop, m)
    for (let i = 0; i < rs.length; i++) {
      const prev = rs[(i - 1 + rs.length) % rs.length]
      const next = rs[(i + 1) % rs.length]
      let dx = next.x - prev.x
      let dy = next.y - prev.y
      const len = Math.hypot(dx, dy) || 1
      dx /= len
      dy /= len
      pts.push({ x: rs[i].x, y: rs[i].y, dx, dy })
    }
  })
  if (pts.length !== N_POINTS) {
    // Pad/trim defensively so the cost matrix stays square.
    while (pts.length < N_POINTS) pts.push({ ...pts[pts.length - 1] })
    pts.length = N_POINTS
  }

  // Normalise UNIFORMLY by the bounding box (longer side → 1), centred. One scale
  // factor for both axes, so the shape's aspect ratio is untouched. (Tangents are
  // directions, unaffected by a uniform scale + translate.)
  let minx = Infinity
  let miny = Infinity
  let maxx = -Infinity
  let maxy = -Infinity
  for (const p of pts) {
    if (p.x < minx) minx = p.x
    if (p.x > maxx) maxx = p.x
    if (p.y < miny) miny = p.y
    if (p.y > maxy) maxy = p.y
  }
  const cx = (minx + maxx) / 2
  const cy = (miny + maxy) / 2
  const scale = 1 / Math.max(maxx - minx, maxy - miny, 1e-6)
  for (const p of pts) {
    p.x = (p.x - cx) * scale
    p.y = (p.y - cy) * scale
  }
  return { pts, loops, feat }
}

// ---- Hungarian (min-cost assignment, O(n³)) -------------------------------

function hungarian(cost: number[][]): number {
  const n = cost.length
  const INF = Infinity
  const u = new Array(n + 1).fill(0)
  const v = new Array(n + 1).fill(0)
  const p = new Array(n + 1).fill(0)
  const way = new Array(n + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Array(n + 1).fill(INF)
    const used = new Array(n + 1).fill(false)
    do {
      used[j0] = true
      const i0 = p[j0]
      let delta = INF
      let j1 = -1
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
        if (cur < minv[j]) {
          minv[j] = cur
          way[j] = j0
        }
        if (minv[j] < delta) {
          delta = minv[j]
          j1 = j
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta
          v[j] -= delta
        } else {
          minv[j] -= delta
        }
      }
      j0 = j1
    } while (p[j0] !== 0)
    do {
      const j1 = way[j0]
      p[j0] = p[j1]
      j0 = j1
    } while (j0)
  }
  let totalCost = 0
  for (let j = 1; j <= n; j++) if (p[j]) totalCost += cost[p[j] - 1][j - 1]
  return totalCost
}

/** Mean optimal-assignment cost between two equal-length feature point sets. */
function matchCost(a: ContourPoint[], b: ContourPoint[]): number {
  const n = a.length
  const cost: number[][] = []
  for (let i = 0; i < n; i++) {
    const row = new Array(n)
    for (let j = 0; j < n; j++) {
      const pd = (a[i].x - b[j].x) ** 2 + (a[i].y - b[j].y) ** 2
      const dot = a[i].dx * b[j].dx + a[i].dy * b[j].dy
      const dirPen = 1 - Math.abs(dot) // tangent direction is undirected
      row[j] = Math.min(MAX_COST, pd + DIR_W * dirPen)
    }
    cost.push(row)
  }
  return hungarian(cost) / n
}

// ---- Training set: contour exemplars from data/symbolset.json -------------

const TPL_PAD = 8 // mask padding around a rendered exemplar (px)
const STROKE_FRAC = 0.05 // exemplar stroke radius as a fraction of its bbox max side
const JUMP_FACTOR = 3 // a step > this × the sample's median step = a pen-up (stroke break)

/** Rasterise polyline strokes into a binary mask by stamping disks along them. */
function strokesToMask(strokes: Pt[][], w: number, h: number, r: number): Uint8Array {
  const mask = new Uint8Array(w * h)
  const stamp = (cx: number, cy: number) => {
    const x0 = Math.max(0, Math.floor(cx - r))
    const x1 = Math.min(w - 1, Math.ceil(cx + r))
    const y0 = Math.max(0, Math.floor(cy - r))
    const y1 = Math.min(h - 1, Math.ceil(cy + r))
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) mask[y * w + x] = 1
  }
  for (const stroke of strokes) {
    if (stroke.length === 1) stamp(stroke[0].x, stroke[0].y)
    for (let i = 0; i < stroke.length - 1; i++) {
      const a = stroke[i]
      const b = stroke[i + 1]
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      const steps = Math.max(1, Math.round(len))
      for (let s = 0; s <= steps; s++) {
        const t = s / steps
        stamp(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
      }
    }
  }
  return mask
}

/** Reconstruct absolute points from one delta-encoded exemplar, splitting into
 *  strokes at pen-up jumps (a step far larger than the sample's median step). */
function exemplarStrokes(sample: { x: number[]; y: number[] }): Pt[][] {
  const abs: Pt[] = []
  let x = 0
  let y = 0
  for (let i = 0; i < sample.x.length; i++) {
    x += sample.x[i]
    y += sample.y[i]
    abs.push({ x, y })
  }
  if (abs.length < 2) return abs.length ? [abs] : []
  const steps: number[] = []
  for (let i = 1; i < abs.length; i++) steps.push(Math.hypot(abs[i].x - abs[i - 1].x, abs[i].y - abs[i - 1].y))
  const med = [...steps].sort((a, b) => a - b)[steps.length >> 1] || 1
  const thresh = med * JUMP_FACTOR
  const strokes: Pt[][] = []
  let cur: Pt[] = [abs[0]]
  for (let i = 1; i < abs.length; i++) {
    if (steps[i - 1] > thresh) {
      if (cur.length) strokes.push(cur)
      cur = []
    }
    cur.push(abs[i])
  }
  if (cur.length) strokes.push(cur)
  return strokes
}

/** Translate strokes to the origin and rasterise into a tight padded mask. */
function exemplarToMask(strokes: Pt[][]): { mask: Uint8Array; w: number; h: number } | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const s of strokes)
    for (const p of s) {
      if (p.x < x0) x0 = p.x
      if (p.x > x1) x1 = p.x
      if (p.y < y0) y0 = p.y
      if (p.y > y1) y1 = p.y
    }
  if (!isFinite(x0)) return null
  const r = Math.max(2, STROKE_FRAC * Math.max(x1 - x0, y1 - y0))
  const pad = TPL_PAD + r
  const w = Math.max(1, Math.ceil(x1 - x0 + 2 * pad))
  const h = Math.max(1, Math.ceil(y1 - y0 + 2 * pad))
  const shifted = strokes.map((s) => s.map((p) => ({ x: p.x - x0 + pad, y: p.y - y0 + pad })))
  return { mask: strokesToMask(shifted, w, h, r), w, h }
}

/**
 * Render an SVG path (a trained exemplar's raw `paths-symbols` entry — relative
 * cubic béziers with multiple subpaths for multi-stroke glyphs) to a tight binary
 * mask. Browser-only (uses Path2D + canvas). Two-pass: stroke thin to find the
 * ink bbox, then re-stroke at a bbox-relative width and crop. Returns null off the
 * main thread / when nothing is drawn.
 */
function pathToMask(d: string): { mask: Uint8Array; w: number; h: number } | null {
  if (typeof document === 'undefined') return null
  const SZ = 320
  const c = document.createElement('canvas')
  c.width = SZ
  c.height = SZ
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  const path = new Path2D(d)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#000'
  const inkBounds = () => {
    const data = ctx.getImageData(0, 0, SZ, SZ).data
    let x0 = SZ
    let y0 = SZ
    let x1 = -1
    let y1 = -1
    for (let y = 0; y < SZ; y++)
      for (let x = 0; x < SZ; x++)
        if (data[(y * SZ + x) * 4 + 3] > 40) {
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
    return x1 < x0 ? null : { x0, y0, x1, y1, data }
  }
  ctx.lineWidth = 2
  ctx.stroke(path)
  const b1 = inkBounds()
  if (!b1) return null
  const lw = Math.max(4, STROKE_FRAC * 2 * Math.max(b1.x1 - b1.x0, b1.y1 - b1.y0))
  ctx.clearRect(0, 0, SZ, SZ)
  ctx.lineWidth = lw
  ctx.stroke(path)
  const b = inkBounds()
  if (!b) return null
  const pad = Math.ceil(TPL_PAD)
  const w = b.x1 - b.x0 + 1 + 2 * pad
  const h = b.y1 - b.y0 + 1 + 2 * pad
  const mask = new Uint8Array(w * h)
  for (let y = b.y0; y <= b.y1; y++)
    for (let x = b.x0; x <= b.x1; x++)
      if (b.data[(y * SZ + x) * 4 + 3] > 110) mask[(y - b.y0 + pad) * w + (x - b.x0 + pad)] = 1
  return { mask, w, h }
}

export interface MarginTemplate {
  sym: MarginSymbol
  feature: ContourPoint[]
  feat: number[] // cheap shape features (maskFeatures of the cleaned exemplar)
  mask: Uint8Array
  w: number
  h: number
  loops: Pt[][] // contour loops in mask coords (for the training-set preview)
}

let templateCache: MarginTemplate[] | null = null

/**
 * Build (once) the training set: for EACH trained exemplar of each symbol, render
 * it to a mask and run the SAME contour pipeline a glyph uses. We use the rich
 * `paths-symbols` set (≈20 béziers/symbol) when a DOM is available, falling back to
 * the point-sampled `points-symbols` set (≈5–7/symbol) otherwise — so there are
 * many exemplars per symbol for robust nearest-template matching.
 */
export function getMarginTemplates(): MarginTemplate[] {
  if (templateCache) return templateCache
  const out: MarginTemplate[] = []
  const addMask = (sym: MarginSymbol, m: { mask: Uint8Array; w: number; h: number } | null) => {
    if (!m) return
    const f = maskToFeature(m.mask, m.w, m.h)
    if (!f) return
    out.push({ sym, feature: f.pts, feat: f.feat, mask: m.mask, w: m.w, h: m.h, loops: f.loops })
  }
  try {
    const dump = symbolset as Record<string, string>
    const arrayKey = dump['pointArray'] || 'symbols'
    // BOTH globals, not just `document`. The node harness supplies a canvas-backed
    // `document` but no `Path2D`, so this read true there, `pathToMask` threw on
    // the first bezier, and the throw escaped the paths loop into the catch below
    // — skipping the point-sampled exemplars this function documents as "the only
    // source under Node". Measured: getMarginTemplates() returned ZERO templates
    // under the harness, so every node-side gate and corpus score classified
    // margin glyphs against an empty set, announced only by one console.error.
    const usesPaths = typeof document !== 'undefined' && typeof Path2D !== 'undefined'
    if (usesPaths) {
      const paths = JSON.parse(dump[`paths-${arrayKey}`]) as Record<string, string[]>
      for (const sym of Object.keys(paths)) {
        if (!(MARGIN_SYMBOLS as string[]).includes(sym)) continue
        for (const d of paths[sym]) addMask(sym as MarginSymbol, pathToMask(d))
      }
    }
    // Always add the point-sampled exemplars too (and the only source under Node).
    const points = JSON.parse(dump[`points-${arrayKey}`]) as Record<string, { x: number[]; y: number[] }[]>
    for (const sym of Object.keys(points)) {
      if (!(MARGIN_SYMBOLS as string[]).includes(sym)) continue
      for (const sample of points[sym]) addMask(sym as MarginSymbol, exemplarToMask(exemplarStrokes(sample)))
    }
  } catch (err) {
    console.error('[margin] failed to load symbolset.json templates:', err)
  }
  templateCache = out
  return out
}

// ---- Classification --------------------------------------------------------

export interface GlyphClassification {
  best: MarginSymbol
  probs: Record<MarginSymbol, number>
  contours: Pt[][] // traced glyph contours, mask-local coords (for the overlay)
}

/**
 * Classify a glyph mask by tracing its contour and matching it (millirec-style
 * optimal point assignment) against every trained exemplar, BLENDED with a cheap
 * shape-feature distance (the symbols are very distinct in aspect / holes /
 * vertical-ness, which anchors the contour score). Each symbol's score is its BEST
 * (lowest combined cost) exemplar; a softmax over the negative best-costs gives a
 * probability per symbol. Returns the argmax + the traced contours for the overlay.
 */
export function classifyGlyphContours(mask: Uint8Array, w: number, h: number): GlyphClassification {
  const templates = getMarginTemplates()
  const feat = maskToFeature(mask, w, h)
  const flat = () => {
    const probs = {} as Record<MarginSymbol, number>
    for (const s of MARGIN_SYMBOLS) probs[s] = 1 / MARGIN_SYMBOLS.length
    return probs
  }
  if (!feat) return { best: MARGIN_SYMBOLS[0], probs: flat(), contours: [] }

  // Lowest combined (contour + feature) cost per symbol over all its exemplars.
  const minCost = {} as Record<MarginSymbol, number>
  for (const s of MARGIN_SYMBOLS) minCost[s] = Infinity
  for (const t of templates) {
    const c = matchCost(feat.pts, t.feature) + FEAT_W * featureDistance(feat.feat, t.feat)
    if (c < minCost[t.sym]) minCost[t.sym] = c
  }
  // Softmax over negative best-cost → probability per symbol.
  const probs = {} as Record<MarginSymbol, number>
  let z = 0
  for (const s of MARGIN_SYMBOLS) {
    const e = isFinite(minCost[s]) ? Math.exp(-minCost[s] / SOFTMAX_TEMP) : 0
    probs[s] = e
    z += e
  }
  z = z || 1
  let best = MARGIN_SYMBOLS[0]
  let bestP = -1
  for (const s of MARGIN_SYMBOLS) {
    probs[s] /= z
    if (probs[s] > bestP) {
      bestP = probs[s]
      best = s
    }
  }
  return { best, probs, contours: feat.loops }
}

// ---- Training-set preview (one labelled cell per symbol) -------------------

/** A debug PNG showing the training set: every symbol's exemplars, each as its
 *  rendered mask (grey) with the traced CONTOUR drawn over it (magenta) + a label.
 *  One row per symbol (all its exemplars laid out left→right). */
export function renderTemplateSetPreview(): string {
  const templates = getMarginTemplates()
  const pad = 14
  const labelW = 34
  // Group exemplars by symbol, preserving MARGIN_SYMBOLS order.
  const bySym = MARGIN_SYMBOLS.map((s) => ({ sym: s, tpls: templates.filter((t) => t.sym === s) })).filter(
    (g) => g.tpls.length,
  )
  const rowH = Math.max(1, ...templates.map((t) => t.h))
  const maxCols = Math.max(1, ...bySym.map((g) => g.tpls.length))
  const cellW = Math.max(1, ...templates.map((t) => t.w)) + pad
  const c = document.createElement('canvas')
  c.width = labelW + maxCols * cellW + pad
  c.height = bySym.length * (rowH + pad) + pad
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, c.width, c.height)
  const symLabel = (s: MarginSymbol) => (s === '?' ? '? (⏎)' : s)
  bySym.forEach((g, r) => {
    const oy = pad + r * (rowH + pad)
    ctx.fillStyle = '#111827'
    ctx.font = 'bold 22px sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(symLabel(g.sym), 6, oy + rowH / 2)
    g.tpls.forEach((t, i) => {
      const ox = labelW + i * cellW
      // mask in light grey
      const id = ctx.createImageData(t.w, t.h)
      for (let p = 0; p < t.w * t.h; p++) {
        const v = t.mask[p] ? 190 : 255
        id.data[p * 4] = v
        id.data[p * 4 + 1] = v
        id.data[p * 4 + 2] = v
        id.data[p * 4 + 3] = 255
      }
      ctx.putImageData(id, ox, oy)
      ctx.strokeStyle = '#e5e7eb'
      ctx.lineWidth = 1
      ctx.strokeRect(ox - 0.5, oy - 0.5, t.w, t.h)
      // contour in magenta
      ctx.strokeStyle = '#d946ef'
      ctx.lineWidth = 1.5
      for (const loop of t.loops) {
        ctx.beginPath()
        loop.forEach((p, k) => (k === 0 ? ctx.moveTo(ox + p.x, oy + p.y) : ctx.lineTo(ox + p.x, oy + p.y)))
        ctx.closePath()
        ctx.stroke()
      }
    })
  })
  return c.toDataURL('image/png')
}
