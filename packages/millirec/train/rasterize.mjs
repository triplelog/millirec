// STEP 1 of training a recognizer: drawings → the pictures the network is trained on.
//
//   node packages/millirec/train/rasterize.mjs --classes 0123456789 --out runs/digits
//   node packages/millirec/train/rasterize.mjs --data my-drawings.json --out runs/mine
//
// Each drawing is drawn and normalised by the SAME code the recognizer runs on a visitor's
// strokes in the browser (cnnjs.drawStrokes → cnnprep.normalizeInk), so the network trains on
// exactly what it will be shown. Output, in --out:
//   meta.json          { classes, cells: [{ cls, split: 'train' | 'test' }] }
//   images-<n>.f32     one n×n float32 picture per cell, for n = 20, 24 and 32 (the sizes the
//                      architectures in cnnlab/caps.py read)
//
//   --data     a strokes file (default: data/handwriting.json beside this script).
//              { "classes": { "<name>": [ drawing, … ] } } — a drawing is a list of strokes, a
//              stroke a list of [x, y] or {x, y} points. Class names are any strings: letters,
//              digits, emoji, 'star'. The pad's getStrokes() gives a drawing in this shape.
//   --classes  which classes to take: a string of single characters ("ABC"), or a comma list
//              ("star,heart"). Default: every class in the file.
//   --test     fraction of each class held out for scoring (default 0.25; at least one drawing
//              when the class has three or more). Held-out drawings are never trained on.
//   --seed     which drawings are held out (default 1)
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { drawStrokes, inkPlane } from '../../../server/public/wordgpu/cnnjs.mjs'
import { normalizeInk } from '../../../server/public/wordgpu/cnnprep.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt }
let createCanvas
try { ({ createCanvas } = createRequire(import.meta.url)('canvas')) } catch { console.error('this step draws with the `canvas` package — run `npm install` at the repository root'); process.exit(1) }

const file = path.resolve(arg('data', path.join(HERE, 'data/handwriting.json')))
const out = path.resolve(arg('out', 'runs/run'))
const data = JSON.parse(fs.readFileSync(file, 'utf8'))
const all = data.classes || data
const want = arg('classes', '')
const classes = !want ? Object.keys(all) : want.includes(',') ? want.split(',').map((s) => s.trim()).filter(Boolean) : [...want]
const missing = classes.filter((c) => !Array.isArray(all[c]) || !all[c].length)
if (missing.length) { console.error(`no drawings for: ${missing.join(' ')}   (the file has: ${Object.keys(all).join(' ')})`); process.exit(1) }
const testFrac = Number(arg('test', 0.25))

// a small seeded shuffle, so a run can be repeated
let seed = Number(arg('seed', 1)) >>> 0
const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const cells = []
for (const cls of classes) {
  const drawings = all[cls].map((d) => (Array.isArray(d[0]) && typeof d[0][0] === 'number' ? [d] : d)   // one stroke given bare
    .map((s) => s.map((p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : { x: p.x, y: p.y }))).filter((s) => s.length > 1)).filter((d) => d.length)
  const order = drawings.map((_, i) => i).sort(() => rnd() - 0.5)
  const nTest = drawings.length >= 3 ? Math.max(1, Math.round(drawings.length * testFrac)) : 0
  order.forEach((i, k) => cells.push({ cls, split: testFrac > 0 && k < nTest ? 'test' : 'train', strokes: drawings[i] }))
}

const W = 140, cv = createCanvas(W, W), ctx = cv.getContext('2d')
fs.mkdirSync(out, { recursive: true })
for (const size of [20, 24, 32]) {
  const X = new Float32Array(cells.length * size * size)
  cells.forEach((c, i) => {
    drawStrokes(ctx, c.strokes)
    X.set(normalizeInk(inkPlane(ctx.getImageData(0, 0, W, W).data, W, W), W, W, size, Math.round(size * 0.75)), i * size * size)
  })
  fs.writeFileSync(path.join(out, `images-${size}.f32`), Buffer.from(X.buffer))
}
fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify({ classes, cells: cells.map((c) => ({ cls: c.cls, split: c.split })), source: path.basename(file) }))
const n = (s) => cells.filter((c) => c.split === s).length
console.log(`${classes.length} classes, ${n('train')} drawings to train on, ${n('test')} held out → ${out}`)
