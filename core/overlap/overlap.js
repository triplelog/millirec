// The OVERLAP recognizer: characters written one on top of another in a
// single box. The writer draws the first character, then draws the next one
// straight over it, and so on; the recognizer works out which strokes belong
// to which character — knowing only that strokes arrive in writing order, so
// a character is always a contiguous run of strokes — erases the strokes of a
// character as soon as it is sure a new one has begun, and appends that
// character to the text stream.
//
// DOM-free and environment-free: the embeddable widget (library/src/overlap.js),
// the lab page (/overlaplab.html, importing /core/overlap/overlap.js) and the
// node gate (scripts/verify-overlap.mjs) all drive exactly this module. The
// wasm matcher is handed in as a module factory (createMatcher), so the same
// file runs under the browser glue and under the node build.
//
// THE ALPHABET IS A PARAMETER. `SETS` names the drill-backed sets (capitals,
// lowercase, digits, punctuation, all = 75 classes); `alphabetOf` turns a set
// name, a comma-joined list of set names or an explicit string of characters
// into the ordered alphabet the lexicon and the DP index by. The templates
// (training.json) hold every class; `createMatcher` uploads only the alphabet's.
//
// HOW IT DECIDES. The uncommitted strokes s_1..s_n are segmented by a DP over
// stroke positions: a group of consecutive strokes is scored against a
// character by the wasm matcher (FULL templates, and for the LAST group also
// the PARTIAL templates — the first k strokes of a character drawn with more,
// so an unfinished E is a hypothesis of its own instead of a bad I plus a
// bar), and each character is priced by the lexicon trie, P(char | prefix so
// far) from the word list's frequency mass. A hypothesis is a path of groups
// ending in an OPEN group at s_n; the prefix before the open group is what
// could be committed. Strokes s_1..s_b are erased when the best hypothesis
// beats the best hypothesis that has NO boundary at b by `commitMargin` —
// that is the "sure a new character is being drawn" test, and it is exact:
// the rival is a second DP run with the boundary forbidden, not a beam-pruned
// survivor.
//
// WHAT SURVIVES A COMMIT is a BEAM of prefixes, not one string: two readings
// of the erased strokes that agree on the boundary but not on the letters
// (O vs Q) both stay, each at its trie node, and the letters that follow —
// through the lexicon — settle them. The text stream shows the best entry.
//
// SCORING IS LAZY AND PRUNED BY THE LEXICON. A group is scored against a
// class only when the DP asks for it, and the DP asks first for the classes
// the word list allows next from the states at the group's start; only when
// none of those fits at all (`oovTrigger`) is the whole alphabet scored, to
// let an off-list character in. With 26 classes this changes little; with 75
// it is what keeps a stroke under ~50 ms. With NO word list (free mode: an
// empty lexicon, the natural state of a digits or punctuation set) every
// class is scored and characters are priced uniformly.
//
// Shape scores are log-odds against "not a character": (ln costRef − ln cost)
// / temp — on the LOG of the matcher cost, because a true letter costs ~0.1
// and a wrong one ~1.1 (verify-overlap --stats), a ratio rather than a gap —
// so a good match adds a positive number and a junk group (two characters'
// strokes merged) a negative one. A group's score is that log-odds TIMES THE
// STROKES IT EXPLAINS: every segmentation of the same ink then sums over the
// same strokes, and a reading with more characters cannot out-score one with
// fewer simply by collecting more well-matched pieces (an H's two stems read
// as "I, then the start of something" scored 8+8 against H-in-progress at 8;
// with the weighting both read 16 and the lexicon settles it). Only the
// lexicon prices the number of characters.
//
// A WORD CAN BE FORCED. `fitToWord(word)` re-segments EVERY stroke of the
// current word — the erased ones included, they are kept in `erased` — so that
// the characters spell a prefix of `word` (the last possibly unfinished);
// `selectWord(word)` is what a tap on a candidate does with it: accept the
// word whole, or adopt the prefix and keep writing.

import { resampleStrokes, orientedPointsFromPolyline } from '../pipeline/stroke.js'
import { decodeSample } from '../format/delta.js'
import { MODE_PARAMS } from '../pipeline/constants.js'

export const SETS = {
  capitals: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lowercase: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  punctuation: ',.:/\'-%$',   // the marks a word or string can CONTAIN (3.5%, $12, 12:30, 1/2, don't, e-mail, 1,000)
}
SETS.all = SETS.capitals + SETS.lowercase + SETS.digits + SETS.punctuation
export const SET_NAMES = ['capitals', 'lowercase', 'digits', 'punctuation', 'all']
/** Marks the word list lets a COMPLETE word end with, at `markP`, without listing them: "hello," "done." */
export const TERMINAL_MARKS = ',.:'
/** Apostrophe forms the default list lacks; scripts/build-overlap.mjs folds them into words.json so a
 *  comma and an apostrophe — the same size, nearly the same shape — are told apart by the list. */
export const CONTRACTIONS = ("don't can't won't isn't aren't wasn't weren't hasn't haven't hadn't doesn't didn't wouldn't couldn't shouldn't " +
  "i'm i've i'll i'd you're you've you'll you'd he's he'll he'd she's she'll she'd it's we're we've we'll we'd they're they've they'll they'd " +
  "that's there's here's what's who's where's when's how's let's o'clock ain't y'all ma'am").split(' ')
/** Kept for callers that predate the alphabet parameter: the capitals. */
export const LETTERS = SETS.capitals

/**
 * An ordered alphabet from a set name ('lowercase'), several ('capitals,digits'),
 * an explicit string of characters ('AEIOU'), or an array. Deduplicated,
 * order kept (the order is the class index the trie and the DP use).
 */
export function alphabetOf(spec = 'capitals') {
  if (Array.isArray(spec)) return [...new Set(spec.map((c) => String(c)).filter((c) => c.length === 1))]
  const s = String(spec == null ? 'capitals' : spec).trim()
  if (!s) return [...SETS.capitals]
  const parts = s.split(/[,+\s]+/).filter(Boolean)
  if (parts.every((p) => SETS[p])) return [...new Set(parts.flatMap((p) => [...SETS[p]]))]
  return [...new Set([...s.replace(/\s+/g, '')])]
}

/** The set name an alphabet is exactly, or null. */
export function setNameOf(alphabet) {
  const a = [...alphabet].join('')
  for (const n of SET_NAMES) if ([...new Set([...SETS[n]])].join('') === a) return n
  return null
}

const hasUpper = (A) => A.some((c) => c !== c.toLowerCase())
const hasLower = (A) => A.some((c) => c !== c.toUpperCase())

/**
 * A word folded onto an alphabet: uppercased when the alphabet has capitals
 * but no lowercase, lowercased in the mirror case, left alone when it has
 * both; null when a character is not in the alphabet.
 */
export function foldWord(word, alphabet, idx = null) {
  const A = alphabet
  const ix = idx || new Map(A.map((c, i) => [c, i]))
  let s = String(word == null ? '' : word).trim()
  if (!s) return null
  const up = hasUpper(A), low = hasLower(A)
  if (up && !low) s = s.toUpperCase()
  else if (low && !up) s = s.toLowerCase()
  for (const c of s) if (!ix.has(c)) return null
  return s
}

// ----------------------------------------------------------------- lexicon --

/**
 * A trie over a frequency-RANKED word list (the builder's default lists are
 * ranked, so rank is the frequency estimate: weight 1/(rank+1), Zipf).
 * Words are folded onto the alphabet (foldWord) and deduplicated; a word with
 * a character outside the alphabet is dropped. When the alphabet holds BOTH
 * cases, `variants` (default on) also adds each word's Capitalized form at a
 * third of its weight and its UPPER form at a tenth, so a mixed-case list
 * built from a lowercase source can still read "Hello".
 * Each node carries `mass` (the weight of every word at or below it, so
 * P(next char | prefix) = child.mass / node.mass and P(end | prefix) =
 * node.end / node.mass) and `top`, the best few words beneath it, for the
 * candidate list. An EMPTY list is free mode: the recognizer prices every
 * character uniformly and nothing is off-list.
 */
export function buildLexicon(words, { alphabet = 'capitals', weightOf = (rank) => 1 / (rank + 1), topK = 8, variants = 'auto' } = {}) {
  const A = alphabetOf(alphabet)
  const idx = new Map(A.map((c, i) => [c, i]))
  const NA = A.length
  let nextId = 0
  const mkNode = (depth) => ({ id: nextId++, ch: new Array(NA).fill(null), mass: 0, end: 0, depth, word: null, top: [], logMass: 0 })
  const root = mkNode(0)
  const seen = new Set()
  const list = []
  let rank = 0
  const mixed = hasUpper(A) && hasLower(A)
  const withVariants = variants === true || (variants === 'auto' && mixed)
  const insert = (w, wt) => {
    if (seen.has(w)) return
    seen.add(w)
    list.push(w)
    let node = root
    const path = [root]
    for (const c of w) {
      const L = idx.get(c)
      node = node.ch[L] || (node.ch[L] = mkNode(path.length))
      path.push(node)
    }
    node.end += wt
    node.word = w
    for (const p of path) {
      p.mass += wt
      const t = p.top
      if (t.length < topK || wt > t[t.length - 1].wt) {
        let k = t.length
        while (k > 0 && t[k - 1].wt < wt) k--
        t.splice(k, 0, { word: w, wt })
        if (t.length > topK) t.pop()
      }
    }
  }
  for (const raw of words || []) {
    const w = foldWord(raw, A, idx)
    if (!w) continue
    const wt = weightOf(rank, w)
    rank++
    insert(w, wt)
    if (withVariants && w === w.toLowerCase() && w !== w.toUpperCase()) {
      const cap = w[0].toUpperCase() + w.slice(1)
      if ([...cap].every((c) => idx.has(c))) insert(cap, wt / 3)
      const up = w.toUpperCase()
      if ([...up].every((c) => idx.has(c))) insert(up, wt / 10)
    }
  }
  const stack = [root]
  while (stack.length) {
    const n = stack.pop()
    n.logMass = n.mass > 0 ? Math.log(n.mass) : -Infinity
    for (const c of n.ch) if (c) stack.push(c)
  }
  // the node a word sits at after a terminal mark: nothing follows, the word is done
  const markNode = { id: -2, ch: new Array(NA).fill(null), mass: 1, end: 1, depth: -1, word: null, top: [], logMass: 0, mark: true }
  const lookup = (text) => {
    let node = root
    const t = String(text)
    for (let i = 0; i < t.length; i++) {
      const c = t[i]
      const L = idx.get(c)
      const next = L == null ? null : node.ch[L]
      if (!next) {
        if (i === t.length - 1 && TERMINAL_MARKS.includes(c) && node.end > 0) return markNode
        return null
      }
      node = next
    }
    return node
  }
  return { root, size: list.length, words: list, lookup, alphabet: A, idx, free: list.length === 0, markNode }
}

/** Split a pasted / attribute word list: whitespace, commas and semicolons separate words. */
export function splitWords(text) {
  return String(text || '').split(/[\s,;]+/).map((w) => w.trim()).filter(Boolean)
}

// ----------------------------------------------------------------- matcher --

/**
 * The wasm matcher with the overlap training uploaded, scored in-thread.
 * `factory` is the emscripten module factory (the glue's `ShapeID`: the ESM
 * default export in the browser, `require('shapeid_kappa.js')` in node);
 * `training` is the object scripts/build-overlap-training.mjs writes (every
 * class); `alphabet` restricts what is uploaded — a class key's first
 * character is its class (partial classes are `${char}/${k}`). Stroke-mode
 * parameters from MODE_PARAMS unless overridden. One matcher may be shared
 * by several recognizers of the same alphabet: every query is uploaded and
 * scored in one synchronous call, so instances cannot interleave, and
 * `current` names the cloud that is uploaded now.
 */
export async function createMatcher(factory, training, { params = null, locateFile = null, alphabet = null } = {}) {
  const P = { ...MODE_PARAMS.stroke, ...(params || {}) }
  const M = await factory(locateFile ? { locateFile } : {})
  const want = alphabet ? new Set(alphabetOf(alphabet)) : null
  const keys = Object.keys(training.classes).filter((k) => !want || want.has(k[0]))
  if (!keys.length) throw new Error('createMatcher: no template class matches the alphabet')
  const idx = new Map(keys.map((k, i) => [k, i]))
  const spc = Math.max(1, ...keys.map((k) => training.classes[k].length))
  const pps = training.pointsPerShape
  M.firstCall(P.alpha, P.beta, P.maxCost, P.divi, pps, spc, keys.length)
  if (P.outlierCost) M.setOutlierCost(P.outlierCost)
  if (P.scoreMode) M.setScoreMode(P.scoreMode)
  if (P.kappaGamma && M.setKappaGamma) M.setKappaGamma(P.kappaGamma)
  if (P.gateMode != null && M.setGateMode) M.setGateMode(P.gateMode)
  if (P.gateScale != null && M.setGateScale) M.setGateScale(P.gateScale)
  let nT = 0
  // how many strokes each FULL class was drawn with, per template: the
  // stroke-count prior (strokeLogP) — the only thing that separates "5"
  // from "5 written twice on top of itself", whose ink is identical
  const counts = new Map()
  let kMax = 1
  keys.forEach((k, ci) => training.classes[k].forEach((s, sid) => {
    const { points, scale } = orientedPointsFromPolyline(decodeSample(s))
    points.forEach((p, i) => M.addPoint(ci * spc + sid, i, p.x * scale, p.y * scale, p.s, p.c))
    nT++
    if (k.length === 1 && s.strokes > 0) {
      if (!counts.has(k)) counts.set(k, { n: 0, hist: new Map() })
      const c = counts.get(k)
      c.n++
      c.hist.set(s.strokes, (c.hist.get(s.strokes) || 0) + 1)
      if (s.strokes > kMax) kMax = s.strokes
    }
  }))
  const K = kMax + 2, ALPHA_SMOOTH = 0.5
  let calls = 0
  return {
    pps, keys, spc, training, params: P, templates: nT, current: null,
    alphabet: [...new Set(keys.map((k) => k[0]))],
    has: (key) => idx.has(key),
    /** log P(drawn with k strokes | class) against a uniform count: positive for
     *  a count the class's templates show, negative for one they never do
     *  (add-½ smoothing over 1..K). 0 when the class has no count data. */
    strokeLogP(ch, k) {
      const c = counts.get(ch)
      if (!c) return 0
      const kk = Math.min(Math.max(1, k), K)
      const p = ((c.hist.get(kk) || 0) + ALPHA_SMOOTH) / (c.n + ALPHA_SMOOTH * K)
      return Math.log(p * K)
    },
    get calls() { return calls },
    /** Upload a stroke list as the test cloud; false when it has no length. `key` names it. */
    upload(strokes, key = null) {
      this.current = key
      const poly = resampleStrokes(strokes, pps)
      if (!poly) return false
      const { points, scale } = orientedPointsFromPolyline(poly)
      for (let i = 0; i < points.length; i++) {
        const p = points[i]
        M.addPoint(-1, i, p.x * scale, p.y * scale, p.s, p.c)
      }
      return true
    },
    /** Per-template assignment costs of the uploaded cloud against one class. */
    costs(key) {
      const ci = idx.get(key)
      const out = new Array(training.classes[key].length)
      for (let sid = 0; sid < out.length; sid++) { out[sid] = M.getTestScore(ci, sid, pps, P.outliersMul); calls++ }
      return out
    },
  }
}

/** Class cost from its templates' costs — production's best²·second on the
 *  cube root (so it stays on the per-template scale), or the plain minimum. */
export function combineCosts(costs, mode = 'prod') {
  let b1 = Infinity, b2 = Infinity
  for (const v of costs) { if (v < b1) { b2 = b1; b1 = v } else if (v < b2) b2 = v }
  if (mode === 'min' || b1 === Infinity) return b1
  return b2 === Infinity ? Math.cbrt(0.9) * b1 : Math.cbrt(b1 * b1 * b2)
}

export const DEFAULTS = {
  maxStrokes: 5,       // most strokes one character may take (this writer's max is 4)
  costRef: 0.5,        // matcher cost at which a group is as likely junk as a character: a true letter reads
                       // ~0.1 (p90 0.5), a wrong letter or two letters merged ~1.1 (p10 0.5) — verify-overlap --stats
  costEps: 0.02,       // floor under the cost before the log, so a perfect match is +8 nats, not +∞
  temp: 0.4,           // log-cost units per nat
  shMax: 4,            // soft cap on the positive side: a cost of 0.02 and 0.1 are both "excellent", not 4 nats apart
  lmW: 1,              // weight of the lexicon's log P(char | prefix)            (swept: 0.6 → 90.6%, 1 → 95.0%, 1.5 → 92.8%)
  commitMargin: 5,     // nats a boundary must win by before the strokes before it are erased (3 → 90.6%, 5 → 95.0%, 7 → 95.0% at longer lag)
  beamMargin: 12,      // prefixes this far under the best survive a commit        (8 → 95.0%, 12 → 96.1%: later letters repair an early misread)
  beamK: 32,           // and at most this many
  oovPen: 15,          // nats to leave the word list (then characters are uniform)
  endFloor: -10,       // log P(end) for a prefix that is not itself a word (finishWord)
  doneBoost: 1.0,      // nats in favour of an already-complete word in the candidate list
  combine: 'prod',     // FULL class cost: 'prod' = cbrt(best²·second) as production identify(); 'min' = best
  combinePart: 'min',  // PARTIAL classes hold every stroke-order variant of "first k strokes", so the best template speaks
  pruneClasses: true,  // score only the classes the word list allows next; the whole alphabet only when none of them fits
  oovTrigger: 0,       // …"fits" = best allowed per-stroke log-odds at or above this
  sizeW: 1,            // weight of the SIZE channel: log N(log size of the group | class), the writer's scale estimated
                       // from the characters already committed (sizeRef). A period is 0.11 of a capital's height in
                       // the drills, a comma 0.57 and an apostrophe 0.50 — size finds the period, not the comma
  sizeCap: 8,          // most nats the size channel may charge one group
  tinyShape: 1,        // a TINY class (a period: its drill cells are under 0.2 of a capital) has no shape worth
                       // matching — a dot's 25-point cloud is a random curl — so it scores this flat per stroke
                       // and is found by SIZE alone
  freeMarkShare: 0.15, // in free mode, the prior mass the marks share (digits get the rest): a 7 is not "- then /"
  sizeRef0: 160,       // the box-units size of a capital before anything is committed (the widget passes 0.55 × its box)
  sizeSd0: 0.35,       // extra log-size spread while only sizeRef0 is known; sizeSd once characters are committed
  sizeSd: 0.15,
  markP: 0.3,          // P(a terminal mark , . : follows a complete word) — "hello," without listing it (0.15 → 85.0%, 0.3 → 86.7% on `text`)
  tinyRatio: 0.5,      // a group holding a stroke shorter than tinyRatio × the class's smallest-ever stroke (as a
  tinyPen: 8,          // fraction of its size) pays tinyPen: a D never contains a dot, so "D + period" is not a D
                       // (off: text 82.2% / numbers 76.7%; 4: 85.0 / 82.8; 8: 87.8 / 86.7 — the letter sets move ≤ 0.6 either way)
  strokeCountW: 'auto', // weight of log P(strokes | class) from the templates: "55" is one 5's ink drawn with two
                       // strokes, and a 5 is never drawn with two — the only evidence a repeated character leaves.
                       // 'auto' = 1 in free mode (digits 90.0% → 98.3%), 0.25 with a word list (1 cost capitals
                       // 96.1% → 92.2% by over-rewarding one-stroke readings; 0.25 measures at the baseline)
}

// -------------------------------------------------------------- recognizer --

export class OverlapRecognizer {
  /** @param {{matcher, lexicon, opts?: Partial<typeof DEFAULTS>}} init — the lexicon fixes the alphabet */
  constructor({ matcher, lexicon, opts = {} }) {
    this.m = matcher
    this.opts = { ...DEFAULTS, ...opts }
    this._useLexicon(lexicon)
    this.reset()
  }

  _useLexicon(lexicon) {
    this.lex = lexicon
    this.A = lexicon.alphabet
    this.idx = lexicon.idx
    this.NA = this.A.length
    this.LOGA = -Math.log(this.NA)
    this.ALL = Array.from({ length: this.NA }, (_, i) => i)
    this.markIdx = [...TERMINAL_MARKS].map((c) => this.idx.get(c)).filter((i) => i != null)
    // per-class size statistics from the templates' drill cells (log of the larger box side, drill px)
    const sz = (this.m.training && this.m.training.sizes) || {}
    const capRef = (this.m.training && this.m.training.capRef) || 84
    this.capRef = capRef
    this.sizes = this.A.map((c) => sz[c] ? { mu: sz[c].mu, sd: Math.max(0.15, sz[c].sd || 0), eligible: Math.exp(sz[c].mu) >= 0.4 * capRef, minStroke: sz[c].minStroke || 0, tiny: Math.exp(sz[c].mu) < 0.2 * capRef } : null)
    // free-mode class prior: the marks share freeMarkShare, everything else the rest (uniform when the alphabet is all one kind)
    const isMark = this.A.map((c) => SETS.punctuation.includes(c))
    const nMark = isMark.filter(Boolean).length, nOther = this.NA - nMark
    this.freeLogP = this.A.map((c, i) => (nMark && nOther)
      ? Math.log(isMark[i] ? this.opts.freeMarkShare / nMark : (1 - this.opts.freeMarkShare) / nOther)
      : this.LOGA)
    const missing = this.A.filter((c) => !this.m.has(c))
    if (missing.length) console.warn('OverlapRecognizer: no templates for ' + JSON.stringify(missing.join('')))
  }

  /**
   * The writer's scale: box px per drill px, the median over the last twelve
   * committed full-size characters of (their size / their class's typical
   * size); before any, sizeRef0 / capRef. Returns {scale, known}.
   */
  _sizeRef() {
    const est = []
    const take = (groups) => { for (const g of groups) { const i = this.idx.get(g.ch); const sz = i == null ? null : this.sizes[i]; if (!sz || !sz.eligible || !g.dim) continue; est.push(g.dim / Math.exp(sz.mu)) } }
    for (const w of this.words) take(w.groups)
    take(this.beam[0].groups)
    const last = est.slice(-12).sort((a, b) => a - b)
    if (!last.length) return { scale: this.opts.sizeRef0 / this.capRef, known: false }
    return { scale: last[Math.floor(last.length / 2)], known: true }
  }

  /** log-likelihood-ish size term for reading group g as class L (0 when the class has no size data),
   *  plus the tiny-stroke charge when the group holds a stroke this class never draws that small. */
  _sizeScore(g, L) {
    const sz = this.sizes[L]
    if (!sz || !g.dim) return 0
    let s = 0
    if (this.opts.sizeW) {
      const z = this._sizeZ(g, L)
      s -= this.opts.sizeW * Math.min(this.opts.sizeCap, 0.5 * z * z)
    }
    if (g.k > 1 && sz.minStroke && g.minFrac < this.opts.tinyRatio * sz.minStroke) s -= this.opts.tinyPen
    return s
  }

  /** True when there is no word list: every character priced alike, nothing off-list. */
  get free() { return this.lex.size === 0 }

  /** The stroke-count prior's weight for this mode. */
  get scw() { const w = this.opts.strokeCountW; return w === 'auto' || w == null ? (this.free ? 1 : 0.25) : Number(w) }

  /** Forget everything: the box, the current word and every finished word. */
  reset() {
    this.strokes = []          // uncommitted, in the box: {id, pts, t0, t1}
    this.erased = []           // this word's strokes already erased from the box, in order
    this.beam = [this._rootEntry()]
    this.words = []            // finished words: {word, groups, alternatives, inList}
    this.cache = new Map()     // group scores by stroke ids
    this.history = []
    this.nextId = 1
    this.last = this._state([], null, 0)
    return this.last
  }

  /** Swap the word list (same alphabet or a new one). The current word's prefix is re-read against it. */
  setLexicon(lexicon) {
    this._snapshot()
    const text = this.beam[0].text
    const sameAlphabet = lexicon.alphabet.join('') === this.A.join('')
    this._useLexicon(lexicon)
    if (!sameAlphabet) this.cache.clear()
    const node = lexicon.size ? lexicon.lookup(text) : null
    this.beam = [{ text: node || !text ? text : text, node: lexicon.size ? node : null, score: 0, groups: this.beam[0].groups }]
    return this._report(null)
  }

  setOpts(opts) {
    this.opts = { ...this.opts, ...opts }
    return this._report(null)
  }

  _rootEntry() { return { text: '', node: this.lex.size ? this.lex.root : null, score: 0, groups: [] } }

  _snapshot() {
    this.history.push({ strokes: this.strokes.slice(), erased: this.erased.slice(), beam: this.beam.slice(), words: this.words.slice() })
    if (this.history.length > 200) this.history.shift()
  }

  /** Drop the current word's ink and prefixes; finished words stay. */
  clearWord() {
    this._snapshot()
    this.strokes = []
    this.erased = []
    this.beam = [this._rootEntry()]
    return this._report(null)
  }

  /** Undo the last stroke, selection or finished word (a commit is undone with the stroke that caused it). */
  undo() {
    const h = this.history.pop()
    if (!h) return this.last
    this.strokes = h.strokes
    this.erased = h.erased
    this.beam = h.beam
    this.words = h.words
    return this._report(null)
  }

  /** A new stroke ([{x,y}], ≥2 points) landed in the box. Returns the new state. */
  addStroke(pts, { t0 = 0, t1 = 0 } = {}) {
    if (!pts || pts.length < 2) return this.last
    this._snapshot()
    this.strokes.push({ id: this.nextId++, pts: pts.map((p) => ({ x: p.x, y: p.y })), t0, t1 })
    return this._step()
  }

  /**
   * The writer is done with this word: commit everything, best reading wins.
   * `word` forces the text (the strokes are re-split to spell it, see
   * fitToWord) — what accepting a candidate does.
   */
  finishWord({ word = null } = {}) {
    if (word) return this.selectWord(word, { finish: true })
    this._snapshot()
    const t0 = now()
    const o = this.opts
    let best = null
    const alts = new Map()
    const consider = (text, score, node, groups) => {
      const s = score + o.lmW * this._endLogP(node)
      if (!alts.has(text) || alts.get(text).score < s) alts.set(text, { text, score: s, groups, inList: !!(node && node.end) })
      if (!best || s > best.score) best = alts.get(text)
    }
    if (this.strokes.length === 0) {
      for (const b of this.beam) consider(b.text, b.score, b.node, b.groups)
    } else {
      const { hyps } = this._dp()
      const groupsOf = (h, p) => this.beam[p.beam].groups.concat(p.groups, [this._mkGroup(h.i, this.strokes.length, h.L, h.shapeFull)])
      for (const h of hyps) {
        if (h.shapeFull === -Infinity) continue   // a partial character cannot end a word
        const p = this._path(h)
        consider(h.text, h.score - h.shape + h.shapeFull, h.node, groupsOf(h, p))
      }
      if (!best) for (const h of hyps) { const p = this._path(h); consider(h.text, h.score, h.node, groupsOf(h, p)) }
    }
    if (!best) best = { text: this.beam[0].text, score: 0, groups: this.beam[0].groups, inList: false }
    const alternatives = [...alts.values()].sort((a, b) => b.score - a.score).slice(0, 6).map((a) => ({ text: a.text, score: a.score, inList: a.inList }))
    const rec = { word: best.text, groups: best.groups, alternatives, inList: best.inList, selected: false }
    return this._finish(rec, now() - t0)
  }

  _finish(word, ms) {
    if (word.word) this.words.push(word)
    this._ref = null
    this.strokes = []
    this.erased = []
    this.beam = [this._rootEntry()]
    this.cache.clear()
    this.last = this._state([], null, ms, { finished: word })
    return this.last
  }

  /**
   * Force the current word's ink — the erased strokes and the box together —
   * onto `word`: the best segmentation whose characters spell a prefix of it,
   * the last possibly unfinished (scored as full OR partial). No lexicon
   * term: the word is given. Returns null with no ink, no characters, or a
   * character the alphabet lacks.
   *   { text, groups: [{ch, ids, strokes, sh, open?, partial?}], m, complete, score, word }
   * `complete` = every character of the word has ink and the last is a full match.
   */
  fitToWord(word) {
    const w = foldWord(word, this.A, this.idx)
    const all = this.erased.concat(this.strokes)
    const n = all.length
    if (!w || !n) return null
    const Ls = [...w].map((c) => this.idx.get(c))
    const o = this.opts
    const K = Math.min(Ls.length, n)
    const NEG = -Infinity
    const f = Array.from({ length: K + 1 }, () => new Float64Array(n + 1).fill(NEG))
    const back = Array.from({ length: K + 1 }, () => new Int32Array(n + 1).fill(-1))
    f[0][0] = 0
    for (let m = 1; m <= K; m++) {
      const L = Ls[m - 1]
      for (let j = m; j < n; j++) {
        for (let i = Math.max(m - 1, j - o.maxStrokes); i < j; i++) {
          if (f[m - 1][i] === NEG) continue
          const g = this._groupOf(all, i, j)
          this._cost(g, L)
          const s = this._closedScore(g, L)
          if (s === NEG) continue
          const v = f[m - 1][i] + s
          if (v > f[m][j]) { f[m][j] = v; back[m][j] = i }
        }
      }
    }
    let best = null
    for (let m = 1; m <= K; m++) {
      const L = Ls[m - 1]
      for (let i = Math.max(m - 1, n - o.maxStrokes); i < n; i++) {
        if (f[m - 1][i] === NEG) continue
        const g = this._groupOf(all, i, n)
        this._cost(g, L)
        const { full: sF, part: sP, best: s } = this._openScore(g, L)
        if (s === NEG) continue
        const v = f[m - 1][i] + s
        if (!best || v > best.score) best = { score: v, m, i, partial: sP > sF, sF }
      }
    }
    if (!best) return null
    const groups = []
    let j = best.i
    for (let m = best.m - 1; m >= 1; m--) {
      const i = back[m][j]
      groups.push(this._mkGroupOf(all, i, j, Ls[m - 1]))
      j = i
    }
    groups.reverse()
    groups.push({ ...this._mkGroupOf(all, best.i, n, Ls[best.m - 1], best.sF), open: true, partial: best.partial })
    const text = w.slice(0, best.m)
    return { text, groups, m: best.m, complete: best.m === Ls.length && !best.partial, score: best.score, word: w }
  }

  /**
   * The writer picked `word` from the candidates. The ink is re-split to spell
   * it (fitToWord). With `finish` (the default, what a tap on a candidate
   * means) the word is accepted WHOLE — characters the ink has not reached get
   * empty groups — and the box is cleared for the next word. With
   * `finish: false` the fitted prefix is adopted: every character but the last
   * is erased, the last one's strokes stay in the box, and writing continues
   * from that prefix in the word list.
   */
  selectWord(word, { finish = true } = {}) {
    const fit = this.fitToWord(word)
    if (!fit) return this.last
    this._snapshot()
    const t0 = now()
    if (finish) {
      const groups = fit.groups.map((g) => ({ ch: g.ch, ids: g.ids, strokes: g.strokes, sh: g.sh }))
      for (let k = fit.m; k < fit.word.length; k++) groups.push({ ch: fit.word[k], ids: [], strokes: [], sh: null })
      const node = this.lex.size ? this.lex.lookup(fit.word) : null
      const rec = { word: fit.word, groups, alternatives: [], inList: !!(node && node.end), selected: true, complete: fit.complete }
      return this._finish(rec, now() - t0)
    }
    const closed = fit.groups.slice(0, -1)
    const last = fit.groups[fit.groups.length - 1]
    const text = closed.map((g) => g.ch).join('')
    this.beam = [{ text, node: this.lex.size ? this.lex.lookup(text) : null, score: 0, groups: closed.map((g) => ({ ch: g.ch, ids: g.ids, strokes: g.strokes, sh: g.sh })) }]
    const all = this.erased.concat(this.strokes)
    this.erased = all.slice(0, all.length - last.ids.length)
    this.strokes = all.slice(all.length - last.ids.length)
    return this._report({ b: 0, margin: Infinity, erased: [], selected: fit.word })
  }

  // ----------------------------------------------------------- the DP ----

  _sh(d) {
    if (d === Infinity) return -Infinity
    const s = (Math.log(this.opts.costRef) - Math.log(d + this.opts.costEps)) / this.opts.temp
    const m = this.opts.shMax
    return s > 0 && m > 0 ? m * Math.tanh(s / m) : s
  }

  _next(node, L) {
    if (node === null) return { node: null, lm: this.free ? this.freeLogP[L] : this.LOGA }
    const child = node.ch[L]
    if (child) return { node: child, lm: child.logMass - node.logMass }
    if (node.end > 0 && !node.mark && this.markIdx.includes(L)) {
      // a complete word may end with , . : — the word is then done
      return { node: this.lex.markNode, lm: Math.log(node.end) - node.logMass + Math.log(this.opts.markP) }
    }
    return { node: null, lm: this.LOGA - this.opts.oovPen }
  }

  _endLogP(node) {
    if (node === null) return this.free ? 0 : -this.opts.oovPen
    if (!node.end) return this.opts.endFloor
    return Math.log(node.end) - node.logMass
  }

  /** The group of strokes [i, j) of `list`: costs are filled per class on demand (cached by stroke ids). */
  _groupOf(list, i, j) {
    const key = list.slice(i, j).map((s) => s.id).join(',')
    let g = this.cache.get(key)
    if (g) return g
    const pts = list.slice(i, j).map((s) => s.pts)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const st of pts) for (const p of st) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y }
    const dim = Math.max(x1 - x0, y1 - y0, 1)
    let minLen = Infinity
    for (const st of pts) {   // the smallest stroke's bounding box (a dot's curl has path but no extent)
      let a0 = Infinity, b0 = Infinity, a1 = -Infinity, b1 = -Infinity
      for (const p of st) { if (p.x < a0) a0 = p.x; if (p.y < b0) b0 = p.y; if (p.x > a1) a1 = p.x; if (p.y > b1) b1 = p.y }
      const l = Math.max(a1 - a0, b1 - b0, 1)
      if (l < minLen) minLen = l
    }
    g = { key, k: j - i, pts, dim, minFrac: minLen / dim, full: new Float64Array(this.NA).fill(NaN), part: new Float64Array(this.NA).fill(NaN), scored: [], ok: null }
    this.cache.set(key, g)
    return g
  }

  /** The full and partial class costs of a group against character index L, scored on first use. */
  _cost(g, L) {
    if (Number.isNaN(g.full[L])) {
      if (g.ok === null || this.m.current !== g.key) g.ok = this.m.upload(g.pts, g.key)
      const ch = this.A[L]
      g.full[L] = g.ok && this.m.has(ch) ? combineCosts(this.m.costs(ch), this.opts.combine) : Infinity
      const pk = ch + '/' + g.k
      g.part[L] = g.ok && this.m.has(pk) ? combineCosts(this.m.costs(pk), this.opts.combinePart) : Infinity
      g.scored.push(L)
    }
    return { full: g.full[L], part: g.part[L] }
  }

  /** A closed group's score as character L: per-stroke log-odds × strokes + the stroke-count prior. */
  /** How many size sds group g is from class L's typical size (0 without size data). */
  _sizeZ(g, L) {
    const sz = this.sizes[L]
    if (!sz || !g.dim) return 0
    if (!this._ref) this._ref = this._sizeRef()
    const sd = Math.sqrt(sz.sd * sz.sd + (this._ref.known ? this.opts.sizeSd : this.opts.sizeSd0) ** 2)
    return (Math.log(g.dim / this._ref.scale) - sz.mu) / sd
  }

  _shOf(g, L) {
    if (g.full[L] === Infinity) return -Infinity
    const sz = this.sizes[L]
    // a tiny class is found by size alone: flat for a tiny group, impossible for a big one
    if (sz && sz.tiny) return this._sizeZ(g, L) < 3 ? this.opts.tinyShape : -Infinity
    return this._sh(g.full[L])
  }

  _closedScore(g, L) {
    const s = this._shOf(g, L)
    if (s === -Infinity) return -Infinity
    return s * g.k + this.scw * this.m.strokeLogP(this.A[L], g.k) + this._sizeScore(g, L)
  }

  /** An open group's scores as character L: {full, part, best} — full carries the count prior, a partial is count-consistent by construction. */
  _openScore(g, L) {
    const sF0 = this._shOf(g, L), sP0 = this._sh(g.part[L])
    const full = sF0 === -Infinity ? -Infinity : sF0 * g.k + this.scw * this.m.strokeLogP(this.A[L], g.k) + this._sizeScore(g, L)
    const part = sP0 === -Infinity ? -Infinity : sP0 * g.k
    return { full, part, best: Math.max(full, part) }
  }

  /** Score a group against `letters`, then — when none fits at all — against the whole alphabet. Returns the scored indices. */
  _scoreGroup(g, letters, open) {
    if (letters === this.ALL || !this.opts.pruneClasses) { for (const L of this.ALL) this._cost(g, L); return g.scored }
    let best = -Infinity
    for (const L of letters) {
      const c = this._cost(g, L)
      const s = open ? Math.max(this._sh(c.full), this._sh(c.part)) : this._sh(c.full)
      if (s > best) best = s
    }
    if (best < this.opts.oovTrigger) for (const L of this.ALL) this._cost(g, L)
    return g.scored
  }

  /** The characters the word list allows next from any of these states (every one, off-list or in free mode). */
  _allowed(states) {
    if (!this.opts.pruneClasses) return this.ALL
    const set = new Set()
    for (const st of states) {
      if (st.node === null) return this.ALL
      const ch = st.node.ch
      for (let L = 0; L < this.NA; L++) if (ch[L]) set.add(L)
      if (st.node.end > 0 && !st.node.mark) for (const L of this.markIdx) set.add(L)
    }
    return [...set]
  }

  _group(i, j) { return this._groupOf(this.strokes, i, j) }

  /**
   * Segment the uncommitted strokes. `forbid` (a position 1..n−1) bars any
   * boundary there — no closed group may end at it and the open group may
   * not start at it — which is how "the best reading WITHOUT this boundary"
   * is measured exactly. Returns the per-position beam states and the open
   * hypotheses (one per start position × character), best first.
   */
  _dp(forbid = -1) {
    const S = this.strokes, n = S.length, o = this.opts
    const states = new Array(n + 1)
    states[0] = this.beam.map((b, bi) => ({ score: b.score, node: b.node, text: b.text, beam: bi, back: null, pos: 0 }))
    const allowed = new Array(n + 1)
    allowed[0] = this._allowed(states[0])
    for (let j = 1; j <= n; j++) {
      const acc = new Map()
      if (j !== forbid && j < n) {
        for (let i = Math.max(0, j - o.maxStrokes); i < j; i++) {
          if (!states[i].length) continue
          const g = this._group(i, j)
          const scored = this._scoreGroup(g, allowed[i], false)
          for (const st of states[i]) {
            for (const L of scored) {
              const s = this._closedScore(g, L)
              if (s === -Infinity) continue
              const nx = this._next(st.node, L)
              const score = st.score + s + o.lmW * nx.lm
              const text = st.text + this.A[L]
              const key = nx.node ? nx.node.id : 'off:' + text
              const prev = acc.get(key)
              if (!prev || prev.score < score) acc.set(key, { score, node: nx.node, text, beam: st.beam, back: { i, st, L, sh: s }, pos: j })
            }
          }
        }
      }
      states[j] = [...acc.values()].sort((a, b) => b.score - a.score).slice(0, o.beamK)
      allowed[j] = this._allowed(states[j])
    }
    const hyps = []
    for (let i = Math.max(0, n - o.maxStrokes); i < n; i++) {
      if (!states[i].length) continue
      const g = this._group(i, n)
      const scored = this._scoreGroup(g, allowed[i], true)
      for (const st of states[i]) {
        for (const L of scored) {
          const { full: sF, part: sP, best: s } = this._openScore(g, L)
          if (s === -Infinity) continue
          const nx = this._next(st.node, L)
          hyps.push({ score: st.score + s + o.lmW * nx.lm, i, st, L, node: nx.node, text: st.text + this.A[L], partial: sP > sF, shape: s, shapeFull: sF, shapePart: sP, lm: nx.lm })
        }
      }
    }
    hyps.sort((a, b) => b.score - a.score)
    return { states, hyps }
  }

  /** The closed groups of a hypothesis, from position 0 to its open group. */
  _path(h) {
    const groups = []
    let st = h.st
    while (st.back) { groups.push(this._mkGroup(st.back.i, st.pos, st.back.L, st.back.sh)); st = st.back.st }
    groups.reverse()
    return { beam: st.beam, groups, bounds: groups.map((g) => g.j) }
  }

  _mkGroupOf(list, i, j, L, sh = null) {
    const ss = list.slice(i, j)
    return { ch: this.A[L], ids: ss.map((s) => s.id), strokes: ss.map((s) => s.pts), sh, j, dim: this._groupOf(list, i, j).dim }
  }

  _mkGroup(i, j, L, sh = null) { return this._mkGroupOf(this.strokes, i, j, L, sh) }

  _step() {
    const t0 = now()
    this._ref = null
    let { hyps } = this._dp()
    let commit = null
    if (hyps.length) {
      const best = hyps[0]
      const p = this._path(best)
      // boundaries of the best reading, latest first, never position 0
      const bounds = [best.i, ...p.bounds.slice().reverse()].filter((b, k, arr) => b > 0 && arr.indexOf(b) === k)
      for (const b of bounds) {
        const alt = this._dp(b)
        const altBest = alt.hyps.length ? alt.hyps[0].score : -Infinity
        const margin = best.score - altBest
        if (margin >= this.opts.commitMargin) { commit = { b, margin }; break }
      }
    }
    if (commit) {
      commit.erased = this._commit(commit.b, hyps)
      this._ref = null
      ;({ hyps } = this._dp())
    }
    this.last = this._state(hyps, commit, now() - t0)
    return this.last
  }

  /**
   * Erase strokes [0, b) and rebuild the beam from every good hypothesis's
   * reading of them. Entries are keyed by trie node (same node ⇒ same text),
   * keep the best forward score, and carry the erased strokes grouped by
   * character for display.
   */
  _commit(b, hyps) {
    const o = this.opts
    const bestScore = hyps[0].score
    const byState = new Map()
    for (const h of hyps) {
      if (h.score < bestScore - o.beamMargin) break
      let st = h.st
      if (h.i < b) continue
      while (st && st.pos > b) st = st.back ? st.back.st : null
      if (!st || st.pos !== b) continue
      const key = st.node ? st.node.id : 'off:' + st.text
      const prev = byState.get(key)
      if (!prev || prev.total < h.score) byState.set(key, { st, total: h.score })
    }
    const entries = [...byState.values()].sort((a, c) => c.total - a.total).slice(0, o.beamK)
    const oldBeam = this.beam
    const erased = this.strokes.slice(0, b)
    const top = entries[0].st.score
    this.beam = entries.map(({ st }) => {
      const groups = []
      let s = st
      while (s.back) { groups.push(this._mkGroup(s.back.i, s.pos, s.back.L, s.back.sh)); s = s.back.st }
      groups.reverse()
      return { text: st.text, node: st.node, score: st.score - top, groups: oldBeam[s.beam].groups.concat(groups) }
    })
    this.erased = this.erased.concat(erased)
    this.strokes = this.strokes.slice(b)
    return erased
  }

  // --------------------------------------------------------- reporting ----

  _report(commit) { this._ref = null; const { hyps } = this._dp(); this.last = this._state(hyps, commit, 0); return this.last }

  _candidates(hyps) {
    const o = this.opts
    const out = new Map()
    const put = (word, score, kind) => { const p = out.get(word); if (!p || p.score < score) out.set(word, { word, score, kind, complete: kind === 'done' }) }
    const sources = hyps.length ? hyps : this.beam.map((b) => ({ score: b.score, node: b.node, text: b.text }))
    const best = sources.length ? sources[0].score : 0
    for (const h of sources) {
      if (h.score < best - o.beamMargin) break
      if (h.node === null) { if (h.text) put(h.text, h.score - (this.free ? 0 : o.oovPen), this.free ? 'free' : 'oov'); continue }
      if (h.node.mark) { put(h.text, h.score + o.doneBoost, 'done'); continue }
      if (h.node.end) put(h.text, h.score + o.lmW * (Math.log(h.node.end) - h.node.logMass) + o.doneBoost, 'done')
      for (const t of h.node.top) put(t.word, h.score + o.lmW * (Math.log(t.wt) - h.node.logMass), t.word === h.text ? 'done' : 'more')
    }
    return [...out.values()].sort((a, b) => b.score - a.score).slice(0, 8)
  }

  /**
   * The state every caller renders from:
   *   text        best reading of the current word (committed + pending characters)
   *   committed   characters whose strokes are erased (best beam entry)
   *   pending     the rest of `text`
   *   groups      committed characters with their strokes
   *   assignment  the box's strokes grouped by the best reading: closed groups
   *               (a character suspected complete) then the open one
   *   candidates  [{word, score, kind: done|more|oov|free, complete}]
   *   commit      {b, margin, erased} when this step erased strokes
   *   finished    the word record when this step finished a word
   *   words       every finished word so far
   */
  _state(hyps, commit, ms, extra = {}) {
    const best = hyps[0] || null
    let assignment = []
    if (best) {
      const p = this._path(best)
      assignment = p.groups.map((g) => ({ ch: g.ch, ids: g.ids, strokes: g.strokes, open: false }))
        .concat([{ ch: this.A[best.L], ids: this.strokes.slice(best.i).map((s) => s.id), strokes: this.strokes.slice(best.i).map((s) => s.pts), open: true, partial: best.partial }])
    } else if (this.strokes.length) {
      assignment = [{ ch: '', ids: this.strokes.map((s) => s.id), strokes: this.strokes.map((s) => s.pts), open: true, partial: true }]
    }
    const view = (h) => {
      const p = this._path(h)
      return { text: h.text, score: h.score, i: h.i, partial: h.partial, shape: h.shape, lm: h.lm, groups: p.groups.map((g) => g.ch + '(' + g.ids.length + ')').concat([h.partial ? h.text.slice(-1) + '…' : h.text.slice(-1)]), beam: p.beam }
    }
    return {
      n: this.strokes.length,
      text: best ? best.text : this.beam[0].text,
      committed: this.beam[0].text,
      pending: best ? best.text.slice(this.beam[0].text.length) : '',
      ambiguous: this.beam.length > 1,
      beam: this.beam.map((b) => ({ text: b.text, score: b.score, oov: b.node === null && !this.free })),
      groups: this.beam[0].groups,
      hyps: hyps.slice(0, 10).map(view),
      assignment,
      candidates: this._candidates(hyps),
      commit: commit ? { b: commit.b, margin: commit.margin, erased: commit.erased, selected: commit.selected || null } : null,
      words: this.words,
      strokes: this.strokes,
      alphabet: this.A,
      free: this.free,
      sizeRef: (this._ref || this._sizeRef()),
      ms,
      ...extra,
    }
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
