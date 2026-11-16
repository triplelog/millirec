// MillirecCharCnnCore — the runtime WITHOUT the drawing pad (callers pass
// strokes to recognize()): the smallest build. library/src/char-cnn.js adds
// attach() on top of it.
//
// MillirecCharCnn — drawn capital letters through a softmax CNN, optionally a
// two-stage cascade (a tiny model first; a larger one only when the tiny one's
// runner-up is close). No templates, no matcher: the bundle is this runtime,
// the model files, and optionally the wasm kernel (cnn-web.js + cnn-web.wasm)
// which serves the same models ~20x faster than the plain-JS forward.
//
//   const rec = await MillirecCharCnn.create({
//     classes: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
//     stages: [
//       { model: 'tiny.bin', head: 'tiny.head.bin', theta: 2.6 },   // exit when runner-up > theta nats behind
//       { model: 'base.bin', head: 'base.head.bin' },
//     ],
//     kernel: 'cnn-web.js',   // optional; omit for plain JS. n-bit .bin files are expanded to int8 for the kernel
//   })
//   rec.attach(document.querySelector('#pad'))
//   await rec.recognize(strokes)   // [{char, prob} x3] + .stage (which model decided)
//
// Heads are trained on relu(unit embedding) (cnnlab/caps.py --headNorm), which
// is what lets the kernel — it returns only the unit embedding — serve softmax.
// Rasterisation is the one the models were trained and measured on
// (cnnjs.drawStrokes -> cnnprep.normalizeInk), so the numbers on /sizelab.html
// are the numbers here.

import { parseModel, parseHead, embed, unit, logits, softmax, drawStrokes, inkPlane, expandToInt8 } from '../../server/public/wordgpu/cnnjs.mjs'
import { normalizeInk } from '../../server/public/wordgpu/cnnprep.mjs'
import { assetBaseOf, asStrokes, fetchAsset, notServed } from './assetbase.js'

function scriptBase() {
  const src = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || ''
  return src ? src.slice(0, src.lastIndexOf('/') + 1) : ''
}
const ASSET_BASE = scriptBase()
const fetchBuf = (url, base) => fetchAsset(url, { as: 'buf', what: 'a char-cnn model file', base, recognizer: 'char-cnn' })
const DESTROYED = 'millirec: recognizer destroyed'
// the raster canvas: a <canvas> on a page, an OffscreenCanvas in a worker
const makeCanvas = (n) => (typeof document !== 'undefined' && document.createElement ? Object.assign(document.createElement('canvas'), { width: n, height: n })
  : typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(n, n) : null)

export class MillirecCharCnnCore {
  static async create(opts = {}) {
    const g = typeof window !== 'undefined' ? window : globalThis
    const config = { ...(g.MILLIREC_CNN || {}), ...opts }
    if (!config.stages || !config.stages.length) throw new Error('MillirecCharCnn: no stages configured')
    if (typeof fetch === 'undefined' || (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined')) {
      throw new Error('millirec: char-cnn needs a browser (fetch, and a canvas or OffscreenCanvas); importing is SSR-safe but call create() on the client')
    }
    const inst = new this(config)
    await inst.ready
    return inst
  }

  constructor(config) {
    this.config = config
    this.base = assetBaseOf(config.assetBase || ASSET_BASE)
    this.classes = typeof config.classes === 'string' ? config.classes.split('') : config.classes
    this.stages = []
    this.off = makeCanvas(140)
    this.octx = this.off ? this.off.getContext('2d', { willReadFrequently: true }) : null
    this.ready = this.load()
  }

  async load() {
    const { base, config } = this
    let factory = null
    if (config.kernel) {
      const url = base + config.kernel
      try { factory = (await import(/* @vite-ignore */ /* webpackIgnore: true */ url)).default } catch (e) { const err = notServed(url, 'the char-cnn kernel', base, 'char-cnn'); err.message += ` (${e && e.message})`; throw err }
    }
    for (const st of config.stages) {
      const [modelBuf, headBuf] = await Promise.all([fetchBuf(base + st.model, base), fetchBuf(base + st.head, base)])
      if (this.destroyed) return
      const head = parseHead(headBuf)
      const stage = { theta: st.theta == null ? null : st.theta, head, headNorm: st.headNorm !== false, size: 0 }
      if (factory) {
        // one kernel instance per stage: cnnLoad holds one model. An n-bit file
        // is expanded to the kernel's int8 layout here (same levels, same logits)
        const M = await factory()
        if (this.destroyed) return
        const bytes = expandToInt8(new Uint8Array(modelBuf))
        const ptr = M._malloc(bytes.byteLength); M.HEAPU8.set(bytes, ptr)
        const loaded = M._cnnLoad(ptr, bytes.byteLength)
        M._free(ptr)
        if (!loaded) throw new Error(`kernel rejected ${st.model} (channel widths must be multiples of four)`)
        const size = M._cnnSize(), dim = M._cnnDim()
        stage.size = size
        stage.embed = (img) => { const ip = M._cnnInputPtr(1) >> 2; M.HEAPF32.set(img, ip); M._cnnRun(1); const o = M._cnnEmbedPtr(1) >> 2; return M.HEAPF32.slice(o, o + dim) }   // the kernel returns the unit embedding; copied out of its memory
        stage.logits = (img) => logits(stage.head, stage.embed(img))
      } else {
        const model = parseModel(modelBuf)
        stage.size = model.size
        stage.embed = (img) => { const e = embed(model, img); return stage.headNorm ? unit(e) : e }
        stage.logits = (img) => logits(stage.head, stage.embed(img))
      }
      this.stages.push(stage)
    }
  }

  /** drawn strokes ([[{x,y},...],...]) -> the model input raster at `size`.
   *  The canvas draw + readback is the dear part (~1 ms) and is shared by every
   *  stage of one recognize() call; only the resample differs per size. */
  raster(strokes, size) {
    if (!this.octx) throw new Error('millirec: char-cnn needs a canvas to draw strokes on (a document, or OffscreenCanvas in a worker)')
    if (this._planeFor !== strokes) {
      const W = drawStrokes(this.octx, strokes)
      this._plane = { ink: inkPlane(this.octx.getImageData(0, 0, W, W).data, W, W), W }
      this._planeFor = strokes
    }
    const { ink, W } = this._plane
    return normalizeInk(ink, W, W, size, Math.round(size * 0.75))
  }

  /**
   * -> [{char, prob} x3] (best first) with `.stage` = index of the model that decided, or null.
   * `only` (an array or Set of characters) restricts the answer to those: the softmax is taken over them alone, so a box
   * that can hold one of two letters gets the likelier of the two however the rest of the alphabet scores — and the
   * cascade runs to its last stage, since an early exit is judged on the whole alphabet's margin.
   */
  async recognize(strokes, { only = null } = {}) {
    strokes = asStrokes(strokes)
    if (!strokes || !strokes.length) return null
    await this.ready
    if (this.destroyed || !this.stages.length) return null
    this._planeFor = null   // one draw + readback per call, shared by the stages
    const keep = only ? new Set(only) : null
    let z = null, used = 0
    for (let s = 0; s < this.stages.length; s++) {
      const st = this.stages[s]
      if ((this.personal || keep) && s < this.stages.length - 1) continue   // only the last stage's head is refit on the player's hand: no early exit
      z = st.logits(this.raster(strokes, st.size))
      used = s
      if (st.theta == null || s === this.stages.length - 1) break
      let b = -Infinity, b2 = -Infinity
      for (const v of z) { if (v > b) { b2 = b; b = v } else if (v > b2) b2 = v }
      if (b - b2 >= st.theta) break
    }
    let idx = [...z.keys()]
    if (keep) { idx = idx.filter((c) => keep.has(this.classes[c])); if (!idx.length) { const out = []; out.stage = used; return out } }
    const p = softmax(idx.map((c) => z[c]))
    const order = [...p.keys()].sort((a, b) => p[b] - p[a]).slice(0, 3)
    const out = order.map((i) => ({ char: this.classes[idx[i]], prob: p[i] }))
    out.stage = used
    return out
  }

  /** The last stage's (unit) embedding of drawn strokes — what the head reads. */
  async embedding(strokes) {
    strokes = asStrokes(strokes)
    await this.ready
    if (this.destroyed || !this.stages.length) throw new Error(DESTROYED)
    this._planeFor = null
    const st = this.stages[this.stages.length - 1]
    return st.embed(this.raster(strokes, st.size))
  }
  /**
   * PERSONALIZE: refit the last stage's head (a softmax over the frozen embedding) on the player's own samples
   * (`{ 'A': [strokes…], … }`), anchored to the shipped head — the anchor's pull is prior/n, so a few samples barely move
   * a letter and many take it over. Plain
   * gradient descent on the mean cross-entropy: a few hundred steps over a few hundred samples is ~100 ms. While a
   * personal head is in place the cascade always runs to the last stage (the tiny head is the shipped one).
   * Returns { n, classes } or null (nothing usable). `depersonalize()` restores the shipped head.
   */
  async personalize(samples, { steps = 250, lr = 0.5, prior = 1.0 } = {}) {
    await this.ready
    if (this.destroyed || !this.stages.length) return null
    const st = this.stages[this.stages.length - 1]
    const H0 = st.head0 || (st.head0 = st.head)
    const X = [], Y = []
    for (const [cls, list] of Object.entries(samples || {})) {
      const c = this.classes.indexOf(cls)
      if (c < 0) continue
      for (const drawing of list || []) { const strokes = asStrokes(drawing); if (!strokes || !strokes.length) continue; X.push(await this.embedding(strokes)); Y.push(c) }
    }
    if (this.destroyed) return null
    if (!X.length) { st.head = H0; this.personal = null; return null }
    const head = { in: H0.in, out: H0.out, w: Float32Array.from(H0.w), bias: Float32Array.from(H0.bias) }
    const n = X.length, gW = new Float32Array(head.w.length), gB = new Float32Array(head.out)
    for (let step = 0; step < steps; step++) {
      gW.fill(0); gB.fill(0)
      for (let i = 0; i < n; i++) {
        const p = softmax(logits(head, X[i])), x = X[i]
        for (let o = 0; o < head.out; o++) {
          const g = (p[o] - (o === Y[i] ? 1 : 0)) / n
          if (!g) continue
          gB[o] += g
          const wb = o * head.in
          for (let j = 0; j < head.in; j++) { const v = x[j]; if (v > 0) gW[wb + j] += g * v }
        }
      }
      const a = prior / n
      for (let k = 0; k < head.w.length; k++) head.w[k] -= lr * (gW[k] + a * (head.w[k] - H0.w[k]))
      for (let o = 0; o < head.out; o++) head.bias[o] -= lr * (gB[o] + a * (head.bias[o] - H0.bias[o]))
    }
    st.head = head
    this.personal = { n, classes: [...new Set(Y)].map((c) => this.classes[c]).sort() }
    return this.personal
  }
  /** Let go of the models and kernels; recognize() and personalize() return null afterwards, embedding() throws. */
  destroy() { this.destroyed = true; this.stages = []; this.personal = null; this._plane = null; this._planeFor = null }
  depersonalize() { const st = this.stages[this.stages.length - 1]; if (st && st.head0) st.head = st.head0; this.personal = null }
}

// the script-tag build's global; the ES-module builds define __MILLIREC_ESM__ and set none
if (typeof window !== 'undefined' && typeof __MILLIREC_ESM__ === 'undefined') window.MillirecCharCnn = MillirecCharCnnCore
