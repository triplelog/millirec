// MillirecCharLite — the single-character recognizer for DRAWN input only, on
// the stripped matcher (scripts/build-wasm-lite.sh). Same training.js, same
// worker protocol, same scores as MillirecChar's stroke path; what is gone is
// everything a stroke-only library never calls — the photo pipeline, grids,
// scene splitting, geometry fusion — and the batch/cascade half of the wasm.
// Assembled into library/templates/char-lite/ by scripts/build-lite.mjs.
//
//   const rec = await MillirecCharLite.create()        // uses training.js
//   rec.attach(document.querySelector('#pad'))         // draw UI + events
//   await rec.recognize(strokes)                       // [{char, prob} x3]
//   rec.use({ rerank })                                // custom comparisons
//   await rec.rawScores(strokes)                       // {classes, costs}

import { POINTS_PER_SHAPE, SECOND_AVERAGE } from '../../core/pipeline/constants.js'
import { parseResult } from '../../core/pipeline/calibrate.js'
import { orientedPointsFromPolyline, resampleStrokes, polylineToSample } from '../../core/pipeline/stroke.js'
import { decodeSample } from '../../core/format/delta.js'
import { decode as decodeTraining, samplesMap } from '../../core/format/schema.js'
import { createDrawCanvas } from '../../widget/canvas.js'
import { assetBaseOf, notServed } from './assetbase.js'

function scriptBase() {
  const src = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || ''
  return src ? src.slice(0, src.lastIndexOf('/') + 1) : ''
}
const ASSET_BASE = scriptBase()
const CACHE_MAX = 256   // readings kept per recognizer (least recently used goes first)

/** The worker client, stroke mode only (see core/recognizer.js for the full
 *  one — this keeps the protocol and drops the image arms). */
class StrokeWorker {
  constructor({ assetBase, workerName, training, params }) {
    assetBase = assetBaseOf(assetBase)
    const decoded = decodeTraining(training)
    this.trainPaths = samplesMap(decoded)
    this.charList = Object.keys(this.trainPaths)
    this.samplesPerChar = Math.max(1, ...this.charList.map((c) => this.trainPaths[c].length))
    this.pointsPerShape = decoded.pointsPerShape || POINTS_PER_SHAPE
    this.params = params || decoded.params || null
    this.plugins = []
    this.cache = new Map()
    this.inFlight = new Map()
    this.allWaiters = new Map()
    this.reqCounter = 0
    const boot = `self.__MILLIREC_ASSET_BASE=${JSON.stringify(assetBase)};importScripts(${JSON.stringify(assetBase + workerName)});`
    this.bootUrl = URL.createObjectURL(new Blob([boot], { type: 'text/javascript' }))
    this.worker = new Worker(this.bootUrl)
    this.readyPromise = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject })
    this.worker.onmessage = (evt) => this.onMessage(evt)
    const workerUrl = assetBase + workerName
    this.worker.onerror = (evt) => {
      // Once it has booted, an error is the worker failing mid-work: nothing it was asked will be
      // answered, so everyone waiting gets null now rather than at their timeouts.
      if (this.booted) { this.flush(); return }
      const e = notServed(workerUrl, 'the char-lite worker', assetBase, 'char-lite')
      e.message += ` (${evt.message || 'script failed to load'})`
      this.failBoot(e)
    }
    this.assetBase = assetBase
  }

  onMessage(evt) {
    const d = evt.data
    if (this.bootUrl) { URL.revokeObjectURL(this.bootUrl); this.bootUrl = null }   // the worker has booted from it
    if (d.type === 'getCharList') {
      if (this.params) this.worker.postMessage({ type: 'setParams', params: this.params })
      this.worker.postMessage({ type: 'charList', charList: this.charList, pointsPerShape: this.pointsPerShape, samplesPerChar: this.samplesPerChar })
    } else if (d.type === 'prepAll') {
      this.charList.forEach((c, idx) => {
        this.trainPaths[c].forEach((sample, i) => {
          const { points, scale } = orientedPointsFromPolyline(decodeSample(sample))
          this.worker.postMessage({ type: 'addPoints', points, m: idx * this.samplesPerChar + i, scale })
        })
      })
      this.booted = true
      this.readyResolve()
    } else if (d.type === 'addResult' && d.result) {
      this.cache.delete(d.path)
      this.cache.set(d.path, d.result)
      if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value)
      const waiters = this.inFlight.get(d.path) || []
      this.inFlight.delete(d.path)
      for (const resolve of waiters) resolve(this.applyPlugins(d.result, d.path))
    } else if (d.type === 'allResult') {
      const waiters = this.allWaiters.get(d.path) || []
      this.allWaiters.delete(d.path)
      for (const resolve of waiters) resolve(d.costs)
    } else if (d.type === 'bootError') {
      const e = notServed(this.assetBase + 'millirec.wasm', 'the char-lite matcher', this.assetBase, 'char-lite')
      e.message += ` (worker boot failed: ${d.message})`
      this.failBoot(e)
    }
  }

  /** Everyone waiting on the worker gets null, and nothing is left "in flight". */
  flush() {
    for (const map of [this.inFlight, this.allWaiters]) { const lists = [...map.values()]; map.clear(); for (const list of lists) for (const done of list) done(null) }
  }

  /** The worker never came up: create() rejects with `e`, and the worker and its boot URL are released. */
  failBoot(e) {
    this.readyReject(e)
    this.destroyed = true
    try { this.worker.terminate() } catch {}
    if (this.bootUrl) { URL.revokeObjectURL(this.bootUrl); this.bootUrl = null }
  }

  applyPlugins(raw, path) {
    let out = parseResult(raw, this.charList, 'stroke', SECOND_AVERAGE)
    for (const p of this.plugins) if (p.rerank) out = p.rerank(out, { raw, path, charList: this.charList, mode: 'stroke', recognizer: this }) || out
    return out
  }

  uploadTest(input) {
    const strokes = Array.isArray(input[0]) ? input : [input]
    const polyline = resampleStrokes(strokes, this.pointsPerShape)
    if (!polyline) return false
    const { points, scale } = orientedPointsFromPolyline(polyline)
    this.worker.postMessage({ type: 'addPoints', points, m: -1, scale })
    return true
  }

  keyFor(input) {
    const flat = Array.isArray(input[0]) ? input.flat() : input
    let hash = 5381
    for (const p of flat) hash = ((hash * 33) ^ ((p.x * 7919 + p.y) | 0)) >>> 0
    return 'strokes:' + flat.length + ':' + hash.toString(36)
  }

  async recognize(strokes) {
    if (this.destroyed || !strokes || !strokes.length) return null
    await this.readyPromise
    if (this.destroyed) return null
    const key = this.keyFor(strokes)
    if (this.cache.has(key)) {
      const hit = this.cache.get(key)
      this.cache.delete(key); this.cache.set(key, hit)   // most recently used last
      return this.applyPlugins(hit, key)
    }
    if (!this.uploadTest(strokes)) return null
    return new Promise((resolve) => {
      let timer
      const done = (v) => { clearTimeout(timer); resolve(v) }
      if (this.inFlight.has(key)) this.inFlight.get(key).push(done)
      else {
        this.inFlight.set(key, [done])
        this.worker.postMessage({ type: 'compare', path: key, elementID: 'req' + ++this.reqCounter })
      }
      // On a timeout this caller gives up — and the key must stop counting as in flight once nobody
      // is waiting on it. It used to stay: if the worker never answered, every later recognize() of
      // the same strokes joined a request that was never re-sent and came back null after 4 s, forever.
      timer = setTimeout(() => {
        const waiting = this.inFlight.get(key)
        if (waiting) {
          const i = waiting.indexOf(done)
          if (i >= 0) waiting.splice(i, 1)
          if (!waiting.length) this.inFlight.delete(key)
        }
        done(null)
      }, 4000)
    })
  }

  async rawScores(strokes) {
    if (this.destroyed) return null
    await this.readyPromise
    if (this.destroyed) return null
    if (!this.uploadTest(strokes)) return null
    const key = 'all:' + ++this.reqCounter
    const costs = await new Promise((resolve) => {
      let timer
      const done = (v) => { clearTimeout(timer); resolve(v) }
      this.allWaiters.set(key, [done])
      this.worker.postMessage({ type: 'compareAll', path: key, counts: this.charList.map((c) => this.trainPaths[c].length) })
      timer = setTimeout(() => { this.allWaiters.delete(key); done(null) }, 8000)
    })
    return costs ? { classes: this.charList, costs } : null
  }

  /** Stop the worker; anything still waiting gets null, and so does every later call. */
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.worker.terminate()
    if (this.bootUrl) { URL.revokeObjectURL(this.bootUrl); this.bootUrl = null }
    this.flush()
    this.cache.clear()
    this.readyResolve()   // a create() or call still waiting for the boot settles (and then sees destroyed)
  }
}

const toPairs = (parsed) => (parsed ? parsed.chars.map((c, i) => ({ char: c, prob: parsed.probs[i] })) : null)

export class MillirecCharLite {
  /** Drawn strokes → one training sample (resampled points, delta-encoded).
   *  Pass the set's pointsPerShape to match it (the shipped sets are 25). */
  static strokesToSample(strokes, pointsPerShape = POINTS_PER_SHAPE) {
    const polyline = resampleStrokes(Array.isArray(strokes[0]) ? strokes : [strokes], pointsPerShape)
    return polyline ? polylineToSample(polyline) : null
  }

  /**
   * A copy of `training` with your own samples added — the way to make a
   * recognizer learn one person's hand. `extra` maps a class (any string: a
   * letter, a digit, an emoji) to drawings: strokes ([[{x,y},...], ...]) or
   * already-encoded samples ({x:[Δ...], y:[Δ...]}). Each is resampled to the
   * set's pointsPerShape. Classes not in `training` are added. `replace: true`
   * drops a class's shipped samples instead of appending to them. `training`
   * is not modified.
   */
  static withSamples(training, extra, { replace = false } = {}) {
    const base = decodeTraining({ ...training })
    const n = base.pointsPerShape
    const toSample = (d) => {
      const strokes = Array.isArray(d) ? (Array.isArray(d[0]) ? d : [d]) : [decodeSample(d)]
      const polyline = resampleStrokes(strokes, n)
      return polyline ? polylineToSample(polyline) : null
    }
    const classes = { ...base.classes }
    for (const [cls, drawings] of Object.entries(extra || {})) {
      const own = (drawings || []).map(toSample).filter(Boolean)
      if (!own.length) continue
      const shipped = classes[cls]?.samples || []
      classes[cls] = { ...(classes[cls] || {}), samples: replace ? own : shipped.concat(own) }
    }
    return { ...base, classes }
  }

  static createDrawCanvas(opts) { return createDrawCanvas(opts) }

  /** opts: training (default window.MILLIREC_TRAINING), assetBase (default:
   *  alongside this script), params (matcher overrides), workerStroke. */
  static async create(opts = {}) {
    const g = typeof window !== 'undefined' ? window : globalThis
    const config = { ...(g.MILLIREC_CONFIG || {}), ...opts }
    const training = opts.training || g.MILLIREC_TRAINING
    if (!training) throw new Error('MillirecCharLite: no training data (training.js missing?)')
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined') {
      throw new Error('millirec: char-lite needs a browser (Worker, fetch, canvas); importing is SSR-safe but call create() on the client')
    }
    const inst = new this(config, training)
    await inst.ready
    return inst
  }

  constructor(config, training) {
    this.config = config
    this.stroke = new StrokeWorker({
      assetBase: config.assetBase || ASSET_BASE,
      workerName: config.workerStroke || 'worker-stroke.js',
      training,
      params: config.params?.stroke || config.params || null,
    })
    this.charList = this.stroke.charList
    this.ready = this.stroke.readyPromise
  }

  use(plugin) { this.stroke.plugins.push(plugin); return this }

  /** Recognize drawn strokes ([[{x,y},...], ...] or one polyline) → [{char, prob} x3] | null. */
  async recognize(strokes) { return toPairs(await this.stroke.recognize(strokes)) }

  /** Raw per-template costs → {classes, costs}. */
  rawScores(strokes) { return this.stroke.rawScores(strokes) }

  /**
   * Mount a drawing pad in `el`; fires 'millirec:result' ({results, strokes})
   * after each stroke, and 'millirec:clear' ({reason, undo}) when the pad
   * drops its own ink.
   *
   * The pad reads ONE character, so by default writing in it after a pause
   * starts a fresh one (`idleOverwrite`, seconds — 0 turns it off) and
   * scribbling over it throws it away (`scribbleClear`). Both are measured:
   * see widget/canvas.js and scripts/verify-scribble.mjs.
   */
  attach(el, { width = 240, height = 240, ink = '#1e293b', idleOverwrite = 2, scribbleClear = true, scribble = null, staleAlpha, onStale } = {}) {
    const pad = createDrawCanvas({
      width, height, ink, idleOverwrite, scribbleClear, scribble, onStale, ...(staleAlpha === undefined ? {} : { staleAlpha }),
      onClear: (reason) => el.dispatchEvent(new CustomEvent('millirec:clear', { detail: { reason, undo: () => pad.undoClear() } })),
      onStrokeEnd: async (strokes) => {
        // An empty pad reports too: the cell was scribbled out or erased, and
        // a caller left holding the last reading shows a letter that is gone.
        if (!strokes.length) { el.dispatchEvent(new CustomEvent('millirec:result', { detail: { results: [], strokes: [] } })); return }
        const results = await this.recognize(strokes)
        el.dispatchEvent(new CustomEvent('millirec:result', { detail: { results, strokes } }))
      },
    })
    el.appendChild(pad.el)
    return { clear: pad.clear, undoClear: pad.undoClear, isStale: pad.isStale, configure: pad.configure, setInk: pad.setInk, repaint: pad.repaint, getStrokes: pad.getStrokes, canvas: pad.el }
  }

  destroy() { this.stroke.destroy() }
}

// the script-tag build's globals; the ES-module builds define __MILLIREC_ESM__ and set none
if (typeof window !== 'undefined' && typeof __MILLIREC_ESM__ === 'undefined') {
  window.MillirecCharLite = MillirecCharLite
  if (!window.MillirecChar) window.MillirecChar = MillirecCharLite
}
