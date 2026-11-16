export interface Point { x: number; y: number }
/** One stroke is a polyline; a drawing is one or more strokes. */
export type Stroke = Point[]
export type Strokes = Stroke[]
/** A delta-encoded sample: first value absolute, then differences. */
export interface Sample { x: number[]; y: number[] }
export interface Reading { char: string; prob: number }

/** v2 training data (core/format/schema.js). v1 `{ class: Sample[] }` is also accepted.
 *  `version` and `mode` are wide (number, string) so a set imported as JSON type-checks. */
export interface Training {
  /** 2 */
  version: number
  /** 'stroke' | 'image' | 'both' */
  mode?: 'stroke' | 'image' | 'both' | (string & {})
  pointsPerShape?: number
  classes: Record<string, { samples: Sample[]; geometry?: unknown }>
  params?: Record<string, number>
  ext?: Record<string, unknown>
}

export interface CreateOptions {
  training: Training | Record<string, Sample[]>
  /** Folder holding worker-stroke.js and millirec.wasm. Default: next to this module. Absolute,
   *  root-relative or page-relative; the trailing slash is optional. It decides what code is loaded:
   *  never fill it from a URL parameter or user input. */
  assetBase?: string
  params?: Record<string, number>
  workerStroke?: string
}

export interface AttachOptions {
  /** Pad size in CSS px (default 240 x 240). */
  width?: number
  height?: number
  /** Ink colour (default '#1e293b'). */
  ink?: string
  /** Seconds of pen-up after which the next stroke starts a new character (default 2; 0 = off). */
  idleOverwrite?: number
  /** Scribbling over the character throws it away (default true). */
  scribbleClear?: boolean
  /** Overrides for the scribble-out detector's bars (turns, retrace, winding, cover). */
  scribble?: Record<string, number> | null
  /** Opacity of ink once the character has settled (default 0.3). */
  staleAlpha?: number
  onStale?: (stale: boolean) => void
}

export interface Pad {
  clear(): void
  /** Put back ink the pad dropped by itself; false when there was none. */
  undoClear(): boolean
  isStale(): boolean
  getStrokes(): Strokes
  /** Change idleOverwrite, scribbleClear, scribble or staleAlpha on a mounted pad. */
  configure(opts: Pick<AttachOptions, 'idleOverwrite' | 'scribbleClear' | 'scribble' | 'staleAlpha'>): void
  setInk(color: string): void
  repaint(): void
  canvas: HTMLCanvasElement
}

/** `millirec:result` — after every stroke (and with empty results when the pad empties). */
export interface ResultDetail { results: Reading[] | null; strokes: Strokes }
/** `millirec:clear` — the pad dropped its own ink: 'idle' (idleOverwrite) or 'scribble'. `undo()` puts it back. */
export interface ClearDetail { reason: 'idle' | 'scribble'; undo: () => boolean }

declare global {
  interface HTMLElementEventMap {
    'millirec:result': CustomEvent<ResultDetail>
    'millirec:clear': CustomEvent<ClearDetail>
  }
}

export declare const SETS: readonly ['all', 'capitals', 'digits', 'lowercase', 'punctuation']
export type SetName = (typeof SETS)[number]

/** Fetch a shipped training set. */
export declare function loadSet(name: SetName, opts?: { assetBase?: string }): Promise<Training>

export declare class MillirecCharLite {
  static create(opts: CreateOptions): Promise<MillirecCharLite>
  /** Strokes → one sample. Pass the set's pointsPerShape (shipped sets: 25). */
  static strokesToSample(strokes: Strokes | Stroke, pointsPerShape?: number): Sample | null
  /** A copy of `training` with your own drawings added per class (new classes allowed). */
  static withSamples(training: Training | Record<string, Sample[]>, extra: Record<string, Array<Strokes | Stroke | Sample>>, opts?: { replace?: boolean }): Training
  static createDrawCanvas(opts?: object): unknown
  readonly charList: string[]
  readonly ready: Promise<void>
  /** null for an empty drawing, and after destroy(). */
  recognize(strokes: Strokes | Stroke): Promise<Reading[] | null>
  /** Raw per-template costs: costs[i] holds one cost per training sample of classes[i] (lower is closer). */
  rawScores(strokes: Strokes | Stroke): Promise<{ classes: string[]; costs: number[][] } | null>
  use(plugin: { rerank?: (out: unknown, ctx: unknown) => unknown }): this
  /** Mount a drawing pad in `el`; `el` then fires 'millirec:result' and 'millirec:clear'. */
  attach(el: HTMLElement, opts?: AttachOptions): Pad
  /** Stop the instance's Worker (each instance holds one, plus a wasm matcher). Pending and later
   *  recognize()/rawScores() calls resolve null. */
  destroy(): void
}
