// This module's own folder, where the package's worker, wasm, sets and model files sit beside it.
// Sliced from import.meta.url, not `new URL('./', import.meta.url)`: bundlers rewrite that
// pattern into an asset reference to the FILE (Vite, webpack 5), and the folder became
// '…/index.js/'. A bundler that moves the JS still moves it away from the assets — copy
// dist/<recognizer>/ and pass assetBase (README "Serving the files").
// '' when a bundler emits CJS/IIFE and empties import.meta; the query/hash may hold a '/'
const url = (import.meta.url || '').replace(/[?#].*$/, '')
export const HERE = url.slice(0, url.lastIndexOf('/') + 1)

/** In Node there is nothing to fetch a file: URL with: say what to do instead. */
export function nodeFileUrl(url, spec) {
  // Node only: Deno and Bun can fetch a file: URL
  const g = globalThis
  const node = typeof g.process !== 'undefined' && g.process.versions && g.process.versions.node && typeof g.Deno === 'undefined' && typeof g.Bun === 'undefined'
  if (url.startsWith('file:') && node && typeof document === 'undefined' && typeof WorkerGlobalScope === 'undefined') {
    throw new Error(`millirec: cannot fetch ${url} outside a browser — in Node, import the JSON instead: import x from '${spec}' with { type: 'json' }`)
  }
}
