"""Re-quantise exported int8 models (MRCNN1 .bin) to 4-bit (MRCNN4 .q4.bin)
with a per-output-channel scale chosen to MINIMISE SQUARED ERROR rather than
to cover the channel's max — the max/7 rule wastes most of the 15 levels on
one outlier weight. Searches 12 scale multipliers per channel.

  python3 cnnlab/requant4.py cnnlab/emnist/<tag>.bin [...]   -> <tag>.q4.bin
"""
import struct
import sys

import numpy as np


def quant4_mse(w):
    flat = w.reshape(w.shape[0], -1).astype(np.float64)
    q = np.zeros_like(flat, np.int8)
    scales = np.zeros(flat.shape[0], np.float32)
    for c in range(flat.shape[0]):
        row = flat[c]
        mx = np.abs(row).max()
        if mx == 0:
            scales[c] = 1e-8
            continue
        best = None
        for mult in np.linspace(0.45, 1.0, 12):
            s = mx * mult / 7.0
            qq = np.clip(np.round(row / s), -7, 7)
            err = float(((qq * s - row) ** 2).sum())
            if best is None or err < best[0]:
                best = (err, s, qq)
        scales[c] = best[1]
        q[c] = best[2].astype(np.int8)
    return q.reshape(w.shape), scales


def pack4(q):
    v = (q.reshape(-1).astype(np.int16) & 0xF).astype(np.uint8)
    if len(v) % 2:
        v = np.concatenate([v, np.zeros(1, np.uint8)])
    return (v[0::2] | (v[1::2] << 4)).astype(np.uint8).tobytes()


def convert(src, dst):
    buf = open(src, 'rb').read()
    assert buf[:6] == b'MRCNN1', src
    o = 6
    version, size, dim, n_conv = struct.unpack_from('<IIII', buf, o); o += 16
    out = bytearray(b'MRCNN4' + struct.pack('<IIII', version, size, dim, n_conv))
    for _ in range(n_conv):
        cout, cin, k, pool = struct.unpack_from('<IIII', buf, o); o += 16
        scale = np.frombuffer(buf, np.float32, cout, o); o += 4 * cout
        bias = np.frombuffer(buf, np.float32, cout, o); o += 4 * cout
        q8 = np.frombuffer(buf, np.int8, cout * cin * k * k, o); o += cout * cin * k * k
        w = q8.reshape(cout, cin, k, k).astype(np.float32) * scale[:, None, None, None]
        q4, s4 = quant4_mse(w)
        out += struct.pack('<IIII', cout, cin, k, pool) + s4.tobytes() + bias.tobytes() + pack4(q4)
    lo, li = struct.unpack_from('<II', buf, o); o += 8
    scale = np.frombuffer(buf, np.float32, lo, o); o += 4 * lo
    bias = np.frombuffer(buf, np.float32, lo, o); o += 4 * lo
    q8 = np.frombuffer(buf, np.int8, lo * li, o); o += lo * li
    w = q8.reshape(lo, li).astype(np.float32) * scale[:, None]
    q4, s4 = quant4_mse(w)
    out += struct.pack('<II', lo, li) + s4.tobytes() + bias.tobytes() + pack4(q4)
    open(dst, 'wb').write(bytes(out))
    return len(buf), len(out)


if __name__ == '__main__':
    for src in sys.argv[1:]:
        dst = src[:-4] + '.q4.bin'
        a, b = convert(src, dst)
        print(f'{src} {a} B -> {dst} {b} B')
