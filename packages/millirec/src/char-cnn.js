// millirec/char-cnn as an ES module: drawn capital letters through the softmax
// CNN, with attach() for a drawing pad.
//
//   import { MillirecCharCnn } from 'millirec/char-cnn'
//   const rec = await MillirecCharCnn.create()          // option 'accurate'
//   rec.attach(document.querySelector('#pad'))
import { MillirecCharCnn as Runtime } from '../../../library/src/char-cnn.js'
import { withOption } from './options.js'

export { OPTIONS, loadOption } from './options.js'

export class MillirecCharCnn extends Runtime {
  /** opts: option ('accurate' | 'fast' | 'small' | 'digits' | 'lowercase', default 'accurate') or your own
   *  { classes, stages, kernel }, plus assetBase (default: this module's folder).
   *  A string is the option's name: create('fast') = create({ option: 'fast' }). */
  static async create(opts = {}) {
    return super.create(await withOption(opts))
  }
}
