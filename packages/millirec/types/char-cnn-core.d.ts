import type { Strokes, Stroke, Reading } from '../char-lite/index.js'

export interface Stage { model: string; head: string; theta?: number; headNorm?: boolean }
export interface CnnConfig { classes: string | string[]; stages: Stage[]; kernel?: string }

export interface CreateOptions extends Partial<CnnConfig> {
  /** A shipped option, used when `stages` is not given. Default 'accurate'. */
  option?: OptionName
  /** Folder holding the model files and kernel. Default: next to this module. Absolute, root-relative
   *  or page-relative; the trailing slash is optional. It (and `kernel`) decide what code is loaded:
   *  never fill them from a URL parameter or user input. */
  assetBase?: string
  /** Symbols of your own, a few drawings each: the same as calling `teach(examples)` after `create()`. */
  examples?: Record<string, Array<Strokes | Stroke>>
}

/** `accurate`, `fast` and `small` read capital letters A–Z; `digits` reads 0–9 and `lowercase` a–z. */
export declare const OPTIONS: readonly ['accurate', 'fast', 'small', 'digits', 'lowercase']
export type OptionName = (typeof OPTIONS)[number]
export declare function loadOption(name: OptionName, opts?: { assetBase?: string }): Promise<CnnConfig>

export declare class MillirecCharCnnCore {
  /** A string is a shipped option's name: create('fast') = create({ option: 'fast' }). */
  static create(opts?: CreateOptions | OptionName): Promise<MillirecCharCnnCore>
  readonly classes: string[]
  readonly ready: Promise<void>
  /** `only` restricts the reading to these classes. */
  recognize(strokes: Strokes | Stroke, opts?: { only?: string | string[] | Set<string> }): Promise<(Reading[] & { stage?: number }) | null>
  /** Refit the last stage's head on your own drawings: { 'A': [strokes, ...], ... }.
   *  Anchored to the shipped head, so a few samples nudge a letter and many take it over.
   *  Classes outside `classes` are ignored (the CNN cannot learn new characters this way). */
  personalize(samples: Record<string, Array<Strokes | Stroke>>, opts?: { steps?: number; lr?: number; prior?: number }): Promise<{ n: number; classes: string[] } | null>
  /** Back to the shipped head. */
  depersonalize(): void
  /**
   * Read symbols of your own from a few drawings of each, with no training: every drawing is kept as what the
   * last stage's network makes of it, and from then on `recognize()` answers among the taught names only, by the
   * nearest example. Names are any strings. `{ add: true }` keeps what was taught before. Resolves `null` when
   * nothing usable was given. Best on an option whose last stage is the larger network (`accurate`, `fast`).
   */
  teach(examples: Record<string, Array<Strokes | Stroke>>, opts?: { add?: boolean }): Promise<{ classes: string[]; n: number } | null>
  /** Drop what `teach()` learned: `recognize()` reads the option's own classes again. */
  forget(): void
  /** The last stage's unit embedding of a drawing — what the head reads. Throws after destroy(). */
  embedding(strokes: Strokes | Stroke): Promise<Float32Array>
  /** Let go of the models; recognize() and personalize() return null afterwards. */
  destroy(): void
}
