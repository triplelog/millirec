// millirec/char-cnn/core as an ES module: the CNN runtime without the drawing
// pad, for callers that capture strokes themselves.
//
//   import { MillirecCharCnnCore } from 'millirec/char-cnn/core'
//   const rec = await MillirecCharCnnCore.create()                 // option 'accurate'
//   const rec = await MillirecCharCnnCore.create({ option: 'fast' })
//   await rec.recognize(strokes)                                   // [{char, prob} x3]
import { MillirecCharCnnCore as Runtime } from '../../../library/src/char-cnn-core.js'
import { withOption } from './options.js'

export { OPTIONS, loadOption } from './options.js'

export class MillirecCharCnnCore extends Runtime {
  /** opts: option ('accurate' | 'fast' | 'small' | 'digits' | 'lowercase', default 'accurate') or your own
   *  { classes, stages, kernel }, plus assetBase (default: this module's folder).
   *  A string is the option's name: create('fast') = create({ option: 'fast' }). */
  static async create(opts = {}) {
    return super.create(await withOption(opts))
  }
}
