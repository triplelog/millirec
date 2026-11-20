// The package IN A BROWSER, as a consumer loads it: dist/ served over HTTP, the entry imported as an ES
// module, cleanPage run on a synthetic photo (clean/wasm/test/synthetic.mjs — a ruled page with
// handwriting-like squiggles, no private data). test/verify.mjs only imports the bundles in Node, which
// cannot catch a worker or an asset that does not resolve. Needs Google Chrome (scripts/harness/cdp.mjs).
//
//   node test/browser.mjs        (npm test runs it after verify.mjs)
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch } from '../../../scripts/harness/cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(HERE, '..', 'dist')
const SYNTH = path.join(HERE, '..', '..', '..', 'clean', 'wasm', 'test', 'synthetic.mjs')
const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' }
const PAGE = '<!doctype html><meta charset="utf-8"><title>millirec-clean test</title><body>test</body>'

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0])
  let file = null
  if (url === '/' || url === '/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE) }
  if (url === '/synthetic.mjs') file = SYNTH
  else if (url.startsWith('/dist/')) file = path.join(DIST, url.slice(6))
  else if (url.startsWith('/spa/')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE) }   // an SPA fallback
  if (!file || !file.startsWith(path.dirname(DIST)) && file !== SYNTH || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found') }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`

let fails = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) fails++ }

const b = await launch()
try {
  const p = await b.page()
  await p.goto(BASE + '/')
  // Everything below runs in the page. Results come back as plain JSON.
  const r = await p.eval(`(async () => {
    const logs = []
    for (const k of ['log', 'info', 'debug']) { const f = console[k].bind(console); console[k] = (...a) => { logs.push(a.map(String).join(' ').slice(0, 120)); f(...a) } }
    const M = await import('/dist/index.mjs')
    const { makeSample } = await import('/synthetic.mjs')
    M.setWasmAssetBase('/dist/assets/')
    const s = makeSample()
    const out = {}
    const reject = async (fn, ms = 15000) => { const t0 = performance.now(); try { await Promise.race([fn(), new Promise((_, no) => setTimeout(() => no(new Error('TIMEOUT')), ms))]); return { ok: true } } catch (e) { return { ok: false, name: e.name, msg: String(e.message || e), ms: Math.round(performance.now() - t0) } } }

    let t0 = performance.now()
    const page = await M.cleanPage(s.data, s.width, s.height)
    out.clean = { ms: Math.round(performance.now() - t0), recs: page.recs.length, usable: page.recs.filter((w) => w.status !== 'empty' && w.smooth).length, targetXh: page.targetXh, pageW: page.pass.pageW, pageH: page.pass.pageH,
      boxesInPage: page.recs.every((w) => w.box.x >= 0 && w.box.y >= 0 && w.box.x + w.box.w <= page.pass.pageW + 1 && w.box.y + w.box.h <= page.pass.pageH + 1), photo: s.width + '×' + s.height }
    out.logs = logs.slice()

    const img = new ImageData(new Uint8ClampedArray(s.data), s.width, s.height)
    t0 = performance.now()
    const page2 = await M.cleanPage(img)
    out.imageData = { ms: Math.round(performance.now() - t0), recs: page2.recs.length }

    out.wrongSize = await reject(() => M.cleanPage(new Uint8ClampedArray(400), 100, 100))
    out.zero = await reject(() => M.cleanPage(new Uint8ClampedArray(0), 0, 0))
    out.notPixels = await reject(() => M.cleanPage([1, 2, 3], 1, 1))
    out.huge = await reject(() => M.cleanPage(new Uint8ClampedArray(4), 20000, 20000))

    M.setWorkerUrl('/nowhere/worker.mjs')
    out.badWorker = await reject(() => M.cleanPage(s.data, s.width, s.height))
    M.setWorkerUrl('/dist/worker.mjs')

    M.setWasmAssetBase('/spa/')
    out.spaAssets = await reject(() => M.cleanPage(s.data, s.width, s.height))
    M.setWasmAssetBase('/missing/')
    out.missingAssets = await reject(() => M.cleanPage(s.data, s.width, s.height))
    M.setWasmAssetBase('/dist/assets/')
    out.recovers = (await M.cleanPage(s.data, s.width, s.height)).recs.length
    return out
  })()`)

  check('cleanPage reads the synthetic page in a browser', r.clean.recs > 5 && r.clean.usable > 5 && r.clean.targetXh > 0, JSON.stringify(r.clean))
  check('word boxes are in the flattened page\'s coordinates (pass.pageW × pass.pageH)', r.clean.boxesInPage)
  check('a page cleaned with debug off writes nothing to the console', r.logs.length === 0, r.logs.slice(0, 3).join(' | '))
  check('cleanPage(imageData) is accepted whole', r.imageData.recs === r.clean.recs, JSON.stringify(r.imageData))
  check('pixels of the wrong size are a RangeError, not an empty page', !r.wrongSize.ok && r.wrongSize.name === 'RangeError', JSON.stringify(r.wrongSize))
  check('a zero-sized image is a RangeError', !r.zero.ok && r.zero.name === 'RangeError', JSON.stringify(r.zero))
  check('pixels that are not a typed array are a TypeError', !r.notPixels.ok && r.notPixels.name === 'TypeError', JSON.stringify(r.notPixels))
  check('a photo over the pixel limit is refused before it is copied', !r.huge.ok && /downscale/.test(r.huge.msg), JSON.stringify(r.huge))
  check('a worker that cannot load rejects quickly and says how to fix it', !r.badWorker.ok && r.badWorker.msg !== 'TIMEOUT' && r.badWorker.ms < 10000 && /setWorkerUrl/.test(r.badWorker.msg), JSON.stringify(r.badWorker))
  check('an SPA fallback in place of the WASM rejects quickly', !r.spaAssets.ok && r.spaAssets.msg !== 'TIMEOUT' && r.spaAssets.ms < 10000, JSON.stringify(r.spaAssets))
  check('missing WASM assets reject quickly', !r.missingAssets.ok && r.missingAssets.msg !== 'TIMEOUT' && r.missingAssets.ms < 10000, JSON.stringify(r.missingAssets))
  check('after those failures, the next cleanPage works', r.recovers === r.clean.recs)
  console.log(`  cleanPage: ${r.clean.ms} ms on a ${r.clean.pageW}×${r.clean.pageH} page (first call, includes the worker and WASM start)`)
} finally {
  await b.close()
  server.close()
}
if (fails) { console.log(`\n${fails} browser check(s) FAILED`); process.exit(1) }
console.log('\nall browser checks passed')
