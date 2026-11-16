// The folder a runtime loads its worker, wasm and model files from, as an absolute URL with a
// trailing slash: '/millirec/char-lite' and 'millirec/char-lite/' both become
// 'https://this.site/millirec/char-lite/'. Files are joined onto it by string concatenation and
// by importScripts()/import(), so a missing slash or a page-relative path would point elsewhere.
// '' (no script URL to go by) means the page's own folder.
// An asset base is a CODE-LOADING option: never fill it from a URL parameter or user input.
export function assetBaseOf(base) {
  let s = base ? String(base) : ''
  if (!s) return typeof location !== 'undefined' ? new URL('./', location.href).href : ''
  if (!s.endsWith('/')) s += '/'
  return typeof location !== 'undefined' ? new URL(s, location.href).href : s
}

/** One stroke ([{x,y},…]) or several ([[{x,y},…],…]) → several. */
export const asStrokes = (s) => (Array.isArray(s) && s.length && !Array.isArray(s[0]) ? [s] : s)

/** The error a runtime throws when a file it needs is not where `base` says: a missing file, or a
 *  page the server sent instead (a bundler's SPA fallback answers every path with index.html). */
export const notServed = (url, what, base, recognizer) => new Error(`millirec: ${url} is not ${what} — the package files are not served at ${base}; ` +
  `copy node_modules/millirec/dist/${recognizer}/ and pass assetBase (see README "Serving the files")`)

/** fetch(url) → parsed JSON ('json') or bytes ('buf'), with notServed() for anything that is not the file. */
export async function fetchAsset(url, { as = 'json', what, base, recognizer }) {
  const fail = (detail) => { const e = notServed(url, what, base, recognizer); if (detail) e.message += ` (${detail})`; return e }
  let r
  try { r = await fetch(url) } catch (e) { throw fail(e && e.message) }
  const type = (r.headers && r.headers.get('content-type')) || ''
  if (!r.ok) throw fail(`HTTP ${r.status}`)
  // the BODY decides, not the header: some hosts label a real .bin as text/html
  if (as === 'json') { try { return await r.json() } catch (e) { throw fail(/html/i.test(type) ? 'an HTML page' : e && e.message) } }
  const buf = await r.arrayBuffer()
  const head = String.fromCharCode(...new Uint8Array(buf, 0, Math.min(buf.byteLength, 16))).trimStart().toLowerCase()
  if (head.startsWith('<!doctype') || head.startsWith('<html')) throw fail('an HTML page')
  return buf
}
