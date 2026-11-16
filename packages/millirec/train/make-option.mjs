// STEP 4: the folder a page loads the recognizer from.
//
//   node packages/millirec/train/make-option.mjs --run runs/digits --tag tiny --out my-digits
//
// Copies the model and its head and writes the configuration both ways the package reads one:
//   config.json   for ES modules:   MillirecCharCnn.create({ ...config, assetBase: '/my-digits/' })
//   config.js     for a script tag: <script src="/my-digits/config.js"></script> then MillirecCharCnn.create({ assetBase: '/my-digits/' })
// and index.html, a pad to try it on (serve the repository root and open /my-digits/).
//
//   --tag      the model caps.py wrote (its --tag)
//   --bits     ship the n-bit file instead of the int8 one (4 is a third of the size; caps.py
//              writes <tag>.q4.bin beside every model — best with a model trained with --qat 4)
//   --kernel   also copy the wasm kernel (cnn-web.js/.wasm, about 6 KB gzipped) and name it: the
//              network runs about 17× faster. Needs channel widths in fours (pico, nano4, tiny,
//              small, base, large) and `npm run build` first. Without it: plain JavaScript.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const has = (name) => process.argv.includes('--' + name)
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt }
const run = path.resolve(arg('run', 'runs/run')), tag = arg('tag', 'tiny'), out = path.resolve(arg('out', 'my-recognizer'))
const meta = JSON.parse(fs.readFileSync(path.join(run, 'meta.json'), 'utf8'))
const info = JSON.parse(fs.readFileSync(path.join(run, tag + '.meta.json'), 'utf8'))
const bits = arg('bits', '')
const model = bits ? `${tag}.q${bits}.bin` : `${tag}.bin`
if (!fs.existsSync(path.join(run, model))) { console.error(`no ${model} in ${run}`); process.exit(1) }
fs.mkdirSync(out, { recursive: true })
for (const f of [model, tag + '.head.bin']) fs.copyFileSync(path.join(run, f), path.join(out, f))
// single characters travel as one string (as the shipped options do); longer names as a list
const classes = meta.classes.every((c) => [...c].length === 1) && new Set(meta.classes).size === meta.classes.length && !meta.classes.some((c) => [...c][0].length > 1) ? meta.classes.join('') : meta.classes
const config = { classes, stages: [{ model, head: tag + '.head.bin', ...(info.headNorm ? {} : { headNorm: false }) }] }
if (has('kernel')) {
  const dist = path.join(HERE, '..', 'dist', 'char-cnn')
  for (const f of ['cnn-web.js', 'cnn-web.wasm']) {
    if (!fs.existsSync(path.join(dist, f))) { console.error(`--kernel needs ${path.join('packages/millirec/dist/char-cnn', f)} — run npm run build first`); process.exit(1) }
    fs.copyFileSync(path.join(dist, f), path.join(out, f))
  }
  config.kernel = 'cnn-web.js'
}
fs.writeFileSync(path.join(out, 'config.json'), JSON.stringify(config, null, 2) + '\n')
fs.writeFileSync(path.join(out, 'config.js'), `window.MILLIREC_CNN = ${JSON.stringify(config, null, 2)}\n`)
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html>
<meta charset="utf-8">
<title>${path.basename(out)}</title>
<div id="pad" style="width: 240px; height: 240px; border: 1px solid #999"></div>
<p id="out">draw one of: ${meta.classes.join(' ')}</p>
<script type="module">
  // served from the repository root after \`npm run build\`; on your own site, import from 'millirec/char-cnn' (or a CDN)
  import { MillirecCharCnn } from '/packages/millirec/dist/char-cnn/index.js'
  const here = new URL('./', location.href).href
  const config = await (await fetch(here + 'config.json')).json()
  const rec = await MillirecCharCnn.create({ ...config, assetBase: here })
  rec.attach(document.querySelector('#pad'))
  document.querySelector('#pad').addEventListener('millirec:result', (e) => {
    const r = e.detail.results || []
    if (r.length) document.querySelector('#out').textContent = r.map((x) => x.char + ' ' + Math.round(x.prob * 100) + '%').join('   ')
  })
</script>
`)
const kb = (f) => (fs.statSync(path.join(out, f)).size / 1024).toFixed(1)
console.log(`${out}: ${model} ${kb(model)} KB + ${tag}.head.bin ${kb(tag + '.head.bin')} KB${config.kernel ? ' + the wasm kernel' : ''}, config.json, config.js, index.html`)
