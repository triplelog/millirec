// The three shipped CNN options (dist/char-cnn/options/<name>.json), shared by
// the char-cnn and char-cnn/core entries. Both bundle their own copy; it is
// small, and a shared chunk would be one more file to resolve.
import { assetBaseOf, fetchAsset } from '../../../library/src/assetbase.js'
import { HERE, nodeFileUrl } from './here.js'

export const OPTIONS = ['accurate', 'fast', 'small']

/** Fetch a shipped option's config ({ classes, stages, kernel? }). */
export async function loadOption(name, { assetBase = HERE } = {}) {
  if (!OPTIONS.includes(name)) throw new Error(`millirec: no CNN option "${name}" (one of ${OPTIONS.join(', ')})`)
  const base = assetBaseOf(assetBase)
  const url = new URL(`options/${name}.json`, base).href
  nodeFileUrl(url, `millirec/char-cnn/options/${name}.json`)
  return fetchAsset(url, { what: `the ${name} CNN option`, base, recognizer: 'char-cnn' })
}

/** create() options with a shipped option's stages filled in, unless the caller brought their own. */
export async function withOption(opts) {
  if (typeof opts === 'string') opts = { option: opts }   // create('fast')
  opts = opts || {}
  if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') {
    throw new Error('millirec: char-cnn needs a browser (fetch, and a canvas or OffscreenCanvas); importing is SSR-safe but call create() on the client')
  }
  const assetBase = assetBaseOf(opts.assetBase || HERE)
  const preset = opts.stages ? {} : await loadOption(opts.option || 'accurate', { assetBase })
  return { ...preset, ...opts, assetBase }
}
