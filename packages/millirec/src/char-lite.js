// millirec/char-lite as an ES module: the script-tag runtime, with its worker
// and wasm found next to this file instead of next to a <script>, and the
// shipped training sets one fetch away.
//
//   import { MillirecCharLite, loadSet } from 'millirec/char-lite'
//   const training = await loadSet('digits')
//   const rec = await MillirecCharLite.create({ training })
//   rec.attach(document.querySelector('#pad'))
//
// Your own strokes: MillirecCharLite.withSamples(training, { '7': [strokes, ...] }).
import { MillirecCharLite as Runtime } from '../../../library/src/char-lite.js'
import { assetBaseOf, fetchAsset } from '../../../library/src/assetbase.js'
import { HERE, nodeFileUrl } from './here.js'

/** The shipped training sets, by name (dist/char-lite/sets/<name>.json). */
export const SETS = ['all', 'capitals', 'digits', 'lowercase', 'punctuation']

/** Fetch a shipped training set. `assetBase` defaults to this module's folder; a root-relative
 *  ('/millirec/char-lite') or page-relative path works too. */
export async function loadSet(name, { assetBase = HERE } = {}) {
  if (!SETS.includes(name)) throw new Error(`millirec: no training set "${name}" (one of ${SETS.join(', ')})`)
  const base = assetBaseOf(assetBase)
  const url = new URL(`sets/${name}.json`, base).href
  nodeFileUrl(url, `millirec/char-lite/sets/${name}.json`)
  return fetchAsset(url, { what: `the ${name} training set`, base, recognizer: 'char-lite' })
}

export class MillirecCharLite extends Runtime {
  /** As the script-tag create(), but `training` is required (no window.MILLIREC_TRAINING)
   *  and the worker/wasm are found beside this module unless `assetBase` says otherwise. */
  static create(opts = {}) {
    if (!opts.training) throw new Error('MillirecCharLite.create: pass { training } — e.g. await loadSet("digits")')
    return super.create({ assetBase: HERE, ...opts })
  }
}
