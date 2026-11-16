"""
model.npz -> cnnlab/model.bin, the int8 file the wasm kernel loads.

Two transforms, both standard and both exact-at-inference:

  FOLD    every conv is followed by BatchNorm, which at inference is an affine
          per channel. w' = w * g/sqrt(v+eps), b' = (b-m)*g/sqrt(v+eps) + beta.
          After folding there is no BN at runtime, which is where the "39344
          params at inference" figure in the README comes from.

  QUANT   weights to int8 with a PER-OUTPUT-CHANNEL scale (max|w|/127).
          Per-channel rather than per-tensor because a single scale across a
          conv whose channels differ in magnitude by 10x throws away most of
          the range on the small ones. Activations stay f32: int8 activations
          need calibration and requantisation at every layer, and the file size
          argument is already won by the weights alone.

Layout (little-endian), read by cnn.cpp:

  magic 'MRCNN1'  u32 version=1
  u32 size, u32 dim, u32 nConv
  per conv:  u32 cout, cin, k, pool     f32 scale[cout], bias[cout]   i8 w[cout*cin*k*k]
  linear:    u32 out, in                f32 scale[out],  bias[out]    i8 w[out*in]
"""

import json
import os
import struct
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'cnnlab'))
from embed import ARCHES, make_model            # noqa: E402


def quant(w, bits=8, rule='max'):
    """intN per output channel (N in 3..8). Returns (int8 [cout,...], f32 scale[cout]).
    rule 'max': scale = max|w|/lim (what quantisation-aware training assumes);
    rule 'mse': per-channel search of 12 scale multipliers for least squared
    error — better post-training at low bit widths (cnnlab/requant4.py)."""
    flat = w.reshape(w.shape[0], -1).astype(np.float64)
    lim = float(2 ** (bits - 1) - 1)
    mx = np.abs(flat).max(axis=1)
    if rule == 'mse' and bits < 8:
        q = np.zeros_like(flat, np.int8)
        scales = np.zeros(flat.shape[0], np.float32)
        for c in range(flat.shape[0]):
            row = flat[c]
            if mx[c] == 0:
                scales[c] = 1e-8
                continue
            best = None
            for mult in np.linspace(0.45, 1.0, 12):
                sc = mx[c] * mult / lim
                qq = np.clip(np.round(row / sc), -lim, lim)
                err = float(((qq * sc - row) ** 2).sum())
                if best is None or err < best[0]:
                    best = (err, sc, qq)
            scales[c] = best[1]
            q[c] = best[2].astype(np.int8)
        return q.reshape(w.shape), scales
    s = mx / lim
    s[s == 0] = 1e-8
    q = np.clip(np.round(flat / s[:, None]), -lim, lim).astype(np.int8)
    return q.reshape(w.shape), s.astype(np.float32)


def packbits(q, bits):
    """int8 values -> a bitstream of `bits`-bit two's-complement fields, LSB first,
    padded to a whole byte. bits=8 is the plain int8 bytes."""
    if bits == 8:
        return q.astype(np.int8).tobytes()
    v = (q.reshape(-1).astype(np.int32) & ((1 << bits) - 1)).astype(np.uint64)
    n = len(v)
    out = np.zeros((n * bits + 7) // 8, np.uint8)
    # bit positions of each value's LSB
    pos = np.arange(n, dtype=np.uint64) * np.uint64(bits)
    for b in range(bits):
        bit = ((v >> np.uint64(b)) & np.uint64(1)).astype(np.uint8)
        p = pos + np.uint64(b)
        np.bitwise_or.at(out, (p >> np.uint64(3)).astype(np.int64), (bit << (p & np.uint64(7)).astype(np.uint8)).astype(np.uint8))
    return out.tobytes()


def pack4(q):
    return packbits(q, 4)


MAGIC_FOR_BITS = {8: b'MRCNN1', 3: b'MRCNN3', 4: b'MRCNN4', 5: b'MRCNN5', 6: b'MRCNN6'}


def fold_convs(model, nn):
    """[(w f32, b f32, pool)] with BatchNorm folded into each conv."""
    # walk `f` in order: each blk is (Conv2d, BatchNorm2d, ReLU); MaxPool2d
    # between stages; AdaptiveAvgPool2d + Flatten at the end
    convs = []
    pend = None
    for m in model.f:
        if isinstance(m, nn.Sequential):
            conv, bn = m[0], m[1]
            g = bn.weight.detach().numpy()
            beta = bn.bias.detach().numpy()
            mean = bn.running_mean.numpy()
            var = bn.running_var.numpy()
            f = g / np.sqrt(var + bn.eps)
            w = conv.weight.detach().numpy() * f[:, None, None, None]
            b = (conv.bias.detach().numpy() - mean) * f + beta
            if pend is not None:
                convs.append(pend)
            pend = [w.astype(np.float32), b.astype(np.float32), 0]
        elif isinstance(m, nn.MaxPool2d) and pend is not None:
            pend[2] = 1                                     # pool AFTER this conv
    if pend is not None:
        convs.append(pend)
    return convs


def linear_block(w, b):
    """u32 out,in  f32 scale[out], bias[out]  i8 w[out*in] — the file's linear layout."""
    q, s = quant(w)
    return (struct.pack('<II', w.shape[0], w.shape[1]) + s.tobytes()
            + b.astype(np.float32).tobytes() + q.tobytes()), q.size


def write_bin(model, nn, size, dim, path, verbose=True, bits=8, rule='max'):
    """model -> the int8 file cnn.cpp loads (convs folded + quantised, then the
    embedding linear). bits in {3,4,5,6} write the same layout with packed
    n-bit weights under magic MRCNN<n> — read by cnnjs.mjs only (the kernel
    reads MRCNN1). Returns (bytes written, weight count)."""
    convs = fold_convs(model, nn)
    out = bytearray()
    out += MAGIC_FOR_BITS[bits] + struct.pack('<I', 1)
    out += struct.pack('<III', size, dim, len(convs))
    total = 0
    for w, b, pool in convs:
        cout, cin, k, _ = w.shape
        q, s = quant(w, bits, rule)
        out += struct.pack('<IIII', cout, cin, k, pool)
        out += s.tobytes() + b.astype(np.float32).tobytes() + packbits(q, bits)
        total += q.size
        if verbose:
            print(f'  conv {cin:3d}->{cout:3d} k{k} pool{pool}  {q.size} weights')
    lw = model.emb.weight.detach().numpy()
    lb = model.emb.bias.detach().numpy()
    q, s = quant(lw, bits, rule)
    out += struct.pack('<II', lw.shape[0], lw.shape[1]) + s.tobytes() + lb.astype(np.float32).tobytes()
    out += packbits(q, bits)
    total += q.size
    if verbose:
        print(f'  linear {lw.shape[1]}->{lw.shape[0]}  {q.size} weights')
    open(path, 'wb').write(bytes(out))
    return len(out), total


def write_head(model, path):
    """The softmax head (Linear dim -> classes, applied to relu(embedding)) as
    one linear block — a sidecar the kernel never reads; the pure-JS forward
    (server/public/wordgpu/cnnjs.mjs) does, for a template-free arm."""
    blk, n = linear_block(model.head.weight.detach().numpy(), model.head.bias.detach().numpy())
    open(path, 'wb').write(blk)
    return len(blk)


def main():
    import torch
    import torch.nn as nn

    src = sys.argv[1] if len(sys.argv) > 1 else 'model.npz'
    dst = sys.argv[2] if len(sys.argv) > 2 else src.replace('.npz', '.bin')
    z = np.load(os.path.join(ROOT, 'cnnlab', src), allow_pickle=True)
    arch = str(z['arch'])
    dim = int(z['dim'])
    classes = [str(c) for c in z['classes']]
    size = ARCHES[arch][0]

    model = make_model(torch, nn, len(classes), dim, arch)
    model.load_state_dict({k: torch.from_numpy(z[k]) for k in model.state_dict()})
    model.eval()

    convs = fold_convs(model, nn)
    p = os.path.join(ROOT, 'cnnlab', dst)
    nbytes, total_i8 = write_bin(model, nn, size, dim, p)
    print(f'wrote {os.path.relpath(p, ROOT)}: {nbytes} bytes '
          f'({total_i8} int8 weights + {nbytes - total_i8} bytes of scales/bias/header)')

    # what quantisation costs, measured on the same 675 crops rather than assumed
    X = np.fromfile(os.path.join(ROOT, 'cnnlab', 'test-images.f32'), np.float32).reshape(-1, size, size)
    ref = np.fromfile(os.path.join(ROOT, 'cnnlab', 'test-embed.f32'), np.float32).reshape(len(X), dim)
    with torch.no_grad():
        deq = model
        for m, (w, b, _) in zip([m for m in deq.f if isinstance(m, nn.Sequential)], convs):
            q, s = quant(w)
            m[0].weight.copy_(torch.from_numpy((q.astype(np.float32) * s[:, None, None, None])))
            m[0].bias.copy_(torch.from_numpy(b))
            m[1].weight.fill_(1.0); m[1].bias.fill_(0.0)
            m[1].running_mean.fill_(0.0); m[1].running_var.fill_(1.0); m[1].eps = 0.0
        qe = deq.embed(torch.from_numpy(X).unsqueeze(1)).numpy()
    a = ref / (np.linalg.norm(ref, axis=1, keepdims=True) + 1e-9)
    c = qe / (np.linalg.norm(qe, axis=1, keepdims=True) + 1e-9)
    print(f'  fold+quant vs float model: mean cosine {float((a*c).sum(1).mean()):.6f}, '
          f'worst {float((a*c).sum(1).min()):.6f}')
    # The wasm kernel implements the QUANTISED model, so that is what it must be
    # checked against. Comparing it to the float model measures quantisation.
    qe.astype(np.float32).tofile(os.path.join(ROOT, 'cnnlab', 'test-embed-q.f32'))


if __name__ == '__main__':
    main()
