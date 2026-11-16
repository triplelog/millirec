"""Re-load an exported MRCNN1 .bin (+ head sidecar) into embed.py's Net, in
torch — the distillation teacher. Reads export.py's layout: int8 weights x
per-output-channel scale, BN already folded (so the loaded BN is identity)."""
import struct

import numpy as np


def _read_linear(buf, o):
    out, inn = struct.unpack_from('<II', buf, o); o += 8
    scale = np.frombuffer(buf, np.float32, out, o); o += 4 * out
    bias = np.frombuffer(buf, np.float32, out, o); o += 4 * out
    q = np.frombuffer(buf, np.int8, out * inn, o); o += out * inn
    return (q.reshape(out, inn).astype(np.float32) * scale[:, None]), bias.copy(), o


def load_bin_model(torch, nn, bin_path, head_path, arch, dim, n_classes):
    import embed as E
    buf = open(bin_path, 'rb').read()
    assert buf[:6] == b'MRCNN1'
    o = 6
    version, size, dim_f, n_conv = struct.unpack_from('<IIII', buf, o); o += 16
    assert dim_f == dim
    convs = []
    for _ in range(n_conv):
        cout, cin, k, pool = struct.unpack_from('<IIII', buf, o); o += 16
        scale = np.frombuffer(buf, np.float32, cout, o); o += 4 * cout
        bias = np.frombuffer(buf, np.float32, cout, o); o += 4 * cout
        q = np.frombuffer(buf, np.int8, cout * cin * k * k, o); o += cout * cin * k * k
        convs.append((q.reshape(cout, cin, k, k).astype(np.float32) * scale[:, None, None, None], bias.copy()))
    lw, lb, o = _read_linear(buf, o)
    hw, hb, _ = _read_linear(open(head_path, 'rb').read(), 0)
    net = E.make_model(torch, nn, n_classes, dim, arch)
    blocks = [m for m in net.f if isinstance(m, nn.Sequential)]
    assert len(blocks) == len(convs)
    with torch.no_grad():
        for m, (w, b) in zip(blocks, convs):
            m[0].weight.copy_(torch.from_numpy(w)); m[0].bias.copy_(torch.from_numpy(b))
            m[1].weight.fill_(1.0); m[1].bias.fill_(0.0); m[1].running_mean.fill_(0.0); m[1].running_var.fill_(1.0); m[1].eps = 0.0
        net.emb.weight.copy_(torch.from_numpy(lw)); net.emb.bias.copy_(torch.from_numpy(lb))
        net.head.weight.copy_(torch.from_numpy(hw)); net.head.bias.copy_(torch.from_numpy(hb))
    return net.eval()
