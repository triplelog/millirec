// STEP 3: how well does the trained model read the drawings it never saw?
//
//   node packages/millirec/train/score.mjs --run runs/digits --tag tiny
//
// Runs the held-out drawings through the model with the recognizer's own forward pass
// (cnnjs.mjs — the code the browser runs when there is no wasm kernel) and prints top-1 and top-3
// accuracy and what was mistaken for what. With no held-out drawings (--test 0) there is nothing
// to score: the number caps.py prints is on the drawings it trained on, and says little.
//
//   --on <run>   score on ANOTHER run's pictures instead (its held-out ones; with --all, every one):
//                the honest test of a model trained on one writer is a run made from someone else's
//                drawings. Classes are matched by name.
import fs from 'node:fs'
import path from 'node:path'
import { parseModel, parseHead, embed, unit, logits } from '../../../server/public/wordgpu/cnnjs.mjs'

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt }
const run = path.resolve(arg('run', 'runs/run')), tag = arg('tag', 'tiny')
const on = path.resolve(arg('on', run))
const own = JSON.parse(fs.readFileSync(path.join(run, 'meta.json'), 'utf8'))   // the model's classes, in its order
const meta = JSON.parse(fs.readFileSync(path.join(on, 'meta.json'), 'utf8'))
const info = JSON.parse(fs.readFileSync(path.join(run, tag + '.meta.json'), 'utf8'))
const ab = (f, dir = run) => { const b = fs.readFileSync(path.join(dir, f)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }
const model = parseModel(ab(arg('model', tag + '.bin'))), head = parseHead(ab(tag + '.head.bin'))
const size = model.size
const X = new Float32Array(ab(`images-${size}.f32`, on))
const test = meta.cells.map((c, i) => ({ ...c, i })).filter((c) => (process.argv.includes('--all') || c.split === 'test') && own.classes.includes(c.cls))
if (!test.length) { console.log('no held-out drawings to score (rasterize with --test above 0, or pass --all)'); process.exit(0) }
let top1 = 0, top3 = 0
const wrong = new Map()
const t0 = performance.now()
for (const c of test) {
  const e = embed(model, X.subarray(c.i * size * size, (c.i + 1) * size * size))
  const z = logits(head, info.headNorm ? unit(e) : e)
  const order = [...z.keys()].sort((a, b) => z[b] - z[a])
  const truth = own.classes.indexOf(c.cls)
  if (order[0] === truth) top1++
  else { const k = `${c.cls} read as ${own.classes[order[0]]}`; wrong.set(k, (wrong.get(k) || 0) + 1) }
  if (order.slice(0, 3).includes(truth)) top3++
}
const ms = (performance.now() - t0) / test.length
const top = [...wrong].sort((a, b) => b[1] - a[1])
const pct = (n) => (100 * n / test.length).toFixed(1) + '%'
console.log(`${tag} (${info.arch}, ${size}×${size}, ${(fs.statSync(path.join(run, tag + '.bin')).size / 1024).toFixed(1)} KB): ${test.length} ${on === run ? 'held-out drawings' : 'drawings from ' + path.basename(on)} — right ${pct(top1)}, in the top three ${pct(top3)}, ${ms.toFixed(2)} ms each in plain JavaScript`)
if (wrong.size) console.log('mistakes: ' + top.slice(0, 20).map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ') + (top.length > 20 ? `, and ${top.length - 20} more kinds` : ''))
