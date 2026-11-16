import type { AttachOptions, Pad } from '../char-lite/index.js'
import { MillirecCharCnnCore, type CreateOptions, type OptionName } from './core.js'

export type { ResultDetail, ClearDetail } from '../char-lite/index.js'
export { OPTIONS, loadOption, type OptionName, type CnnConfig, type Stage, type CreateOptions } from './core.js'

export declare class MillirecCharCnn extends MillirecCharCnnCore {
  static create(opts?: CreateOptions | OptionName): Promise<MillirecCharCnn>
  attach(el: HTMLElement, opts?: AttachOptions): Pad
}
