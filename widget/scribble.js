// Scribble-out as a GESTURE, not a character class.
//
// The writer scrubs back and forth over what is in the cell to throw it away.
// That decision is made on the ink's geometry alone — never on the
// recognizer's confidence, which is the mistake `docs/strikeout.md` records:
// on a real scribbled-out word the decoder read "came" with ordinary
// confidence and its own scribble flag fired on nothing, while the geometry
// separated the same ink at robust-z 6.15. A scribble is also a poor
// TEMPLATE class — resampled to 25 points it is a smear that sits at mediocre
// distance from every letter, and with the overlap engine's lexicon pruning
// it would be pruned away before it could win.
//
// Four signals, and a scribble needs all four:
//
//   turns    back-and-forth reversals along the stroke's own PRINCIPAL axis,
//            counted with a deadband so a wobble is not a tooth. A scrub goes
//            back and forth along the direction it is widest in; an M, a W
//            and a cursive m travel that direction once and do their
//            reversing across it.
//   retrace  how much of the path is laid back over ground it has already
//            covered — the vector form of the strikeout doc's own measured
//            discriminator. It is what separates a SHORT scrub from a
//            cursive m, which turns as often and never touches its own ink.
//   winding  path length / bounding-box diagonal.
//   cover    how much this stroke and the ink already in the cell overlap.
//            A scribble is aimed AT something; a character drawn beside one
//            is not.
//
// Thresholds are measured, not guessed: scripts/verify-scribble.mjs runs this
// over every stroke this writer has drawn (the character drills and the
// paragraph pen samples, 10,701 strokes) and requires it to fire on the one
// real scribble-out among them and on nothing else. See the table it prints.

// Every knob, so a caller can loosen or tighten one. MEASURED over the 7,509
// real strokes this writer has drawn that are long enough to be a candidate,
// plus the one real scribble-out the corpus turns out to contain —
// gettysburg-p2 stroke 305, where the writer finished a line, paused 11 s,
// scrubbed over the last word in 991 ms and moved on. It reads turns 8,
// retrace 0.92, winding 6.14; the bars below leave every one of the 7,509 on
// the other side of them:
//
//   turns >= 5  seven letters reach 5 (a `w`, a long cursive run) and none 6
//   retrace     those seven top out at 0.4; the writer's cursive `m` is the
//               highest retracer that also turns (0.54 at turns 4)
//   winding     the letters at turns 5 top out at 3.29
//
// `turns 4 + retrace 0.6` also measures 0 false positives and would fire on a
// shorter scrub, but its only margin against that cursive `m` is 0.06 of
// retrace, where these bars each hold a real gap. A wrongly cleared cell costs
// more than a scribble the writer has to repeat.
export const SCRIBBLE = {
  turns: 5,        // reversals along the principal axis (no letter reaches 6; the scribble reaches 8)
  retrace: 0.5,    // share of the path laid back over its own ground (letters <= 0.54 at ANY turn count)
  winding: 3.5,    // path length / bbox diagonal (letters at 5 turns reach 3.29; the scribble 6.14)
  cover: 0.6,      // how completely this stroke and the existing ink overlap, per axis
  minLength: 40,   // px of path — a small wiggle is not a scribble
  minSpan: 12,     // px of bbox diagonal — nor is a dense scrub of one point
  deadband: 0.22,  // a reversal must retrace this much of the axis's extent
}

const INK_HALF = 2 // px — half the width the pad draws a stroke at

/** A box grown by the ink's own width, so a straight stroke is not a line. */
function grow(b) {
  return { x0: b.x0 - INK_HALF, y0: b.y0 - INK_HALF, x1: b.x1 + INK_HALF, y1: b.y1 + INK_HALF, w: b.w + 2 * INK_HALF, h: b.h + 2 * INK_HALF }
}

/** Bounding box of a point list ({x,y} or [x,y]). */
function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of pts) {
    const x = p.x !== undefined ? p.x : p[0], y = p.y !== undefined ? p.y : p[1]
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 }
}

/**
 * Reversals in a sequence of positions along one axis, with a deadband: the
 * value must retrace `deadband` of the axis's whole extent before the turn
 * counts, so pen jitter and the slight bow of a straight stroke do not.
 */
function turnsAlong(vals, deadband) {
  let lo = Infinity, hi = -Infinity
  for (const v of vals) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  const band = (hi - lo) * deadband
  if (!(band > 0)) return 0
  // `ext` is the running extremum IN THE CURRENT DIRECTION; a turn is a
  // retrace of more than `band` away from it. Until the pen has moved a full
  // band the direction is unknown and no turn can be counted.
  let dir = 0, ext = vals[0], turns = 0
  for (const v of vals) {
    if (dir > 0) {
      if (v > ext) ext = v
      else if (v < ext - band) { turns++; dir = -1; ext = v }
    } else if (dir < 0) {
      if (v < ext) ext = v
      else if (v > ext + band) { turns++; dir = 1; ext = v }
    } else if (v > ext + band) { dir = 1; ext = v } else if (v < ext - band) { dir = -1; ext = v }
  }
  return turns
}

/**
 * The stroke's own axes (principal + perpendicular), by PCA. Counting turns
 * in page x/y would miss a scribble scrubbed along a diagonal.
 */
function axes(pts) {
  let mx = 0, my = 0
  for (const p of pts) { mx += p.x; my += p.y }
  mx /= pts.length; my /= pts.length
  let sxx = 0, sxy = 0, syy = 0
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy
  }
  // Principal eigenvector of the 2x2 covariance, in closed form.
  const tr = sxx + syy, det = sxx * syy - sxy * sxy
  const l = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det))
  let ux = sxy, uy = l - sxx
  if (Math.hypot(ux, uy) < 1e-9) { ux = 1; uy = 0 }
  const n = Math.hypot(ux, uy)
  return { ux: ux / n, uy: uy / n }
}

/**
 * How much of the stroke is laid back over ground it has already covered —
 * the vector form of `docs/strikeout.md`'s measured discriminator (there,
 * vertical ink runs per column of a word crop; here, path near earlier path).
 * A scrub returns over the same span, so most of it retraces. An M, a W and a
 * cursive m advance and never touch their own ink, which is exactly what
 * `turns` alone cannot tell from a scrub with few passes.
 *
 * The path is resampled evenly first so "earlier" can be measured in path
 * DISTANCE (the pointer samples unevenly, and an index gap would mean
 * different things at different speeds), and a point only counts against
 * path more than `RETRACE_SKIP` radii behind it — otherwise every stroke
 * retraces its own immediate neighbourhood.
 */
const RETRACE_R = 0.09     // radius, as a fraction of the stroke's bbox diagonal
const RETRACE_SKIP = 4     // radii of path that must separate two passes

export function retraceOf(pts, span) {
  const r = Math.max(2, span * RETRACE_R)
  const step = r / 2
  // resample evenly at `step`
  const rs = [pts[0]]
  let carry = 0
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y
    let d = Math.hypot(dx, dy)
    if (!(d > 0)) continue
    let t = (step - carry) / d
    while (t <= 1) {
      rs.push({ x: pts[i - 1].x + dx * t, y: pts[i - 1].y + dy * t })
      t += step / d
    }
    carry = (carry + d) % step
  }
  if (rs.length < 8) return 0
  const skip = Math.round(RETRACE_SKIP * r / step)
  const key = (p) => `${Math.floor(p.x / r)},${Math.floor(p.y / r)}`
  const grid = new Map()
  rs.forEach((p, i) => {
    const k = key(p)
    if (!grid.has(k)) grid.set(k, [])
    grid.get(k).push(i)
  })
  let hit = 0
  for (let i = 0; i < rs.length; i++) {
    const p = rs[i]
    const cx = Math.floor(p.x / r), cy = Math.floor(p.y / r)
    let found = false
    for (let ax = -1; ax <= 1 && !found; ax++) {
      for (let ay = -1; ay <= 1 && !found; ay++) {
        for (const j of grid.get(`${cx + ax},${cy + ay}`) || []) {
          if (Math.abs(i - j) <= skip) continue
          if (Math.hypot(rs[j].x - p.x, rs[j].y - p.y) <= r) { found = true; break }
        }
      }
    }
    if (found) hit++
  }
  return hit / rs.length
}

/**
 * The four signals for `stroke` (a [{x,y}] path) against `prior` (the strokes
 * already in the cell). DOM-free and cheap: one pass for the axes, one per
 * axis for the turns, one grid pass for the retrace.
 */
export function scribbleFeatures(stroke, prior = [], opts = {}) {
  const k = { ...SCRIBBLE, ...opts }
  const pts = []
  for (const p of stroke) {
    const q = { x: p.x !== undefined ? p.x : p[0], y: p.y !== undefined ? p.y : p[1] }
    const last = pts[pts.length - 1]
    if (!last || Math.hypot(q.x - last.x, q.y - last.y) > 0.75) pts.push(q)
  }
  if (pts.length < 4) return { turns: 0, cross: 0, retrace: 0, winding: 0, cover: 0, length: 0, span: 0 }

  let length = 0
  for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  const b = bbox(pts)
  const span = Math.hypot(b.w, b.h)

  // Turns are counted along the stroke's PRINCIPAL axis only, and that is the
  // whole difference between a scribble and an M. A scrub goes back and forth
  // along the direction it is widest in; an M, a W and an advancing zigzag
  // travel that direction once and do their reversing across it. Counting the
  // max of both axes read this writer's M at 6 turns and a scrub at 9.
  const { ux, uy } = axes(pts)
  const major = pts.map((p) => p.x * ux + p.y * uy)
  const minor = pts.map((p) => -p.x * uy + p.y * ux)
  const turns = turnsAlong(major, k.deadband)
  const cross = turnsAlong(minor, k.deadband)

  // Cover: is this stroke drawn ACROSS ink that is already there. Each axis is
  // measured against the SMALLER of the two extents, so it reads "one of these
  // lies over the other" rather than "these are the same size" — a scrub over
  // one word of a line and a scrawl right across a small character are both
  // aimed at the ink, and an area ratio calls one of them a miss whichever way
  // round it is written. A scrub across the middle of a tall `1` covers 44% of
  // it by area and 100% of it by this.
  //
  // Both boxes are grown by INK_HALF first, and that is not a fudge: a drawn
  // I, l or 1 is a box of ZERO width, so intersecting it with anything gives a
  // zero-width overlap however the ratio is taken. Ink has a width; the boxes
  // need one too. (Both of these were found by driving the real pad — the
  // gesture simply became a second stroke.)
  //
  // This channel is NOT what keeps letters safe: the gate measures the shape
  // channels with cover ignored entirely and they are clean on all 10,701 real
  // strokes. What cover is for is a scribble in one corner of the cell not
  // throwing away a character in the other.
  let cover = 0
  const flat = []
  for (const st of prior) for (const p of st) flat.push(p)
  if (flat.length) {
    const a = grow(bbox(flat))
    const c = grow(b)
    const ox = Math.max(0, Math.min(a.x1, c.x1) - Math.max(a.x0, c.x0))
    const oy = Math.max(0, Math.min(a.y1, c.y1) - Math.max(a.y0, c.y0))
    cover = (ox / Math.min(a.w, c.w)) * (oy / Math.min(a.h, c.h))
  }
  return { turns, cross, retrace: retraceOf(pts, span), winding: span > 0 ? length / span : 0, cover, length, span }
}

/**
 * Was this stroke a scribble-out over `prior`? Needs all three signals; with
 * nothing in the cell there is nothing to scribble out, so it is never one.
 */
export function isScribble(stroke, prior = [], opts = {}) {
  const k = { ...SCRIBBLE, ...opts }
  if (!prior || !prior.length) return false
  const f = scribbleFeatures(stroke, prior, k)
  return f.length >= k.minLength && f.span >= k.minSpan &&
    f.turns >= k.turns && f.retrace >= k.retrace && f.winding >= k.winding && f.cover >= k.cover
}
