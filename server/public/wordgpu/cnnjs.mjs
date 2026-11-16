// The int8 CNN (cnnlab/export.py's MRCNN1 file) run in plain JavaScript.
//
// cnnlab/cnn.cpp is the production kernel. This is the SAME model, the same
// arithmetic (3x3 same-padded conv + bias + ReLU, 2x2 max pool where the file
// says so, global average pool, one linear), in JS — so a page can score a
// character with no wasm at all, and so the softmax HEAD, which the kernel does
// not carry (it L2-normalises the embedding and returns it), can be applied to
// the un-normalised embedding it needs. tuning/caps-cnn.cjs gates the two
// against each other: cosine between this embedding and the kernel's must be
// ~1 on every cell before any number from either is reported.
//
// Weights are dequantised at parse time (int8 x per-output-channel scale ->
// f32), which is what the kernel does on load too.

// MRCNN1 = int8 weights (the kernel's format); MRCNN3/4/5/6 = the same layout
// with n-bit two's-complement weights packed LSB-first (export.py packbits);
// JS-only — the kernel reads MRCNN1
const BITS_OF = { MRCNN1: 8, MRCNN3: 3, MRCNN4: 4, MRCNN5: 5, MRCNN6: 6 }

function reader(buf) {
  const dv = new DataView(buf.buffer ? buf.buffer : buf, buf.byteOffset || 0, buf.byteLength)
  const u8 = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)
  let o = 0
  return {
    u32: () => { const v = dv.getUint32(o, true); o += 4; return v },
    f32s: (n) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) { a[i] = dv.getFloat32(o, true); o += 4 } return a },
    i8s: (n) => { const a = new Int8Array(n); for (let i = 0; i < n; i++) a[i] = (u8[o + i] << 24) >> 24; o += n; return a },
    // n-bit two's-complement fields packed LSB-first, padded to a whole byte
    ibits: (n, bits) => {
      if (bits === 8) { const a = new Int8Array(n); for (let i = 0; i < n; i++) a[i] = (u8[o + i] << 24) >> 24; o += n; return a }
      const a = new Int8Array(n), mask = (1 << bits) - 1, sign = 1 << (bits - 1)
      for (let i = 0; i < n; i++) {
        const bp = i * bits, byte = o + (bp >> 3), sh = bp & 7
        let v = (u8[byte] | (u8[byte + 1] << 8)) >> sh & mask
        a[i] = v & sign ? v - (1 << bits) : v
      }
      o += (n * bits + 7) >> 3
      return a
    },
    str: (n) => { const s = String.fromCharCode(...u8.subarray(o, o + n)); o += n; return s },
    done: () => o >= dv.byteLength,
  }
}

/** A linear block (u32 out,in; f32 scale[out], bias[out]; i8 w[out*in]) -> dequantised. */
function readLinear(r, bits = 8) {
  const out = r.u32(), inn = r.u32()
  const scale = r.f32s(out), bias = r.f32s(out), q = r.ibits(out * inn, bits)
  const w = new Float32Array(out * inn)
  for (let o = 0; o < out; o++) for (let i = 0; i < inn; i++) w[o * inn + i] = q[o * inn + i] * scale[o]
  return { out, in: inn, w, bias }
}

/** model.bin -> { size, dim, convs: [{cout, cin, k, pool, w, bias}], lin } */
export function parseModel(buf) {
  const r = reader(buf)
  const magic = r.str(6)
  const bits = BITS_OF[magic]
  if (!bits) throw new Error('not an MRCNN1/3/4/5/6 model')
  const version = r.u32()
  if (version !== 1) throw new Error('unknown model version ' + version)
  const size = r.u32(), dim = r.u32(), nConv = r.u32()
  const convs = []
  for (let L = 0; L < nConv; L++) {
    const cout = r.u32(), cin = r.u32(), k = r.u32(), pool = r.u32()
    const scale = r.f32s(cout), bias = r.f32s(cout), q = r.ibits(cout * cin * k * k, bits)
    const w = new Float32Array(q.length)
    const per = cin * k * k
    for (let o = 0; o < cout; o++) for (let i = 0; i < per; i++) w[o * per + i] = q[o * per + i] * scale[o]
    convs.push({ cout, cin, k, pool, w, bias })
  }
  const lin = readLinear(r, bits)
  return { size, dim, convs, lin, bits }
}

/** An n-bit model file -> the same model as MRCNN1 bytes (int8 weights at the
 *  n-bit LEVELS, scale unchanged), so the wasm kernel can serve a 3/4/5/6-bit
 *  file: ship the small file, expand at load. An int8 file is returned as is. */
export function expandToInt8(buf) {
  const u8 = new Uint8Array(buf.buffer ? buf.buffer : buf, buf.byteOffset || 0, buf.byteLength)
  const magic = String.fromCharCode(...u8.subarray(0, 6))
  const bits = BITS_OF[magic]
  if (!bits) throw new Error('not an MRCNN model')
  if (bits === 8) return u8
  const r = reader(buf)
  r.str(6)
  const version = r.u32(), size = r.u32(), dim = r.u32(), nConv = r.u32()
  const parts = []
  const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b }
  const f32s = (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
  parts.push(new TextEncoder().encode('MRCNN1'), u32(version), u32(size), u32(dim), u32(nConv))
  for (let L = 0; L < nConv; L++) {
    const cout = r.u32(), cin = r.u32(), k = r.u32(), pool = r.u32()
    const scale = r.f32s(cout), bias = r.f32s(cout), q = r.ibits(cout * cin * k * k, bits)
    parts.push(u32(cout), u32(cin), u32(k), u32(pool), f32s(scale), f32s(bias), new Uint8Array(q.buffer, q.byteOffset, q.length))
  }
  const out = r.u32(), inn = r.u32()
  const scale = r.f32s(out), bias = r.f32s(out), q = r.ibits(out * inn, bits)
  parts.push(u32(out), u32(inn), f32s(scale), f32s(bias), new Uint8Array(q.buffer, q.byteOffset, q.length))
  const total = parts.reduce((a, p) => a + p.length, 0)
  const res = new Uint8Array(total)
  let o = 0
  for (const p of parts) { res.set(p, o); o += p.length }
  return res
}

/** head.bin (one linear block) -> { out, in, w, bias } */
export function parseHead(buf) {
  return readLinear(reader(buf))
}

function conv3(c, inp, res, out) {
  const { cout, cin, k, w, bias } = c
  const plane = res * res, half = (k - 1) >> 1, per = cin * k * k
  for (let co = 0; co < cout; co++) {
    const ob = co * plane, b = bias[co], wb = co * per
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        let s = b
        for (let ci = 0; ci < cin; ci++) {
          const ib = ci * plane, wc = wb + ci * k * k
          for (let ky = 0; ky < k; ky++) {
            const yy = y + ky - half
            if (yy < 0 || yy >= res) continue
            const row = ib + yy * res, wr = wc + ky * k
            for (let kx = 0; kx < k; kx++) {
              const xx = x + kx - half
              if (xx < 0 || xx >= res) continue
              s += w[wr + kx] * inp[row + xx]
            }
          }
        }
        out[ob + y * res + x] = s > 0 ? s : 0
      }
    }
  }
}

function pool2(inp, res, ch, out) {
  const r2 = res >> 1
  for (let c = 0; c < ch; c++) {
    const ib = c * res * res, ob = c * r2 * r2
    for (let y = 0; y < r2; y++) for (let x = 0; x < r2; x++) {
      const i0 = ib + 2 * y * res + 2 * x
      const a = inp[i0], b = inp[i0 + 1], d = inp[i0 + res], e = inp[i0 + res + 1]
      out[ob + y * r2 + x] = Math.max(a, b, d, e)
    }
  }
}

/** size*size ink raster (0..1, the normalizeInk output) -> UN-normalised
 *  embedding (Float32Array dim). L2-normalise it for cosine kNN (`unit`), or
 *  hand it to `logits` for the softmax head. */
export function embed(model, img) {
  const S = model.size
  let cur = Float32Array.from(img), res = S, ch = 1
  for (const c of model.convs) {
    const out = new Float32Array(c.cout * res * res)
    conv3(c, cur, res, out)
    cur = out; ch = c.cout
    if (c.pool) {
      const p = new Float32Array(ch * (res >> 1) * (res >> 1))
      pool2(cur, res, ch, p)
      cur = p; res >>= 1
    }
  }
  const plane = res * res
  const gap = new Float32Array(ch)
  for (let c = 0; c < ch; c++) { let s = 0; for (let j = 0; j < plane; j++) s += cur[c * plane + j]; gap[c] = s / plane }
  const { lin } = model
  const e = new Float32Array(lin.out)
  for (let o = 0; o < lin.out; o++) { let s = lin.bias[o]; for (let j = 0; j < lin.in; j++) s += lin.w[o * lin.in + j] * gap[j]; e[o] = s }
  return e
}

/** The prefix of the network: run convs until `nPools` pools have happened
 *  and return the global average pool of that feature map — what an early-exit
 *  head (cnnlab/caps.py --auxAfter) reads. Returns { gap, layers } where
 *  `layers` is how many conv layers ran (for cost accounting). */
export function embedPartial(model, img, nPools) {
  const S = model.size
  let cur = Float32Array.from(img), res = S, ch = 1, pools = 0, layers = 0
  for (const c of model.convs) {
    const out = new Float32Array(c.cout * res * res)
    conv3(c, cur, res, out)
    cur = out; ch = c.cout; layers++
    if (c.pool) {
      const p = new Float32Array(ch * (res >> 1) * (res >> 1))
      pool2(cur, res, ch, p)
      cur = p; res >>= 1; pools++
      if (pools === nPools) break
    }
  }
  const plane = res * res
  const gap = new Float32Array(ch)
  for (let c = 0; c < ch; c++) { let s = 0; for (let j = 0; j < plane; j++) s += cur[c * plane + j]; gap[c] = s / plane }
  return { gap, layers }
}

export function unit(e) {
  let n = 0
  for (let i = 0; i < e.length; i++) n += e[i] * e[i]
  n = 1 / (Math.sqrt(n) + 1e-9)
  const out = new Float32Array(e.length)
  for (let i = 0; i < e.length; i++) out[i] = e[i] * n
  return out
}

/** head applied to relu(embedding) -> logits */
export function logits(head, e) {
  const out = new Float32Array(head.out)
  for (let o = 0; o < head.out; o++) {
    let s = head.bias[o]
    for (let j = 0; j < head.in; j++) { const v = e[j]; if (v > 0) s += head.w[o * head.in + j] * v }
    out[o] = s
  }
  return out
}

export function softmax(z) {
  let m = -Infinity
  for (const v of z) if (v > m) m = v
  const out = new Float32Array(z.length)
  let s = 0
  for (let i = 0; i < z.length; i++) { out[i] = Math.exp(z[i] - m); s += out[i] }
  for (let i = 0; i < z.length; i++) out[i] /= s
  return out
}

/**
 * Cosine kNN class scores, the matcher's own combination: per class
 * best^2 x second (0.9 x best^3 with one template). `T` is nTemplates x dim
 * unit rows, `classOf[i]` the class index of row i. Returns Float64Array of
 * class scores (Infinity for a class with no template); lower is better.
 */
export function knnScores(q, T, classOf, nClasses, dim) {
  const best = new Float64Array(nClasses).fill(Infinity), second = new Float64Array(nClasses).fill(Infinity)
  const n = T.length / dim
  for (let s = 0; s < n; s++) {
    let dot = 0
    const to = s * dim
    for (let d = 0; d < dim; d++) dot += q[d] * T[to + d]
    const dist = 1 - dot, c = classOf[s]
    if (dist < best[c]) { second[c] = best[c]; best[c] = dist } else if (dist < second[c]) second[c] = dist
  }
  const out = new Float64Array(nClasses)
  for (let c = 0; c < nClasses; c++) {
    out[c] = !(best[c] < Infinity) ? Infinity : second[c] < Infinity ? best[c] * best[c] * second[c] : 0.9 * best[c] ** 3
  }
  return out
}

/** Draw strokes ([[{x,y}...],...]) onto a 2-D context as the CNN arms see ink:
 *  the glyph fit into a `box`-px square with a round-capped line `lw` wide.
 *  ONE rasteriser for node (tuning/caps-cnn.cjs) and the page. */
export function drawStrokes(ctx, strokes, box = 120, lw = 7, pad = 10) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of strokes) for (const p of s) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const sc = box / Math.max(maxX - minX, maxY - minY, 1)
  const W = box + 2 * pad
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, W, W)
  ctx.strokeStyle = '#000'
  ctx.lineWidth = lw
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const s of strokes) {
    if (s.length < 2) continue
    ctx.beginPath()
    ctx.moveTo((s[0].x - minX) * sc + pad, (s[0].y - minY) * sc + pad)
    for (let i = 1; i < s.length; i++) ctx.lineTo((s[i].x - minX) * sc + pad, (s[i].y - minY) * sc + pad)
    ctx.stroke()
  }
  return W
}

/** RGBA canvas pixels -> ink plane (1 = ink) */
export function inkPlane(data, W, H) {
  const ink = new Float32Array(W * H)
  for (let i = 0, p = 0; i < ink.length; i++, p += 4) ink[i] = 1 - (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) / 255
  return ink
}
