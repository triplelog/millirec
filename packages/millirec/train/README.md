# Train your own recognizer

A recognizer for **your** symbols — digits in your users' hand, a rating scale, a set of
proof-reading marks, an alphabet — is a small convolutional network trained on drawings of them.
A dozen drawings per symbol is enough to start; training takes seconds on a laptop, and the
result is a 7 KB model file that `millirec/char-cnn` loads like its own.

The four steps below make a digit recognizer from the handwriting in this folder. Run them from
the repository root.

```sh
npm install                       # esbuild, and `canvas` to draw the pictures
pip install torch numpy pillow    # the trainer
npm run build                     # packages/millirec/dist/ (the recognizer the pages load)

# 1 · drawings → pictures (a quarter of each class is held out for step 3)
node packages/millirec/train/rasterize.mjs --classes 0123456789 --out runs/digits

# 2 · train  (5 seconds)
python3 cnnlab/caps.py --dir runs/digits --folds all --headNorm --archs tiny --dim 16 --epochs 300 --batch 32 --tag tiny

# 3 · score on the drawings it never saw
node packages/millirec/train/score.mjs --run runs/digits --tag tiny

# 4 · the folder a page loads
node packages/millirec/train/make-option.mjs --run runs/digits --tag tiny --out my-digits --kernel
npx serve .                       # then open /my-digits/ and draw
```

On your page:

```js
import { MillirecCharCnn } from 'millirec/char-cnn'

const config = await (await fetch('/my-digits/config.json')).json()
const rec = await MillirecCharCnn.create({ ...config, assetBase: '/my-digits/' })
rec.attach(document.querySelector('#pad'))            // or rec.recognize(strokes)
```

## Your own drawings

`--data` takes a JSON file of strokes:

```json
{ "classes": {
    "star":  [ [ [[12, 80], [40, 5], [68, 80], [2, 30], [78, 30], [12, 80]] ], … ],
    "heart": [ … ]
} }
```

A class is a list of drawings, a drawing a list of strokes, a stroke a list of `[x, y]` (or
`{x, y}`) points. Class names are any strings. The pad gives you drawings in this shape:
`pad.getStrokes()`, or `e.detail.strokes` from the `millirec:result` event — collect them on a
page of your own and save the JSON.

```sh
node packages/millirec/train/rasterize.mjs --data my-drawings.json --out runs/mine
```

Draw each symbol the ways people really draw it (both stroke orders of an X, the open and the
closed 4). The network only ever sees the finished picture, so stroke order and direction do not
matter; shape and proportion do.

## What to expect

Measured on this folder's handwriting (`data/handwriting.json`: one writer, 68 classes, 903
drawings — about twelve of each), a quarter held out, 300 epochs:

| set | model | held-out drawings read right | in the top three | file | training time |
|---|---|---|---|---|---|
| digits (10) | `tiny` | 100% of 32 | 100% | 6.8 KB | 5 s |
| capitals (26) | `tiny` | 95.0% of 80 | 100% | 6.8 KB | 11 s |
| capitals (26) | `base` | 100% of 80 | 100% | 36 KB | 48 s |
| everything (68) | `tiny` | 89.8% of 226 | 99.1% | 6.8 KB | 33 s |
| everything (68) | `base` | 94.7% of 226 | 99.1% | 36 KB | 2 min 40 s |

Read these for what they are: **one writer, tested on that same writer's other drawings.** A
recognizer for many hands needs many hands in its training — the capital-letter models that ship
in the package were trained on 2,400 drawings per letter from hundreds of writers (EMNIST) and
read 96–98.5% of strangers' letters. What is left wrong in the 68-class set is mostly what no
picture can settle: `0`/`O`, `l`/`1`, `S`/`s` — the same ink at a different size.

## Choosing a model

`--archs` picks the network; the picture size is part of it.

| | picture | int8 file | notes |
|---|---|---|---|
| `pico` | 20×20 | ~3 KB | the size floor |
| `tiny` | 24×24 | 7 KB | the default: fast in plain JavaScript (under 1 ms) |
| `small` | 32×32 | 17 KB | |
| `base` | 32×32 | 37 KB | the accurate one; about 15 ms in plain JavaScript, under 1 ms with the wasm kernel |

Useful options of `cnnlab/caps.py`:

- `--epochs`: 300 suits a few hundred drawings; with thousands per class, 15–30.
- `--dim 16`: the width of the layer before the answer. 16 is enough for a model that only has to
  name the class and makes the file smaller; the default 64 is for larger sets.
- `--headNorm`: needed for `--kernel` (the wasm kernel hands back a normalised vector). Keep it on.
- `--qat 4 --export-bits 4`: train for 4-bit weights; then `make-option.mjs --bits 4` ships a file
  about half the size at nearly the same accuracy (worth it for `base`, not for `tiny`).
- `--seed`: a different random start.

`make-option.mjs --kernel` adds the WebAssembly kernel (two files, about 6 KB gzipped) and runs
the network roughly 17× faster; without it the recognizer is plain JavaScript and needs nothing
else. Two models can run as a cascade — a small one first, a larger one for the close calls —
which is how the package's `accurate` option is built; write the two `stages` and a `theta` into
`config.json` by hand (see `library/templates/char-cnn/options/accurate/config.js`).

## What is in this folder

| | |
|---|---|
| `rasterize.mjs` | drawings → training pictures, through the recognizer's own drawing code |
| `score.mjs` | held-out accuracy and the list of mistakes, through the recognizer's own forward pass |
| `make-option.mjs` | the folder a page loads: model, head, `config.json` / `config.js`, a pad to try it |
| `data/handwriting.json` | one writer's drawings of 68 characters: `A–Z`, `a–z`, `0–9` and `' , - . / :` |
| `../../../cnnlab/caps.py` | the trainer (PyTorch); `embed.py` is its model and augmentation, `export.py` writes the model files |

The handwriting is MIT licensed with the rest of the repository: use it, add your own to it,
train on the two together.
