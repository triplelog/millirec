// Vanilla port of the MiniCanvas drawing surface (pointer events, coalesced
// moves, single-point strokes widened so a tap still registers).

import { isScribble } from './scribble.js'

const ERASE_RADIUS = 12 // px from a stroke's ink that counts as touching it

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())

/**
 * @param colorOf   optional (stroke) => color | null — per-stroke color, so a
 *                  caller can highlight the strokes it has recognized. Strokes
 *                  carry a stable `id`, which survives an erase where the array
 *                  index does not.
 *
 * TWO WAYS TO WRITE OVER WHAT IS IN THE CELL, both off unless asked for:
 *
 * @param idleOverwrite  seconds of pen-up after which the NEXT stroke starts a
 *                  fresh drawing instead of adding to this one — a
 *                  single-character pad can only read one character, so
 *                  without it the second character lands on top of the first
 *                  and the reading is neither. It fires on the pen coming
 *                  down, not on the timer, so the ink stays visible while the
 *                  writer thinks; at the threshold it goes faint, which is the
 *                  warning that the next stroke replaces it. MEASURED on this
 *                  writer's drill sheets: within one character the pen-up gap
 *                  is 192 ms median, 367 ms at p90 and 1121 ms at p99, with
 *                  two pairs in 443 over 1.5 s (both interruptions — 2.8 s and
 *                  8.9 s), so 2 seconds costs 0.45% of real within-character
 *                  pauses and the faint ink shows the writer even those.
 * @param scribbleClear  scribble over the cell to throw it away — geometry
 *                  only, never the recognizer's confidence (widget/scribble.js
 *                  says why, and scripts/verify-scribble.mjs is the gate).
 * @param scribble  overrides for the gesture's bars (see SCRIBBLE).
 * @param onClear   (reason) => void — 'idle' or 'scribble', fired when the pad
 *                  drops its own ink. `undoClear()` puts it back.
 * @param staleAlpha how faint the ink goes once the idle window has passed.
 *                  1 keeps it solid, for a caller that would rather say
 *                  "settled" with a colour (`/gridlab.html` turns it black).
 * @param onStale   (stale) => void — every transition of that state, so a
 *                  caller can restyle the cell rather than only fade it.
 */
export function createDrawCanvas({ width = 160, height = 90, ink = '#111827', onStrokeEnd, colorOf = null,
  idleOverwrite = 0, scribbleClear = false, scribble = null, onClear = null, staleAlpha = 0.3, onStale = null }) {
  const canvas = document.createElement('canvas')
  const dpr = (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1
  canvas.width = width * dpr
  canvas.height = height * dpr
  canvas.style.width = width + 'px'
  canvas.style.height = height + 'px'
  canvas.style.touchAction = 'none'
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)

  let strokes = []
  let current = []
  let activeId = null
  let erasing = false
  let nextId = 1
  let lastEndAt = 0      // pen-up time of the last stroke, for idleOverwrite
  let staleTimer = 0
  let stale = false      // the idle window has passed: the next stroke starts fresh
  let dropped = null     // what the pad cleared by itself, for undoClear()
  let droppedPending = false

  function paint(st, color) {
    if (st.length < 2) return
    ctx.strokeStyle = color || ink
    ctx.beginPath()
    ctx.moveTo(st[0].x, st[0].y)
    for (let i = 1; i < st.length; i++) ctx.lineTo(st[i].x, st[i].y)
    ctx.stroke()
  }

  function render() {
    ctx.clearRect(0, 0, width, height)
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    // Faint once the idle window has passed: the writer can see that the next
    // stroke will replace this, BEFORE the pen lands rather than after.
    ctx.globalAlpha = stale ? staleAlpha : 1
    for (const st of strokes) paint(st, colorOf && colorOf(st))
    ctx.globalAlpha = 1
    paint(current, null)
  }

  /** ONE place the settled state changes, so `onStale` cannot miss an edge. */
  function setStale(v) {
    if (stale === v) return
    stale = v
    render()
    if (onStale) onStale(v)
  }

  /** Re-arm the "the next stroke starts fresh" warning. */
  function armStale() {
    clearTimeout(staleTimer)
    staleTimer = 0
    const ms = (Number(idleOverwrite) || 0) * 1000
    if (!ms || !strokes.length) { setStale(false); return }
    const left = ms - (now() - lastEndAt)
    if (left <= 0) { setStale(true); return }
    setStale(false)
    staleTimer = setTimeout(() => setStale(true), left)
  }

  /** Drop the pad's own ink, keeping it for undoClear(). */
  function dropAll(reason) {
    if (!strokes.length) return
    dropped = strokes
    strokes = []
    clearTimeout(staleTimer)
    staleTimer = 0
    setStale(false)
    render()
    if (onClear) onClear(reason)
  }

  /** Remove any stroke passing within ERASE_RADIUS of (x, y). */
  function eraseAt(x, y) {
    const kept = strokes.filter((st) => !st.some((p) => Math.hypot(p.x - x, p.y - y) <= ERASE_RADIUS))
    if (kept.length === strokes.length) return false
    strokes = kept
    render()
    return true
  }

  // The rect is read ONCE per stroke, at pointerdown, and the position is
  // scaled from the canvas's CSS box to its drawing box: a host page that
  // styles the canvas (max-width:100% on a phone) otherwise draws offset,
  // shrunken strokes, and reading getBoundingClientRect per coalesced sample
  // forces a layout per sample (the pensurface.mjs iPadOS finding).
  let rect = null
  const getPos = (e) => {
    const r = rect || (rect = canvas.getBoundingClientRect())
    const sx = width / (canvas.clientWidth || width), sy = height / (canvas.clientHeight || height)
    return { x: (e.clientX - r.left - canvas.clientLeft) * sx, y: (e.clientY - r.top - canvas.clientTop) * sy, p: e.pressure || 0.5 }
  }

  let erasedAny = false
  let activeType = null

  // iOS Safari still starts a scroll/zoom from touchstart on some builds, and
  // a long press opens the callout / context menu — swallow both so a pad is
  // only ever a pad. The barrel button and a right click draw nothing.
  const swallow = (e) => e.preventDefault()
  canvas.addEventListener('touchstart', swallow, { passive: false })
  canvas.addEventListener('touchmove', swallow, { passive: false })
  canvas.addEventListener('contextmenu', swallow)
  canvas.style.userSelect = canvas.style.webkitUserSelect = 'none'
  canvas.style.webkitTouchCallout = 'none'

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return
    if (activeId !== null && activeId !== e.pointerId) {
      // A second pointer while one is drawing: a finger or palm beside a pen
      // is a palm and is ignored; anything else means the first pointer's
      // up never arrived (capture lost, odd browser), so commit what it drew
      // and let the new pointer take over instead of locking the pad.
      if (activeType === 'pen' && e.pointerType !== 'pen') return
      finish({ pointerId: activeId })
    }
    e.preventDefault()
    activeId = e.pointerId
    activeType = e.pointerType
    rect = canvas.getBoundingClientRect()
    try { canvas.setPointerCapture(e.pointerId) } catch { /* pointer already gone: draw uncaptured */ }
    const pos = getPos(e)
    if (erasing) { erasedAny = eraseAt(pos.x, pos.y); return }
    // The idle window fires HERE, not on its timer: writing in the cell is
    // what says "this is a new character", and until then the old one is
    // still worth looking at.
    if (stale && strokes.length) { dropAll('idle'); droppedPending = true }
    current = [pos]
    render()
  }, { passive: false })

  canvas.addEventListener('pointermove', (e) => {
    if (activeId !== e.pointerId) return
    e.preventDefault()
    const co = e.getCoalescedEvents ? e.getCoalescedEvents() : null
    const events = co && co.length ? co : [e]
    if (erasing) {
      for (const ev of events) { const p = getPos(ev); if (eraseAt(p.x, p.y)) erasedAny = true }
      return
    }
    for (const ev of events) current.push(getPos(ev))
    render()
  }, { passive: false })

  const finish = (e, cancelled = false) => {
    if (activeId !== e.pointerId) return
    try { canvas.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
    activeId = null
    activeType = null
    rect = null
    if (erasing) {
      // An erase changes the drawing as much as a stroke does, so it reports
      // through the same channel — the caller re-reads whatever is left.
      if (erasedAny) {
        lastEndAt = now()
        armStale()
        if (onStrokeEnd) onStrokeEnd(strokes)
      }
      erasedAny = false
      return
    }
    if (current.length > 0) {
      let st = current
      if (st.length === 1) {
        // A tap is a dot and must register; a CANCELLED single point (a palm
        // the OS took back, a scroll gesture claiming the pointer) is not.
        if (cancelled) {
          current = []
          render()
          // An idle wipe on the way down has no stroke to report it, so say so
          // here or the caller keeps showing a reading of ink that is gone.
          if (droppedPending) { droppedPending = false; if (onStrokeEnd) onStrokeEnd(strokes) }
          return
        }
        const p = st[0]
        st = [{ x: p.x - 1, y: p.y, p: p.p }, { x: p.x + 1, y: p.y, p: p.p }]
      }
      // Scribbled over what was already there? Then the stroke is a gesture,
      // not ink: it goes with everything it was aimed at. `dropped` stands in
      // when the idle wipe took that ink on the way DOWN — the writer aimed at
      // a character that was still on screen when the pen landed, and without
      // this the gesture survives as ink and the cell ends up holding the
      // scribble, which is the one outcome neither feature wants.
      const aimedAt = strokes.length ? strokes : (droppedPending ? dropped : null)
      if (scribbleClear && aimedAt && aimedAt.length && isScribble(st, aimedAt, scribble || {})) {
        current = []
        lastEndAt = now()
        droppedPending = false
        if (strokes.length) dropAll('scribble')
        else { render(); if (onClear) onClear('scribble') }
        if (onStrokeEnd) onStrokeEnd(strokes)
        return
      }
      st.id = nextId++
      strokes = [...strokes, st]
      current = []
      droppedPending = false
      lastEndAt = now()
      armStale()
      if (onStrokeEnd) onStrokeEnd(strokes)
    }
    render()
  }
  canvas.addEventListener('pointerup', (e) => finish(e))
  canvas.addEventListener('pointercancel', (e) => finish(e, true))

  return {
    el: canvas,
    getStrokes: () => strokes,
    setInk(color) { ink = color; render() },
    setErasing(on) {
      erasing = !!on
      canvas.style.cursor = erasing ? 'cell' : 'crosshair'
    },
    isErasing: () => erasing,
    repaint: render,
    /** True once the idle window has passed: the next stroke starts fresh. */
    isStale: () => stale,
    /**
     * Put back what the pad cleared BY ITSELF — an idle overwrite or a
     * scribble. An explicit `clear()` is not stashed: a caller clears the pad
     * because it has banked the drawing, and restoring that would hand back a
     * sample the writer already dealt with.
     */
    undoClear() {
      if (!dropped || !dropped.length) return false
      strokes = strokes.length ? [...dropped, ...strokes] : dropped
      dropped = null
      lastEndAt = now()
      armStale()
      render()
      if (onStrokeEnd) onStrokeEnd(strokes)
      return true
    },
    /** Change either overwrite behaviour, or the settled look, at runtime. */
    configure(opts = {}) {
      if ('idleOverwrite' in opts) idleOverwrite = Number(opts.idleOverwrite) || 0
      if ('scribbleClear' in opts) scribbleClear = !!opts.scribbleClear
      if ('scribble' in opts) scribble = opts.scribble
      if ('staleAlpha' in opts) staleAlpha = Number(opts.staleAlpha)
      armStale()
    },
    clear() {
      strokes = []
      current = []
      activeId = null
      activeType = null
      rect = null
      clearTimeout(staleTimer)
      staleTimer = 0
      setStale(false)
      droppedPending = false
      render()
      if (onStrokeEnd) onStrokeEnd(strokes)
    },
  }
}

/** Render strokes to a small PNG data URL (the "drawn reaction" thumbnail). */
export function strokesToPng(strokes, size = 64, ink = '#111827') {
  const pts = []
  for (const st of strokes) for (const p of st) pts.push(p)
  if (!pts.length) return ''
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
  }
  const pad = 6
  const w = Math.max(maxX - minX, 1)
  const h = Math.max(maxY - minY, 1)
  const scale = (size - pad * 2) / Math.max(w, h)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  ctx.translate((size - w * scale) / 2, (size - h * scale) / 2)
  ctx.lineWidth = 3
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = ink
  for (const st of strokes) {
    if (!st.length) continue
    ctx.beginPath()
    st.forEach((p, i) => {
      const x = (p.x - minX) * scale
      const y = (p.y - minY) * scale
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }
  return canvas.toDataURL('image/png')
}

