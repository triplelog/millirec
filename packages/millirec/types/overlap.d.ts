// The overlap widget is a script-tag build (dist/overlap/millirec-overlap.min.js) that sets
// window.MillirecOverlap. These declarations type that global:
//
//   import type {} from 'millirec/overlap'      // or: /// <reference types="millirec/overlap" />
//   const w = await MillirecOverlap.create('#box', { set: 'capitals', words: ['HELLO'] })
//
// Source: library/src/overlap.js (the full option list is in OverlapWidget's constructor comment).

export type OverlapSet = 'capitals' | 'lowercase' | 'digits' | 'punctuation' | 'all'
export type OverlapEvent = 'ready' | 'stroke' | 'change' | 'word' | 'select' | 'error'
export interface OverlapPoint { x: number; y: number }

export interface OverlapCandidate { word: string; score: number; complete: boolean; inList: boolean }
export interface OverlapWord {
  word: string
  letters: Array<{ ch: string; strokes: OverlapPoint[][] }>
  inList: boolean
  selected: boolean
  alternatives: Array<{ word: string; score: number; inList: boolean }>
}

export interface OverlapOptions {
  /** Which characters the box reads (default 'capitals'). */
  set?: OverlapSet
  /** An explicit alphabet ('ABC…' or 'capitals,digits'); loads the superset and uses these. */
  alphabet?: string
  /** The word list: an array, or a whitespace/comma-separated string. */
  words?: string[] | string
  /** A list hosted on a millirec server (needs apiBase). */
  list?: string
  /** URL of a text/JSON file of words. */
  wordsSrc?: string
  /** Receives the text (an input/textarea's value, else textContent). */
  target?: string | HTMLElement
  /** 'live' (default) includes the word being written. */
  targetMode?: 'live' | 'words'
  /** The box, in CSS px (default 240). */
  size?: number
  layout?: 'column' | 'row'
  /** Candidate words shown (default 6). */
  chips?: number
  /** Previous words' handwriting kept beside the current one (default 1). */
  history?: number
  /** Seconds of pen-up after which the word finishes itself (0 = never, the default). */
  idleFinish?: number
  theme?: 'auto' | 'light' | 'dark'
  /** Any of 'text,handwriting,words,buttons'. */
  hide?: string
  placeholder?: string
  /** Recognizer knobs (commitMargin, lmW, …). */
  engine?: Record<string, number>
  /** Where millirec.wasm, training.<set>.json and words.json are. Default: beside the script.
   *  A code-loading option: never fill it from user input. */
  assetBase?: string
  /** The millirec server, for `list`. */
  apiBase?: string
  onReady?: (detail: OverlapDetail) => void
  onStroke?: (detail: OverlapDetail) => void
  onChange?: (detail: OverlapDetail) => void
  onWord?: (detail: OverlapDetail & OverlapWord & { canvas: HTMLCanvasElement }) => void
  onSelect?: (detail: OverlapDetail) => void
  onError?: (detail: OverlapDetail & { error: Error }) => void
}

/** An event's detail. 'stroke'/'change'/'word' carry the text fields; 'word' adds the finished word. */
export interface OverlapDetail {
  widget: OverlapWidget
  text?: string
  live?: string
  current?: string
  committed?: string
  pending?: string
  candidates?: OverlapCandidate[]
  strokes?: number
  erased?: number
  canvas?: HTMLCanvasElement | null
  [key: string]: unknown
}

export interface OverlapWidget {
  readonly el: HTMLElement
  readonly ready: Promise<void>
  /** Subscribe; returns the unsubscribe function. DOM events 'millirec-overlap:<event>' bubble from the host too. */
  on(event: OverlapEvent, fn: (detail: OverlapDetail) => void): () => boolean
  /** The finished words, joined by spaces. */
  getText(): string
  /** The finished words plus the word being written. */
  getLiveText(): string
  getWords(): OverlapWord[]
  getCandidates(): OverlapCandidate[]
  getWordList(): string[]
  getHandwriting(opts?: { scope?: 'word' | 'all'; index?: number; capHeight?: number }): HTMLCanvasElement | null
  /** Replace the word list; returns the usable words (0 = free mode). */
  setWords(words: string[] | string): number
  /** Load a list hosted on the millirec server by id. */
  loadList(id: string): Promise<number>
  getLexiconSize(): number
  /** Switch the character set or an explicit alphabet; resolves with the alphabet when ready. */
  setAlphabet(spec: OverlapSet | string): Promise<string | undefined>
  /** Finish the word being written (best reading), or force it to `word`. */
  finishWord(word?: string | null): void
  /** Accept a candidate; `finish: false` adopts it as a prefix and keeps writing. */
  selectWord(word: string, opts?: { finish?: boolean }): void
  undo(): void
  /** Drop the current word's ink; finished words stay. */
  clearWord(): void
  /** Forget everything, finished words included. */
  clear(): void
  setOptions(engineOpts: Record<string, number>): void
  destroy(): void
}

export interface MillirecOverlapApi {
  readonly version: string
  create(host: string | HTMLElement, opts?: OverlapOptions): Promise<OverlapWidget>
  /** Mount a widget on every [data-millirec-overlap] element not yet mounted (done once on load). */
  scan(root?: ParentNode): OverlapWidget[]
  Widget: new (host: string | HTMLElement, opts?: OverlapOptions) => OverlapWidget
  /** Prewarm the matcher and templates for a set (optional; create() does it on demand). */
  preload(set?: OverlapSet | string, assetBase?: string): Promise<unknown>
  splitWords(s: string): string[]
  wordStrip(groups: unknown[], capHeight?: number, colors?: Record<string, string>): HTMLCanvasElement
  sentenceStrip(wordsGroups: unknown[][], capHeight?: number, colors?: Record<string, string>): HTMLCanvasElement
  SET_NAMES: readonly string[]
  [key: string]: unknown
}

declare global {
  interface Window { MillirecOverlap: MillirecOverlapApi }
  var MillirecOverlap: MillirecOverlapApi
  interface HTMLElementEventMap {
    'millirec-overlap:ready': CustomEvent<OverlapDetail>
    'millirec-overlap:stroke': CustomEvent<OverlapDetail>
    'millirec-overlap:change': CustomEvent<OverlapDetail>
    'millirec-overlap:word': CustomEvent<OverlapDetail & OverlapWord & { canvas: HTMLCanvasElement }>
    'millirec-overlap:select': CustomEvent<OverlapDetail & { word: string; finish: boolean }>
    'millirec-overlap:error': CustomEvent<OverlapDetail & { error: Error }>
  }
}
