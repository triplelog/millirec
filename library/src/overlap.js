// MillirecOverlap — the one-box handwriting INPUT widget.
//
// A single box the writer keeps writing capital letters into, each letter on
// top of the last. The widget works out which strokes belong to which letter,
// greys a letter out when it looks complete, erases it when it is sure the
// next letter has begun, and after EVERY stroke reports the words the ink
// could be and draws the handwritten word so far (the newest stroke included).
// Tapping a candidate re-splits the strokes to spell that word and accepts it.
//
// Full documentation: docs/overlap.md (repo) / README.md next to this file in
// the self-hosted download. The short version:
//
//   <script async src="https://YOUR-MILLIREC/embed/millirec-overlap.js"></script>
//   <div data-millirec-overlap data-list="ol_xxxxxxxx" data-target="#answer"></div>
//
//   const w = await MillirecOverlap.create(el, { words: [...], onWord: (e) => … })
//   w.getText()  w.setWords([...])  w.finishWord()  w.selectWord('WORK')  w.undo()  w.clear()
//   el.addEventListener('millirec-overlap:word', (e) => e.detail.word)
//
// The recognizer itself is core/overlap/overlap.js — this file is the DOM: a
// shadow-DOM component, the asset/word-list loading, events and the API. The
// matcher (lite wasm, ~29 KB) and the letter templates (training.json) load
// once per page and are shared by every widget on it; each widget has its
// own word list.

import ShapeID from 'millirec-glue'
import { createMatcher, buildLexicon, splitWords, alphabetOf, setNameOf, OverlapRecognizer, DEFAULTS, LETTERS, SETS, SET_NAMES } from '../../core/overlap/overlap.js'

export const VERSION = '1.0.0'

// Replaced by the millirec server when served from /embed/; left alone in the
// self-hosted build, which then finds its assets next to the script.
const BASE = '__MILLIREC_BASE_URL__'
const HOSTED = !BASE.startsWith('__')
const SCRIPT_DIR = (() => {
  const s = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || ''
  return s ? s.slice(0, s.lastIndexOf('/') + 1) : ''
})()
const G = typeof window !== 'undefined' ? window : globalThis
const globalConf = () => G.MILLIREC_OVERLAP || {}
const assetBaseOf = (opts) => opts.assetBase || globalConf().assetBase || (HOSTED ? BASE + '/overlap/' : SCRIPT_DIR)
const apiBaseOf = (opts) => (opts.apiBase || globalConf().apiBase || (HOSTED ? BASE : '')).replace(/\/$/, '')

// ------------------------------------------------------------ shared boot --

const sharedByKey = new Map()
/**
 * The matcher + templates for one alphabet, loaded once per (asset base,
 * alphabet) and shared by every widget using it. A named set loads its own
 * file (training.<set>.json — only the classes it uses); any other alphabet
 * loads the 75-class superset (training.json) and uploads just its classes.
 */
function loadShared(assetBase, alphabet) {
  const A = alphabetOf(alphabet)
  const name = setNameOf(A)
  const file = `training.${name || 'all'}.json`   // training.json is the same file as training.all.json; only the named files ship in the npm package
  const key = assetBase + '|' + A.join('')
  if (!sharedByKey.has(key)) {
    sharedByKey.set(key, (async () => {
      const r = await fetch(assetBase + file)
      if (!r.ok) throw new Error(`MillirecOverlap: could not load ${assetBase}${file} (${r.status})`)
      const training = await r.json()
      const matcher = await createMatcher(ShapeID, training, { locateFile: (f) => assetBase + f, alphabet: A })
      return { training, matcher, alphabet: A }
    })().catch((e) => { sharedByKey.delete(key); throw e }))
  }
  return sharedByKey.get(key)
}

/** Resolve the word list an instance should use, in this order of precedence. */
async function resolveWords(opts) {
  if (Array.isArray(opts.words)) return { words: opts.words, source: 'words' }
  if (typeof opts.words === 'string' && opts.words.trim()) return { words: splitWords(opts.words), source: 'words' }
  if (opts.list) {
    const api = apiBaseOf(opts)
    if (!api) throw new Error('MillirecOverlap: a hosted list (data-list) needs apiBase — the millirec server this list lives on')
    const r = await fetch(`${api}/api/overlap/lists/${encodeURIComponent(opts.list)}`)
    if (!r.ok) throw new Error(`MillirecOverlap: word list ${opts.list} not found (${r.status})`)
    const j = await r.json()
    return { words: j.words, source: 'list', list: opts.list, name: j.name }
  }
  if (opts.wordsSrc) {
    const r = await fetch(opts.wordsSrc)
    if (!r.ok) throw new Error(`MillirecOverlap: could not load ${opts.wordsSrc} (${r.status})`)
    const t = await r.text()
    let words
    try { const j = JSON.parse(t); words = Array.isArray(j) ? j : j.words } catch { words = splitWords(t) }
    return { words, source: 'src' }
  }
  if (Array.isArray(globalConf().words)) return { words: globalConf().words, source: 'global' }
  if (Array.isArray(G.MILLIREC_WORDS)) return { words: G.MILLIREC_WORDS, source: 'global' }
  const r = await fetch(assetBaseOf(opts) + 'words.json')
  if (!r.ok) throw new Error('MillirecOverlap: no word list given and the default words.json is missing')
  return { words: await r.json(), source: 'default' }
}

// ------------------------------------------------------------------ style --

const CSS = `
:host { display: inline-block; box-sizing: border-box; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--mo-ink, #111827);
  --_ink: var(--mo-ink, #111827); --_bg: var(--mo-bg, #ffffff); --_line: var(--mo-line, #d4d4d8); --_muted: var(--mo-muted, #9ca3af);
  --_accent: var(--mo-accent, #2563eb); --_grey: var(--mo-suspect, #b6b6bb); --_chip: var(--mo-chip, #f3f4f6); --_radius: var(--mo-radius, 10px); }
:host([data-theme="dark"]) { --_ink: var(--mo-ink, #f5f5f4); --_bg: var(--mo-bg, #1c1c1b); --_line: var(--mo-line, #3f3f46); --_muted: var(--mo-muted, #8a8a93);
  --_accent: var(--mo-accent, #60a5fa); --_grey: var(--mo-suspect, #55555c); --_chip: var(--mo-chip, #2a2a2e); }
@media (prefers-color-scheme: dark) { :host([data-theme="auto"]) { --_ink: var(--mo-ink, #f5f5f4); --_bg: var(--mo-bg, #1c1c1b); --_line: var(--mo-line, #3f3f46); --_muted: var(--mo-muted, #8a8a93);
  --_accent: var(--mo-accent, #60a5fa); --_grey: var(--mo-suspect, #55555c); --_chip: var(--mo-chip, #2a2a2e); } }
* { box-sizing: border-box; }
.mo { display: flex; flex-direction: column; gap: 8px; color: var(--_ink); }
.mo.row { flex-direction: row; align-items: flex-start; flex-wrap: wrap; }
.mo.row .side { flex: 1 1 200px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.box { display: block; border: 1.5px dashed var(--_line); border-radius: var(--_radius); background: var(--_bg); touch-action: none; cursor: crosshair; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
.box.busy { opacity: .5; cursor: progress; }
.text { min-height: 1.5em; font-size: 20px; font-weight: 600; letter-spacing: .04em; word-break: break-word; }
.text .done { color: var(--_ink); }
.text .cur { color: var(--_accent); }
.text .pend { color: var(--_muted); }
.text .ph { color: var(--_muted); font-weight: 400; font-size: 14px; letter-spacing: 0; }
.hw { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; min-height: 34px; }
.hw canvas { display: block; }
.hw .prev { opacity: .55; }
.words { display: flex; flex-wrap: wrap; gap: 6px; min-height: 1.6em; }
.chip { border: 1px solid var(--_line); background: var(--_chip); color: var(--_ink); border-radius: 999px; padding: 3px 10px; font: inherit; font-size: 13px; font-weight: 600; letter-spacing: .04em; cursor: pointer; }
.chip.best { border-color: var(--_accent); color: var(--_accent); }
.chip.complete::after { content: " ✓"; font-weight: 400; color: var(--_muted); }
.chip.oov { font-style: italic; color: var(--_muted); }
.chip:hover { border-color: var(--_ink); }
.bar { display: flex; gap: 6px; flex-wrap: wrap; }
.bar button { border: 1px solid var(--_line); background: var(--_bg); color: var(--_ink); border-radius: 6px; padding: 4px 10px; font: inherit; font-size: 13px; cursor: pointer; }
.bar button.primary { background: var(--_ink); color: var(--_bg); border-color: var(--_ink); }
.bar button:disabled { opacity: .4; cursor: default; }
.err { color: #dc2626; font-size: 12px; }
[hidden] { display: none !important; }
`

// ----------------------------------------------------------------- widget --

const EVENTS = ['ready', 'stroke', 'change', 'word', 'select', 'error']

export class OverlapWidget {
  /**
   * Mount a widget in `host` (an element or a selector). Options — every one
   * also settable as a `data-*` attribute on the host (`data-list`,
   * `data-idle-finish`, …):
   *   set          'capitals' (default) | 'lowercase' | 'digits' | 'punctuation' | 'all'
   *                                         which characters the box reads; or
   *   alphabet     'ABC…' | 'capitals,digits'  an explicit alphabet (loads the superset, uses these)
   *   words        array | string           the word list (see docs: precedence); folded onto the
   *                                         alphabet — a digits or punctuation box with no usable
   *                                         words runs FREE (every character priced alike)
   *   list         'ol_…'                   a list hosted on the millirec server
   *   wordsSrc     URL                      a text/JSON file of words
   *   target       selector | element       receives the text (input/textarea value, else textContent)
   *   targetMode   'live' | 'words'         live = include the word being written (default live)
   *   size         240                      the box, in CSS px
   *   layout       'column' | 'row'         panel under (default) or beside the box
   *   chips        6                        candidate words shown
   *   history      1                        previous words' handwriting kept beside the current
   *   idleFinish   0                        seconds of pen-up after which the word finishes itself (0 = never)
   *   theme        'auto' | 'light' | 'dark'
   *   hide         'text,handwriting,words,buttons' any of these parts
   *   placeholder  text shown before anything is written
   *   engine       {commitMargin, lmW, …}   recognizer knobs (core/overlap/overlap.js DEFAULTS)
   *   assetBase    where millirec.wasm / training.json / words.json are
   *   apiBase      the millirec server (for `list`)
   *   onReady/onStroke/onChange/onWord/onSelect/onError   callbacks (same detail as the events)
   */
  constructor(host, opts = {}) {
    const el = typeof host === 'string' ? document.querySelector(host) : host
    if (!el) throw new Error('MillirecOverlap: host element not found')
    this.el = el
    this.opts = { ...attrOptions(el), ...opts }
    this.listeners = new Map()
    for (const ev of EVENTS) { const fn = this.opts['on' + ev[0].toUpperCase() + ev.slice(1)]; if (typeof fn === 'function') this.on(ev, fn) }
    this.rec = null
    this.state = null
    this.words = []
    this.wordSource = null
    this.fading = []
    this.cur = null
    this.activeId = null
    this.idleTimer = 0
    this.raf = 0
    this.destroyed = false
    this._build()
    el.__millirecOverlap = this
    this.ready = this._boot()
  }

  static create(host, opts = {}) {
    const w = new OverlapWidget(host, opts)
    return w.ready.then(() => w)
  }

  // ------------------------------------------------------------- events --

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event).add(fn)
    return () => this.listeners.get(event).delete(fn)
  }

  _emit(event, detail) {
    detail = { ...detail, widget: this }
    for (const fn of this.listeners.get(event) || []) { try { fn(detail) } catch (e) { console.error(e) } }
    this.el.dispatchEvent(new CustomEvent('millirec-overlap:' + event, { detail, bubbles: true }))
  }

  // -------------------------------------------------------------- build --

  _build() {
    const o = this.opts
    const size = Number(o.size) || 240
    this.size = size
    const root = this.el.attachShadow ? (this.el.shadowRoot || this.el.attachShadow({ mode: 'open' })) : this.el
    this.root = root
    this.el.setAttribute('data-theme', o.theme || 'auto')
    root.innerHTML = ''
    const style = document.createElement('style'); style.textContent = CSS; root.appendChild(style)
    const wrap = document.createElement('div'); wrap.className = 'mo' + (o.layout === 'row' ? ' row' : ''); wrap.setAttribute('part', 'root')
    const hide = new Set(splitWords(o.hide || ''))
    this.box = document.createElement('canvas'); this.box.className = 'box busy'; this.box.setAttribute('part', 'box')
    const dpr = window.devicePixelRatio || 1
    this.dpr = dpr
    this.box.width = size * dpr; this.box.height = size * dpr
    this.box.style.width = this.box.style.height = size + 'px'
    this.ctx = this.box.getContext('2d'); this.ctx.scale(dpr, dpr)
    wrap.appendChild(this.box)
    const side = document.createElement('div'); side.className = 'side'
    this.textEl = document.createElement('div'); this.textEl.className = 'text'; this.textEl.setAttribute('part', 'text'); this.textEl.hidden = hide.has('text')
    this.hwEl = document.createElement('div'); this.hwEl.className = 'hw'; this.hwEl.setAttribute('part', 'handwriting'); this.hwEl.hidden = hide.has('handwriting')
    this.wordsEl = document.createElement('div'); this.wordsEl.className = 'words'; this.wordsEl.setAttribute('part', 'words'); this.wordsEl.hidden = hide.has('words')
    this.barEl = document.createElement('div'); this.barEl.className = 'bar'; this.barEl.setAttribute('part', 'buttons'); this.barEl.hidden = hide.has('buttons')
    this.barEl.innerHTML = '<button class="primary" data-act="done" title="finish this word">done</button><button data-act="undo" title="undo the last stroke">undo</button><button data-act="clear" title="clear the box">clear</button>'
    this.errEl = document.createElement('div'); this.errEl.className = 'err'; this.errEl.hidden = true
    for (const e of [this.textEl, this.hwEl, this.wordsEl, this.barEl, this.errEl]) side.appendChild(e)
    wrap.appendChild(side)
    root.appendChild(wrap)
    this.wrap = wrap
    this._bindPointer()
    this.barEl.addEventListener('click', (e) => {
      const act = e.target && e.target.dataset && e.target.dataset.act
      if (act === 'done') this.finishWord()
      else if (act === 'undo') this.undo()
      else if (act === 'clear') this.clearWord()
    })
    this.wordsEl.addEventListener('click', (e) => {
      const chip = e.target.closest ? e.target.closest('.chip') : null
      if (chip && chip.dataset.word) this.selectWord(chip.dataset.word)
    })
    this._renderText()
  }

  /** Recognizer options: the caller's, plus the size channel's starting scale (a capital ≈ 0.55 of the box). */
  _engineOpts() { return { sizeRef0: this.size * 0.55, ...(this.opts.engine || {}) } }

  /** The alphabet this widget reads: `alphabet` if given, else the named `set` (capitals by default). */
  get alphabet() { return alphabetOf(this.opts.alphabet || this.opts.set || 'capitals') }

  async _boot() {
    try {
      const assetBase = assetBaseOf(this.opts)
      const A = this.alphabet
      const [{ matcher }, wl] = await Promise.all([loadShared(assetBase, A), resolveWords(this.opts)])
      if (this.destroyed) return
      this.words = wl.words
      this.wordSource = wl
      this.lexicon = buildLexicon(this.words, { alphabet: A })
      this.rec = new OverlapRecognizer({ matcher, lexicon: this.lexicon, opts: this._engineOpts() })
      this.state = this.rec.last
      this.box.classList.remove('busy')
      this._render()
      this._emit('ready', { words: this.lexicon.size, source: wl.source, list: wl.list || null, alphabet: A.join(''), set: setNameOf(A), free: this.lexicon.size === 0 })
    } catch (e) {
      this.errEl.textContent = String(e.message || e)
      this.errEl.hidden = false
      this._emit('error', { error: e })
      throw e
    }
  }

  // ------------------------------------------------------------ pointer --

  _bindPointer() {
    const box = this.box, S = this.size
    const pos = (e) => { const r = box.getBoundingClientRect(); return { x: (e.clientX - r.left) * S / r.width, y: (e.clientY - r.top) * S / r.height } }
    box.addEventListener('pointerdown', (e) => {
      if (e.button > 0 || !this.rec) return
      if (this.activeId !== null && e.pointerType !== 'pen' && this.activeId !== e.pointerId) return   // a palm beside the pen
      e.preventDefault()
      this.activeId = e.pointerId
      try { box.setPointerCapture(e.pointerId) } catch { /* synthetic pointer */ }
      clearTimeout(this.idleTimer)
      this.cur = [pos(e)]; this.curT0 = performance.now()
      this._repaint()
    }, { passive: false })
    box.addEventListener('pointermove', (e) => {
      if (this.activeId !== e.pointerId || !this.cur) return
      e.preventDefault()
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null
      for (const ev of (evs && evs.length ? evs : [e])) this.cur.push(pos(ev))
      this._repaint()
    }, { passive: false })
    const end = (e) => {
      if (this.activeId !== e.pointerId) return
      try { box.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
      this.activeId = null
      if (!this.cur) return
      let st = this.cur; this.cur = null
      if (st.length === 1) { const p = st[0]; st = [{ x: p.x - 1, y: p.y }, { x: p.x + 1, y: p.y }] }
      this._apply(this.rec.addStroke(st, { t0: this.curT0, t1: performance.now() }), 'stroke')
      this._armIdle()
    }
    box.addEventListener('pointerup', end)
    box.addEventListener('pointercancel', end)
    for (const ev of ['touchstart', 'touchmove']) box.addEventListener(ev, (e) => e.preventDefault(), { passive: false })
    box.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  _armIdle() {
    clearTimeout(this.idleTimer)
    const s = Number(this.opts.idleFinish) || 0
    if (!s || !this.rec || !this.rec.strokes.length) return
    this.idleTimer = setTimeout(() => { if (this.rec && this.rec.strokes.length) this.finishWord() }, s * 1000)
  }

  // ---------------------------------------------------------------- API --

  /** The finished words, joined by spaces. */
  getText() { return this.rec ? this.rec.words.map((w) => w.word).join(' ') : '' }
  /** The finished words plus the word being written (its best reading so far). */
  getLiveText() {
    const t = this.getText(), cur = this.state ? this.state.text : ''
    return cur ? (t ? t + ' ' + cur : cur) : t
  }
  /** Finished word records: {word, letters: [{ch, strokes}], inList, selected, alternatives}. */
  getWords() { return this.rec ? this.rec.words.map(wordRecord) : [] }
  /** The words the current ink could be, best first: [{word, score, complete, inList}]. */
  getCandidates() { return this.state ? this.state.candidates.map(cand) : [] }
  /** The recognizer's full state (see core/overlap/overlap.js _state). */
  getState() { return this.state }
  /** The word list in use. */
  getWordList() { return this.words.slice() }

  /**
   * A canvas of the handwriting: the current word (default), every finished
   * word plus the current one ('all'), or one finished word by index.
   */
  getHandwriting({ scope = 'word', index = -1, capHeight = 44 } = {}) {
    if (!this.rec) return null
    if (scope === 'word' && index < 0) return wordStrip(this._currentGroups(), capHeight, this._colors())
    if (scope === 'word') { const w = this.rec.words[index]; return w ? wordStrip(w.groups, capHeight, this._colors()) : null }
    const all = this.rec.words.map((w) => w.groups)
    const cur = this._currentGroups()
    if (cur.length) all.push(cur)
    return sentenceStrip(all, capHeight, this._colors())
  }

  /** Replace the word list (array or whitespace/comma-separated string). Returns the usable words (after folding onto the alphabet); 0 = free mode. */
  setWords(words) {
    this.words = Array.isArray(words) ? words.slice() : splitWords(words)
    this.wordSource = { source: 'words' }
    this.lexicon = buildLexicon(this.words, { alphabet: this.alphabet })
    if (this.rec) this._apply(this.rec.setLexicon(this.lexicon), 'change')
    return this.lexicon.size
  }
  /** Load a list hosted on the millirec server by id. */
  async loadList(id) {
    const wl = await resolveWords({ ...this.opts, list: id, words: undefined })
    this.words = wl.words; this.wordSource = wl
    this.lexicon = buildLexicon(this.words, { alphabet: this.alphabet })
    if (this.rec) this._apply(this.rec.setLexicon(this.lexicon), 'change')
    return this.lexicon.size
  }
  /** Usable words in the current list (0 = free mode). */
  getLexiconSize() { return this.lexicon ? this.lexicon.size : 0 }
  /** Switch the character set ('capitals', 'lowercase', …) or an explicit alphabet; reloads the templates. Resolves when ready. */
  async setAlphabet(spec) {
    if (spec && SETS[spec]) { this.opts.set = spec; delete this.opts.alphabet } else { this.opts.alphabet = spec; delete this.opts.set }
    const A = this.alphabet
    const { matcher } = await loadShared(assetBaseOf(this.opts), A)
    if (this.destroyed) return
    this.lexicon = buildLexicon(this.words, { alphabet: A })
    this.rec = new OverlapRecognizer({ matcher, lexicon: this.lexicon, opts: this._engineOpts() })
    this.fading = []
    this.state = this.rec.last
    this._render()
    this._emit('change', this._detail(this.state))
    this._pushTarget()
    return A.join('')
  }
  /** Finish the word being written (best reading), or force it to `word`. */
  finishWord(word = null) { if (this.rec) this._apply(this.rec.finishWord({ word }), 'word') }
  /** Accept a candidate: the strokes are re-split to spell it. `finish: false` adopts it as a prefix and keeps writing. */
  selectWord(word, { finish = true } = {}) {
    if (!this.rec) return
    const st = this.rec.selectWord(word, { finish })
    this._emit('select', { word: String(word).toUpperCase(), finish })
    this._apply(st, finish ? 'word' : 'change')
  }
  undo() { if (this.rec) this._apply(this.rec.undo(), 'change') }
  /** Drop the ink of the current word; finished words stay. */
  clearWord() { if (this.rec) { this.fading = []; this._apply(this.rec.clearWord(), 'change') } }
  /** Forget everything, finished words included. */
  clear() { if (this.rec) { this.fading = []; this._apply(this.rec.reset(), 'change') } }
  /** Recognizer knobs (commitMargin, lmW, idle…) — see DEFAULTS. */
  setOptions(engineOpts) { if (this.rec) this._apply(this.rec.setOpts(engineOpts), 'change') }
  destroy() {
    this.destroyed = true
    clearTimeout(this.idleTimer)
    cancelAnimationFrame(this.raf)
    this.root.innerHTML = ''
    delete this.el.__millirecOverlap
  }

  // ------------------------------------------------------------- render --

  _apply(state, kind) {
    this.state = state
    if (state.commit && state.commit.erased && state.commit.erased.length) {
      this.fading.push({ strokes: state.commit.erased, t0: performance.now() })
    }
    this._render()
    const detail = this._detail(state)
    if (kind === 'stroke') this._emit('stroke', detail)
    if (state.finished) this._emit('word', { ...detail, ...wordRecord(state.finished), canvas: wordStrip(state.finished.groups, 44, this._colors()) })
    this._emit('change', detail)
    this._pushTarget()
  }

  _detail(state) {
    return {
      text: this.getText(), live: this.getLiveText(), current: state.text, committed: state.committed, pending: state.pending,
      candidates: state.candidates.map(cand), strokes: state.n, erased: state.commit ? state.commit.erased.length : 0,
      canvas: this.hwCanvas || null,
    }
  }

  _pushTarget() {
    const t = this.opts.target
    if (!t) return
    const el = typeof t === 'string' ? document.querySelector(t) : t
    if (!el) return
    const text = this.opts.targetMode === 'words' ? this.getText() : this.getLiveText()
    if ('value' in el && /^(INPUT|TEXTAREA)$/.test(el.tagName)) { el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })) }
    else el.textContent = text
  }

  _colors() {
    const cs = getComputedStyle(this.el)
    const v = (n, d) => (cs.getPropertyValue(n) || '').trim() || d
    // the theme-resolved values live on :host as --_ink etc.; read them through the wrap
    const ws = this.wrap ? getComputedStyle(this.wrap) : cs
    const w = (n, d) => (ws.getPropertyValue(n) || '').trim() || d
    return { ink: w('--_ink', v('--mo-ink', '#111827')), grey: w('--_grey', '#b6b6bb'), accent: w('--_accent', '#2563eb'), muted: w('--_muted', '#9ca3af') }
  }

  _currentGroups() {
    const st = this.state
    if (!st) return []
    return (st.groups || []).map((g) => ({ ch: g.ch, strokes: g.strokes, state: 'done' }))
      .concat((st.assignment || []).map((g) => ({ ch: g.ch, strokes: g.strokes, state: g.open ? 'open' : 'closed' })))
  }

  _render() {
    this._repaint()
    this._renderText()
    this._renderHandwriting()
    this._renderWords()
  }

  _renderText() {
    const st = this.state
    const done = this.getText()
    if (!st || (!done && !st.text)) {
      const what = { capitals: 'a capital letter', lowercase: 'a lowercase letter', digits: 'a digit', punctuation: 'a punctuation mark', all: 'a character' }[setNameOf(this.alphabet)] || 'a character'
      this.textEl.innerHTML = `<span class="ph">${esc(this.opts.placeholder || `write ${what}, then the next one over it`)}</span>`
      return
    }
    this.textEl.innerHTML = (done ? `<span class="done">${esc(done)}</span> ` : '') + `<span class="cur">${esc(st.committed)}</span><span class="pend">${esc(st.pending)}</span>`
  }

  _renderHandwriting() {
    const el = this.hwEl
    el.innerHTML = ''
    if (!this.rec) return
    const colors = this._colors()
    const hist = Math.max(0, Number(this.opts.history ?? 1))
    const prev = this.rec.words.slice(-hist)
    for (const w of prev) { const c = wordStrip(w.groups, 34, colors); c.className = 'prev'; c.title = w.word; el.appendChild(c) }
    const cur = this._currentGroups()
    this.hwCanvas = cur.length ? wordStrip(cur, 44, colors) : null
    if (this.hwCanvas) el.appendChild(this.hwCanvas)
  }

  _renderWords() {
    const el = this.wordsEl
    el.innerHTML = ''
    if (!this.state) return
    const n = Math.max(0, Number(this.opts.chips ?? 6))
    this.state.candidates.slice(0, n).forEach((c, i) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'chip' + (i === 0 ? ' best' : '') + (c.kind === 'done' ? ' complete' : '') + (c.kind === 'oov' ? ' oov' : '') + (c.kind === 'free' ? ' free' : '')
      b.dataset.word = c.word
      b.textContent = c.word
      b.title = c.kind === 'done' ? 'a complete word — tap to accept it' : c.kind === 'oov' ? 'not in the word list' : c.kind === 'free' ? 'the reading so far — tap to accept it' : 'tap to accept this word'
      b.setAttribute('part', 'chip')
      el.appendChild(b)
    })
  }

  _repaint() {
    const ctx = this.ctx, S = this.size
    ctx.clearRect(0, 0, S, S)
    const colors = this._colors()
    const now = performance.now()
    this.fading = this.fading.filter((f) => now - f.t0 < 500)
    for (const f of this.fading) {
      const a = 1 - (now - f.t0) / 500
      for (const s of f.strokes) paintStroke(ctx, s.pts, colors.grey, 3, 0.9 * a)
    }
    // suspected-complete letters in grey, the letter being written in ink
    const grey = new Set()
    for (const g of (this.state && this.state.assignment) || []) if (!g.open) for (const id of g.ids) grey.add(id)
    for (const s of (this.rec ? this.rec.strokes : [])) paintStroke(ctx, s.pts, grey.has(s.id) ? colors.grey : colors.ink, 3, 1)
    if (this.cur) paintStroke(ctx, this.cur, colors.ink, 3, 1)
    cancelAnimationFrame(this.raf)
    if (this.fading.length) this.raf = requestAnimationFrame(() => this._repaint())
  }
}

// ---------------------------------------------------------------- helpers --

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const cand = (c) => ({ word: c.word, score: c.score, complete: c.kind === 'done', inList: c.kind !== 'oov' })
const wordRecord = (w) => ({ word: w.word, letters: w.groups.map((g) => ({ ch: g.ch, strokes: g.strokes })), inList: !!w.inList, selected: !!w.selected, alternatives: (w.alternatives || []).map((a) => ({ word: a.text, score: a.score, inList: a.inList })) })

/** data-* attributes → options (data-idle-finish → idleFinish, data-engine JSON). */
function attrOptions(el) {
  const o = {}
  const map = { 'millirec-overlap': null, set: 'set', alphabet: 'alphabet', list: 'list', words: 'words', 'words-src': 'wordsSrc', target: 'target', 'target-mode': 'targetMode', size: 'size', layout: 'layout', chips: 'chips', history: 'history', 'idle-finish': 'idleFinish', theme: 'theme', hide: 'hide', placeholder: 'placeholder', 'asset-base': 'assetBase', 'api-base': 'apiBase' }
  for (const [attr, key] of Object.entries(map)) {
    const v = el.getAttribute('data-' + attr)
    if (v == null || !key) continue
    o[key] = v
  }
  const eng = el.getAttribute('data-engine')
  if (eng) { try { o.engine = JSON.parse(eng) } catch { console.warn('MillirecOverlap: data-engine is not JSON') } }
  // `data-millirec-overlap="ol_…"` is shorthand for data-list
  const short = el.getAttribute('data-millirec-overlap')
  if (short && !o.list && !o.words) o.list = short
  return o
}

function paintStroke(ctx, pts, color, width, alpha) {
  if (!pts || pts.length < 2) return
  ctx.globalAlpha = alpha
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
  ctx.stroke()
  ctx.globalAlpha = 1
}

function bbox(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const st of strokes) for (const p of st) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y }
  return x0 === Infinity ? null : { x0, y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
}

/**
 * The letters of one word side by side at a common scale (the median letter
 * height sets it, so relative sizes survive), bottoms aligned on an implicit
 * baseline. Letters with no ink (accepted beyond the writing) take a small
 * empty slot. Returns a canvas.
 */
export function wordStrip(groups, capH = 44, colors = {}, { gap = 8, pad = 6, dpr = (window.devicePixelRatio || 1) } = {}) {
  const ink = colors.ink || '#111827'
  const boxes = groups.map((g) => bbox(g.strokes || []))
  const hs = boxes.filter(Boolean).map((b) => b.h).sort((a, b) => a - b)
  const ref = hs.length ? hs[Math.floor(hs.length / 2)] : 1
  const s = capH / ref
  const widths = boxes.map((b) => (b ? b.w * s : capH * 0.35))
  const totalW = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, groups.length - 1) + 2 * pad
  const maxH = Math.max(capH, ...boxes.filter(Boolean).map((b) => b.h * s)) + 2 * pad
  const c = document.createElement('canvas')
  c.width = Math.ceil(totalW * dpr); c.height = Math.ceil(maxH * dpr)
  c.style.width = Math.ceil(totalW) + 'px'; c.style.height = Math.ceil(maxH) + 'px'
  const g = c.getContext('2d'); g.scale(dpr, dpr)
  g.lineWidth = Math.max(1.6, capH / 18); g.lineCap = g.lineJoin = 'round'
  let x = pad
  groups.forEach((gr, i) => {
    const b = boxes[i]
    if (b) {
      const oy = maxH - pad - b.h * s
      g.strokeStyle = gr.state === 'open' ? (colors.openInk || ink) : ink
      for (const st of gr.strokes) {
        g.beginPath()
        st.forEach((p, k) => { const px = x + (p.x - b.x0) * s, py = oy + (p.y - b.y0) * s; k ? g.lineTo(px, py) : g.moveTo(px, py) })
        g.stroke()
      }
    }
    x += widths[i] + gap
  })
  return c
}

/** Several words' strips on one canvas, a word space between them. */
export function sentenceStrip(wordsGroups, capH = 44, colors = {}) {
  const strips = wordsGroups.map((gs) => wordStrip(gs, capH, colors))
  const dpr = window.devicePixelRatio || 1
  const space = capH * 0.6
  const totalW = strips.reduce((a, c) => a + c.width / dpr, 0) + space * Math.max(0, strips.length - 1)
  const maxH = Math.max(1, ...strips.map((c) => c.height / dpr))
  const out = document.createElement('canvas')
  out.width = Math.ceil(totalW * dpr); out.height = Math.ceil(maxH * dpr)
  out.style.width = Math.ceil(totalW) + 'px'; out.style.height = Math.ceil(maxH) + 'px'
  const g = out.getContext('2d')
  let x = 0
  for (const c of strips) { g.drawImage(c, x * dpr, (maxH * dpr - c.height)); x += c.width / dpr + space }
  return out
}

// ---------------------------------------------------------------- global --

function scan(root = document) {
  const els = root.querySelectorAll ? root.querySelectorAll('[data-millirec-overlap]') : []
  const made = []
  for (const el of els) if (!el.__millirecOverlap) made.push(new OverlapWidget(el))
  return made
}

const api = {
  version: VERSION,
  create: (host, opts) => OverlapWidget.create(host, opts),
  scan,
  Widget: OverlapWidget,
  buildLexicon, splitWords, wordStrip, sentenceStrip, alphabetOf, setNameOf,
  DEFAULTS, LETTERS, SETS, SET_NAMES,
  /** Prewarm the matcher + templates for a set (optional; create() does it on demand). */
  preload: (set = 'capitals', assetBase) => loadShared(assetBase || assetBaseOf({}), set),
}

if (typeof window !== 'undefined') {
  if (!window.MillirecOverlap) {
    window.MillirecOverlap = api
    const go = () => { try { scan(document) } catch (e) { console.error(e) } }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go)
    else go()
  }
}

export default api
