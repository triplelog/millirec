// Stroke-pipeline math: polyline → oriented, centered, scale-normalized
// points in the shape the wasm worker's addPoints expects. Direct extraction
// of the original ShapeID.toWasm math (via widget/recognizer.js) — the DOM
// parts (SVG path resampling) stay with the caller, which hands us the
// already-resampled polyline.

import { POINTS_PER_SHAPE } from './constants.js'
import { encodeSample } from '../format/delta.js'

/**
 * Turn a resampled polyline ({x,y}[]) into {points: [{x,y,s,c}], scale}:
 * per-point tangent sin/cos from the segment direction (vertical fallback,
 * first point copies the second's tangent), centroid centering, and scale =
 * 100 / mean spread of the dominant axis.
 */
export function orientedPointsFromPolyline(polyline) {
  const n = polyline.length
  const centroid = [0, 0]
  let lastPoint = [0, 0]
  const points = []
  for (let i = 0; i < n; i++) {
    const point = polyline[i]
    centroid[0] += point.x
    centroid[1] += point.y
    const out = { x: point.x, y: point.y, a: 1.570795 }
    if (i > 0 && point.x !== lastPoint[0]) {
      out.a = Math.atan2(point.y - lastPoint[1], point.x - lastPoint[0])
    }
    out.s = Math.sin(out.a)
    out.c = Math.cos(out.a)
    if (i === 1) {
      points[0].s = out.s
      points[0].c = out.c
    }
    lastPoint = [point.x, point.y]
    points.push(out)
  }
  centroid[0] /= n
  centroid[1] /= n
  const tc = [0, 0], bc = [0, 0], lc = [0, 0], rc = [0, 0]
  for (const p of points) {
    if (p.x < centroid[0]) { lc[0] += p.x - centroid[0]; lc[1]++ } else { rc[0] += p.x - centroid[0]; rc[1]++ }
    if (p.y < centroid[1]) { tc[0] += p.y - centroid[1]; tc[1]++ } else { bc[0] += p.y - centroid[1]; bc[1]++ }
    p.x -= centroid[0]
    p.y -= centroid[1]
  }
  if (tc[1] > 0) tc[0] /= tc[1]
  if (bc[1] > 0) bc[0] /= bc[1]
  if (lc[1] > 0) lc[0] /= lc[1]
  if (rc[1] > 0) rc[0] /= rc[1]
  const scale = bc[0] - tc[0] < rc[0] - lc[0]
    ? 100 / (rc[0] - lc[0])
    : tc[0] < bc[0] ? 100 / (bc[0] - tc[0]) : 1
  return { points, scale }
}

/**
 * Resample a polyline to `n` evenly spaced points by arc length. Matches the
 * DOM getPointAtLength(i·total/(n−1)) sampling used for drawn paths.
 */
export function resamplePolyline(polyline, n = POINTS_PER_SHAPE) {
  const cum = [0]
  for (let i = 1; i < polyline.length; i++) {
    const dx = polyline[i].x - polyline[i - 1].x
    const dy = polyline[i].y - polyline[i - 1].y
    cum.push(cum[i - 1] + Math.sqrt(dx * dx + dy * dy))
  }
  const total = cum[cum.length - 1]
  if (!total) return null
  const out = []
  let seg = 0
  for (let i = 0; i < n; i++) {
    const target = (i * total) / (n - 1)
    while (seg < polyline.length - 2 && cum[seg + 1] < target) seg++
    const span = cum[seg + 1] - cum[seg]
    const t = span ? (target - cum[seg]) / span : 0
    out.push({
      x: polyline[seg].x + (polyline[seg + 1].x - polyline[seg].x) * t,
      y: polyline[seg].y + (polyline[seg + 1].y - polyline[seg].y) * t,
    })
  }
  return out
}

/**
 * Resample a multi-stroke drawing ([[{x,y},...], ...]) to `n` evenly spaced
 * points by arc length, where pen-up gaps between strokes contribute zero
 * length (matching SVG getPointAtLength across `M` commands — the pipeline
 * the training data was captured through).
 */
export function resampleStrokes(strokes, n = POINTS_PER_SHAPE) {
  const segs = [] // {ax, ay, bx, by, cumStart, cumEnd}
  let cum = 0
  for (const stroke of strokes) {
    for (let i = 1; i < stroke.length; i++) {
      const dx = stroke[i].x - stroke[i - 1].x
      const dy = stroke[i].y - stroke[i - 1].y
      const len = Math.sqrt(dx * dx + dy * dy)
      segs.push({ ax: stroke[i - 1].x, ay: stroke[i - 1].y, bx: stroke[i].x, by: stroke[i].y, cumStart: cum, cumEnd: cum + len })
      cum += len
    }
  }
  if (!cum || !segs.length) return null
  const out = []
  let s = 0
  for (let i = 0; i < n; i++) {
    const target = (i * cum) / (n - 1)
    while (s < segs.length - 1 && segs[s].cumEnd < target) s++
    const seg = segs[s]
    const span = seg.cumEnd - seg.cumStart
    const t = span ? Math.min(1, Math.max(0, (target - seg.cumStart) / span)) : 0
    out.push({ x: seg.ax + (seg.bx - seg.ax) * t, y: seg.ay + (seg.by - seg.ay) * t })
  }
  return out
}

/** Resampled polyline → one delta-encoded training sample. */
export function polylineToSample(polyline) {
  return encodeSample(polyline)
}
