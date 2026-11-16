// The package's gate: dist/ loaded in headless Chrome the two ways it will be
// used —
//   * SAME ORIGIN, as ES modules (a site that installs the package and serves
//     dist/ itself);
//   * CROSS ORIGIN, by <script> tag, from a second server sending
//     Access-Control-Allow-Origin: * the way jsDelivr/unpkg do. The runtime
//     boots its worker from a blob and importScripts() the worker from the
//     asset origin, then the worker fetches the wasm, so this is the path a
//     CDN user takes.
// Each page reads drawn strokes through char-lite (digits set) and char-cnn
// (accurate), and teaches char-lite a new symbol with withSamples().
// Run after `npm run build`:  node test/verify.mjs
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch } from '../../../scripts/harness/cdp.mjs'

const PKG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
if (!fs.existsSync(path.join(PKG, 'dist/char-lite/index.js'))) { console.error('dist/ missing — run npm run build first'); process.exit(1) }

const TYPES = { '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm', '.bin': 'application/octet-stream', '.html': 'text/html; charset=utf-8' }
function serve(root, { cors = false, pages = {}, spa = null } = {}) {
  const srv = http.createServer((req, res) => {
    let url = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    // a host that labels every file text/html (some do for extensions they do not know): /mislabel/<path>
    const mislabel = url.startsWith('/mislabel/')
    if (mislabel) url = url.slice('/mislabel'.length)
    if (pages[url]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(pages[url]) }
    const file = path.join(root, url)
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // a dev server's SPA fallback: every unknown path answers with the app's index.html
      if (spa) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(spa) }
      res.writeHead(404); return res.end()
    }
    res.writeHead(200, { 'content-type': mislabel && path.extname(file) === '.bin' ? 'text/html' : TYPES[path.extname(file)] || 'application/octet-stream', ...(cors ? { 'access-control-allow-origin': '*' } : {}) })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, origin: `http://127.0.0.1:${srv.address().port}` })))
}

// Page-side checks. `api` = { CharLite, loadSet, CharCnn } however the page got them.
const CHECKS = `
const line = (x0, y0, x1, y1, n = 24) => Array.from({ length: n }, (_, i) => ({ x: x0 + (x1 - x0) * i / (n - 1), y: y0 + (y1 - y0) * i / (n - 1) }))
const zigzag = (j = 0) => [[0, 0], [20, 80], [40, 5], [60, 80], [80, 0]].flatMap(([x, y], i, a) => i ? line(a[i - 1][0] + j, a[i - 1][1], x + j, y, 8).slice(1) : [{ x: x + j, y }])
async function run(api) {
  const out = {}
  const digits = await api.loadSet('digits')
  const lite = await api.CharLite.create({ training: digits })
  out.one = await lite.recognize([line(50, 10, 52, 120)])
  out.seven = await lite.recognize([[...line(10, 10, 90, 10), ...line(90, 10, 40, 120).slice(1)]])
  const mine = api.CharLite.withSamples(digits, { '★': [[zigzag(0)], [zigzag(3)], [zigzag(-3)]] })
  out.mineLen = mine.classes['★'].samples[0].x.length
  out.pps = mine.pointsPerShape
  out.digitsUntouched = !('★' in digits.classes)
  const lite2 = await api.CharLite.create({ training: mine })
  out.star = await lite2.recognize([zigzag(1)])
  lite.destroy(); lite2.destroy()
  const cnn = await api.CharCnn.create()
  out.L = await cnn.recognize([line(20, 10, 20, 110), line(20, 110, 90, 110)])
  out.T = await cnn.recognize([line(10, 10, 90, 10), line(50, 10, 50, 110)])
  out.cnnOnly = await cnn.recognize([line(20, 10, 20, 110), line(20, 110, 90, 110)], { only: 'IT' })
  return out
}`

const esmPage = (base) => `<!doctype html><script type="module">
import { MillirecCharLite, loadSet } from '${base}/dist/char-lite/index.js'
import { MillirecCharCnn } from '${base}/dist/char-cnn/index.js'
${CHECKS}
window.__run = () => run({ CharLite: MillirecCharLite, loadSet, CharCnn: MillirecCharCnn })
// the README's bundler case: the files copied somewhere else, named by a root-relative path without its slash
window.__esmExtra = async () => {
  const out = { globals: ['MillirecCharLite', 'MillirecChar', 'MillirecCharCnn'].filter((g) => g in window) }
  const training = await loadSet('digits', { assetBase: '/dist/char-lite' })
  const lite = await MillirecCharLite.create({ training, assetBase: '/dist/char-lite' })
  out.liteRel = await lite.recognize([line(50, 10, 52, 120)]); lite.destroy()
  const cnn = await MillirecCharCnn.create({ assetBase: '/dist/char-cnn', option: 'fast' })
  out.oneStroke = await cnn.recognize([...line(20, 10, 20, 110), ...line(20, 110, 90, 110).slice(1)])   // one stroke, not [[...]]
  cnn.destroy()
  out.afterDestroy = await cnn.recognize([line(20, 10, 20, 110)])
  out.personalizeAfter = await cnn.personalize({ L: [[line(20, 10, 20, 110), line(20, 110, 90, 110)]] })
  try { await cnn.embedding([line(20, 10, 20, 110)]); out.embeddingAfter = 'no throw' } catch (e) { out.embeddingAfter = e.message }
  try { cnn.depersonalize(); out.depersonalizeAfter = 'ok' } catch (e) { out.depersonalizeAfter = e.message }
  // char-lite: a call in flight when destroy() lands, and one after it, both resolve null
  const lite2 = await MillirecCharLite.create({ training })
  const pending = lite2.recognize([line(50, 10, 52, 120)])
  lite2.destroy()
  out.litePending = await Promise.race([pending, new Promise((r) => setTimeout(() => r('timeout'), 3000))])
  out.liteAfter = await lite2.recognize([line(50, 10, 52, 120)])
  out.liteRawAfter = await lite2.rawScores([line(50, 10, 52, 120)])
  // char-lite: a worker that never answers. The call times out with null — and the SAME strokes
  // must be asked again afterwards (0.1.1 left the key "in flight" and answered null forever).
  const lite3 = await MillirecCharLite.create({ training })
  const lw = lite3.stroke.worker, post = lw.postMessage.bind(lw)
  lw.postMessage = (m) => { if (m.type !== 'compare') post(m) }
  const same = [line(30, 10, 34, 120)]
  out.stuckFirst = await lite3.recognize(same)
  lw.postMessage = post
  out.stuckAfter = await lite3.recognize(same)
  lite3.destroy()
  // the digits and lowercase options
  const dg = await MillirecCharCnn.create('digits')
  out.optDigit = await dg.recognize([line(50, 10, 52, 120)])
  out.optSeven = await dg.recognize([[...line(10, 10, 90, 10), ...line(90, 10, 40, 120).slice(1)]])
  dg.destroy()
  const lc = await MillirecCharCnn.create({ option: 'lowercase' })
  out.optO = await lc.recognize([Array.from({ length: 28 }, (_, i) => ({ x: 60 + 40 * Math.cos(i / 27 * 2 * Math.PI), y: 60 + 44 * Math.sin(i / 27 * 2 * Math.PI) }))])
  out.optV = await lc.recognize([[...line(10, 10, 50, 110), ...line(50, 110, 90, 10).slice(1)]])
  out.lcClasses = lc.classes.join('')
  lc.destroy()
  // teach(): symbols of one's own from three drawings each, no training — and forget() goes back to letters
  const taught = await MillirecCharCnn.create()
  const bolt = (j = 0) => [zigzag(j)]
  const ring = (j = 0) => [Array.from({ length: 28 }, (_, i) => ({ x: 60 + j + 40 * Math.cos(i / 27 * 2 * Math.PI), y: 60 + 44 * Math.sin(i / 27 * 2 * Math.PI) }))]
  const cross = (j = 0) => [line(20 + j, 20, 100 + j, 100), line(100 + j, 20, 20 + j, 100)]
  out.teach = await taught.teach({ bolt: [bolt(0), bolt(3), bolt(-3)], ring: [ring(0), ring(4), ring(-4)], cross: [cross(0), cross(5), cross(-5)] })
  out.taughtBolt = await taught.recognize(bolt(1))
  out.taughtRing = await taught.recognize(ring(2))
  out.taughtOnly = await taught.recognize(ring(2), { only: ['bolt', 'cross'] })
  out.taughtMore = await taught.teach({ bar: [[line(10, 60, 110, 62)], [line(12, 64, 108, 60)], [line(8, 58, 112, 58)]] }, { add: true })
  out.taughtBar = await taught.recognize([line(10, 61, 110, 61)])
  taught.forget()
  out.forgotten = await taught.recognize([line(20, 10, 20, 110), line(20, 110, 90, 110)])
  taught.destroy()
  const viaCreate = await MillirecCharCnn.create({ examples: { ring: [ring(0), ring(4)], cross: [cross(0), cross(5)] } })
  out.viaCreate = await viaCreate.recognize(cross(2))
  viaCreate.destroy()
  // a string names the option
  const fast = await MillirecCharCnn.create('fast')
  out.stringOption = await fast.recognize([line(20, 10, 20, 110), line(20, 110, 90, 110)])
  out.stringOptionStages = fast.config.stages.length
  fast.destroy()
  // files not served where assetBase says: this server answers every unknown path with index.html
  const err = async (f) => { try { await f(); return 'no error' } catch (e) { return e.message } }
  out.errSet = await err(() => loadSet('digits', { assetBase: '/nowhere/' }))
  out.errOption = await err(() => MillirecCharCnn.create({ assetBase: '/nowhere/' }))
  out.errModel = await err(() => MillirecCharCnn.create({ classes: 'AB', stages: [{ model: 'tiny.bin', head: 'tiny.head.bin' }], assetBase: '/nowhere/' }))
  out.errWorker = await err(() => MillirecCharLite.create({ training, assetBase: '/nowhere/' }))
  // a real model file under a wrong content-type still loads: the body decides, not the header
  out.mislabelled = await err(async () => { const c = await MillirecCharCnn.create({ assetBase: '/mislabel/dist/char-cnn/' }); const r = await c.recognize([line(20, 10, 20, 110), line(20, 110, 90, 110)]); c.destroy(); return Promise.reject(new Error('read ' + r[0].char)) })
  // the module imported with a '/' in its query still finds its own folder
  out.queried = await err(async () => { const m = await import('/dist/char-lite/index.js?cb=a/b'); const t = await m.loadSet('digits'); const l = await m.MillirecCharLite.create({ training: t }); const r = await l.recognize([line(50, 10, 52, 120)]); l.destroy(); return Promise.reject(new Error('read ' + r[0].char)) })
  // char-cnn/core inside a module worker: no document, so it draws on an OffscreenCanvas
  const src = "import { MillirecCharCnnCore } from '" + location.origin + "/dist/char-cnn/core.js';" +
    "const line = " + line.toString() + ";" +
    "MillirecCharCnnCore.create('fast').then((r) => r.recognize([line(20, 10, 20, 110), line(20, 110, 90, 110)])).then((x) => postMessage({ ok: x }), (e) => postMessage({ err: String(e && e.message || e) }))"
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' })
  out.inWorker = await new Promise((r) => { w.onmessage = (e) => r(e.data); w.onerror = (e) => r({ err: e.message || 'worker error' }); setTimeout(() => r({ err: 'timeout' }), 15000) })
  w.terminate()
  return out
}
window.__ready = true
</script>`

const tagPage = (base) => `<!doctype html>
<script src="${base}/dist/char-lite/millirec-char-lite.min.js"></script>
<script src="${base}/dist/char-cnn/options/accurate.js"></script>
<script src="${base}/dist/char-cnn/millirec-char-cnn.min.js"></script>
<script src="${base}/dist/overlap/millirec-overlap.min.js"></script>
<script>
// the overlap widget boots its matcher from the asset origin (script tag only)
window.__overlap = async () => { const el = document.createElement('div'); document.body.appendChild(el); const w = await MillirecOverlap.create(el, { set: 'capitals', words: ['A'] }); await (w.ready || Promise.resolve()); return !!w }
${CHECKS}
const loadSet = (name) => fetch('${base}/dist/char-lite/sets/' + name + '.json').then((r) => r.json())
window.__run = () => run({ CharLite: MillirecCharLite, loadSet, CharCnn: MillirecCharCnn })
window.__ready = true
</script>`

const cdn = await serve(PKG, { cors: true })

// THE README'S OWN PAGES, as written: every complete page in it (a ```html block that starts with
// a doctype) is served with the CDN address swapped for the local CORS server, and a digit is drawn
// on its pad. A snippet that shows nothing when pasted is the first thing a new user meets.
const README = fs.readFileSync(path.join(PKG, 'README.md'), 'utf8')
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version
const CDN_AT = 'https://cdn.jsdelivr.net/npm/millirec@'
const readmePages = [...README.matchAll(/```html\n(<!doctype html>[\s\S]*?)```/g)].map((m) => m[1])
const readmeVersions = [...new Set([...README.matchAll(/millirec@(\d+\.\d+(?:\.\d+)?)/g)].map((m) => m[1]))]
const site = await serve(PKG, { pages: { '/esm.html': esmPage(''), '/tag.html': tagPage(cdn.origin), ...Object.fromEntries(readmePages.map((html, i) => [`/readme-${i}.html`, html.replaceAll(CDN_AT + VERSION, cdn.origin)])) }, spa: '<!doctype html><title>app</title><div id="app"></div>' })

const top = (r) => (r || []).map((x) => x.char)
let fails = 0
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) fails++ }

const browser = await launch()
try {
  console.log('\nthe README')
  check(`every CDN address in the README pins this version (${VERSION})`, readmeVersions.length === 1 && readmeVersions[0] === VERSION, readmeVersions.join(', '))
  check('the README has its two complete pages (ES module, script tag)', readmePages.length === 2, String(readmePages.length))
  for (let i = 0; i < readmePages.length; i++) {
    const page = await browser.page()
    await page.goto(`${site.origin}/readme-${i}.html`)
    const hasPad = await page.waitFor(`!!document.querySelector('#pad canvas')`, 15000).then(() => true, () => false)
    // a vertical stroke down the middle of the pad: a 1
    if (hasPad) await page.eval(`(async () => {
      const c = document.querySelector('#pad canvas'), r = c.getBoundingClientRect()
      const ev = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'pen', button: 0, buttons: type === 'pointerup' ? 0 : 1, pressure: type === 'pointerup' ? 0 : 0.5, clientX: r.left + x, clientY: r.top + y }))
      ev('pointerdown', r.width / 2, r.height * 0.15)
      for (let k = 1; k <= 20; k++) { ev('pointermove', r.width / 2 + k * 0.2, r.height * (0.15 + 0.7 * k / 20)); await new Promise((f) => setTimeout(f, 8)) }
      ev('pointerup', r.width / 2 + 4, r.height * 0.85)
    })()`)
    const read = hasPad && await page.waitFor(`/^1\\b/.test(document.querySelector('#out').textContent)`, 8000).then(() => true, () => false)
    check(`README page ${i + 1} works as pasted: a pad appears and a drawn 1 is shown`, !!read, hasPad ? await page.eval(`document.querySelector('#out').textContent`) : 'no pad')
    await page.close()
  }
  for (const [label, url] of [['ESM, same origin', `${site.origin}/esm.html`], ['script tag, from a CORS origin', `${site.origin}/tag.html`]]) {
    const page = await browser.page()
    await page.goto(url)
    await page.waitFor('window.__ready === true', 15000)
    const r = await page.eval('window.__run()')
    console.log(`\n${label}`)
    check('digits: a vertical stroke reads 1', top(r.one)[0] === '1', top(r.one).join(' '))
    check('digits: a 7 reads 7 in the top three', top(r.seven).includes('7'), top(r.seven).join(' '))
    check('withSamples resamples to the set\'s points per shape', r.mineLen === r.pps, `${r.mineLen} points, set ${r.pps}`)
    check('withSamples leaves the input alone', r.digitsUntouched)
    check('a new symbol taught with three drawings reads first', top(r.star)[0] === '★', top(r.star).join(' '))
    check('cnn: L reads L', top(r.L)[0] === 'L', top(r.L).join(' '))
    check('cnn: T reads T', top(r.T)[0] === 'T', top(r.T).join(' '))
    check('cnn: only restricts the classes', top(r.cnnOnly).every((c) => 'IT'.includes(c)), top(r.cnnOnly).join(' '))
    if (label.startsWith('script')) check('overlap: the widget boots its matcher from the asset origin', await page.eval('window.__overlap()'))
    if (label.startsWith('ESM')) {
      const x = await page.eval('window.__esmExtra()')
      check('ES modules set no window globals', !x.globals.length, x.globals.join(' '))
      check('a root-relative assetBase without its slash works for loadSet and create', top(x.liteRel)[0] === '1', top(x.liteRel).join(' '))
      check('cnn reads a single stroke, not only a list of strokes', top(x.oneStroke)[0] === 'L', top(x.oneStroke).join(' '))
      check('a recognize() that timed out does not poison the same strokes', x.stuckFirst === null && top(x.stuckAfter)[0] === '1', `first ${JSON.stringify(x.stuckFirst)}, then ${top(x.stuckAfter).join(' ')}`)
check('the digits option reads a 1 and a 7', top(x.optDigit)[0] === '1' && top(x.optSeven).includes('7'), `${top(x.optDigit).join(' ')} | ${top(x.optSeven).join(' ')}`)
      check('the lowercase option reads an o and a v, among a–z', top(x.optO)[0] === 'o' && top(x.optV).includes('v') && x.lcClasses === 'abcdefghijklmnopqrstuvwxyz', `${top(x.optO).join(' ')} | ${top(x.optV).join(' ')}`)
      check('teach(): three drawings each of three made-up symbols, and each reads as itself', x.teach && x.teach.n === 9 && top(x.taughtBolt)[0] === 'bolt' && top(x.taughtRing)[0] === 'ring', `${top(x.taughtBolt).join(' ')} | ${top(x.taughtRing).join(' ')}`)
      check('teach(): `only` restricts among the taught names', top(x.taughtOnly).length === 2 && !top(x.taughtOnly).includes('ring'), top(x.taughtOnly).join(' '))
      check('teach({ add: true }) keeps the earlier symbols and reads the new one', x.taughtMore && x.taughtMore.classes.length === 4 && top(x.taughtBar)[0] === 'bar', top(x.taughtBar).join(' '))
      check('forget() goes back to the letters', top(x.forgotten)[0] === 'L', top(x.forgotten).join(' '))
      check('create({ examples }) teaches at creation', top(x.viaCreate)[0] === 'cross', top(x.viaCreate).join(' '))
      check('cnn destroy() lets go: recognize returns null after', x.afterDestroy === null)
      check('cnn personalize after destroy returns null', x.personalizeAfter === null)
      check('cnn embedding after destroy throws a clear error', x.embeddingAfter === 'millirec: recognizer destroyed', x.embeddingAfter)
      check('cnn depersonalize after destroy does not throw', x.depersonalizeAfter === 'ok', x.depersonalizeAfter)
      check('lite destroy() resolves a pending recognize with null', x.litePending === null, String(x.litePending))
      check('lite recognize/rawScores after destroy return null', x.liteAfter === null && x.liteRawAfter === null)
      check("create('fast') takes the option by name", top(x.stringOption)[0] === 'L' && x.stringOptionStages === 2, `${top(x.stringOption).join(' ')}, ${x.stringOptionStages} stages`)
      const served = (m, what, rec) => m.includes(`is not ${what}`) && m.includes('not served at') && m.includes(`node_modules/millirec/dist/${rec}/`) && m.includes('assetBase')
      check('loadSet on an SPA fallback names the URL and the fix', served(x.errSet, 'the digits training set', 'char-lite') && x.errSet.includes('/nowhere/sets/digits.json'), x.errSet)
      check('char-cnn option on an SPA fallback names the fix', served(x.errOption, 'the accurate CNN option', 'char-cnn'), x.errOption)
      check('char-cnn model file on an SPA fallback names the fix', served(x.errModel, 'a char-cnn model file', 'char-cnn'), x.errModel)
      check('char-lite worker on an SPA fallback names the fix', served(x.errWorker, 'the char-lite worker', 'char-lite'), x.errWorker)
      check('a model file served as text/html still loads', x.mislabelled === 'read L', x.mislabelled)
      check("a '/' in the module URL's query does not move the asset folder", x.queried === 'read 1', x.queried)
      check('char-cnn/core runs in a module Worker (OffscreenCanvas)', x.inWorker && x.inWorker.ok && x.inWorker.ok[0].char === 'L', JSON.stringify(x.inWorker).slice(0, 200))
    }
    const errs = page.console.filter((l) => /^(error|EXCEPTION)/.test(l))
    check('no console errors', !errs.length, errs.join(' | '))
  }
} finally {
  await browser.close()
  cdn.srv.close(); site.srv.close()
}
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed')
process.exit(fails ? 1 : 0)
