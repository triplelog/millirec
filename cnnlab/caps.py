"""
CNNs for the drawn capital-letter drills — the per-fold trainer.

  node tuning/caps-cnn.cjs --dump          # rasters + folds -> cnnlab/caps/
  python3 cnnlab/caps.py [--archs base,small,tiny] [--epochs 300] [--seed 0]
  node tuning/caps-cnn.cjs --score         # the numbers, through the kernel

The question is whether a CNN beats the point-cloud matcher on the SAME 323
cells under the SAME 3-fold protocol (tuning/caps-lite.cjs): for fold k a model
trains on the other two thirds ONLY — never a fold cell, not even as
validation — and is scored on fold k by tuning/caps-cnn.cjs through the wasm
kernel. A fourth model per architecture trains on ALL cells; that one is for
the page's live pad and the shipped-size row, never for a reported number.

Training is embed.py's recipe on embed.py's model (make_model / augment /
ARCHES — imported, not copied): cross-entropy with label smoothing, AdamW,
OneCycle, the affine + thickness + grey augmentation. The rasters come from
node (the SAME drawStrokes/normalizeInk the page runs), so train and test
never differ in rasteriser. Fixed epochs, no early stopping: with ~215 rows a
validation split would be 27 rows of noise choosing the epoch.

Each model is exported twice: the kernel's int8 file (export.write_bin —
convs folded + quantised, the embedding linear) and a sidecar head
(export.write_head) for the template-free softmax arm.
"""

import argparse
import json
import os
import sys
import time

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'cnnlab'))
import embed as E                       # noqa: E402
from export import write_bin, write_head  # noqa: E402

# More points on the size axis than embed.py's three. Same block structure
# (3x3 conv + BN + ReLU per entry, 2x pool per stage, GAP, linear), so the
# kernel and cnnjs.mjs run them unchanged. int8 sizes: nano ~3 KB, micro ~3 KB,
# tiny 9, tiny32 9, small 17, mid 22, base 40, large ~90.
E.ARCHES.update({
    'nano': (20, [(6,), (12,), (24,)]),
    'micro': (24, [(6,), (12,), (24,)]),
    'tiny32': (32, [(8,), (16,), (32,)]),
    'mid': (32, [(16,), (32,), (64,)]),
    'large': (32, [(24, 24), (48, 48), (96,)]),
    # widths in fours: cnn.cpp packs four output channels per pass and rejects
    # anything else (nano/micro above are JS-only for that reason)
    'pico': (20, [(4,), (8,), (16,)]),
    'nano4': (24, [(4,), (12,), (24,)]),
    'xlarge': (32, [(32, 32), (64, 64), (128, 128)]),
})


class FakeQuant:
    """Quantisation-aware training: a torch parametrization that replaces a
    weight by its per-output-channel n-bit quantised value in the forward pass
    and passes the gradient straight through (STE). Exporting with the same
    max-rule scale then reproduces these exact levels."""

    def __init__(self, torch, bits):
        self.torch, self.lim = torch, float(2 ** (bits - 1) - 1)

    def __call__(self, w):
        flat = w.reshape(w.shape[0], -1)
        s = flat.abs().max(dim=1).values.clamp_min(1e-8) / self.lim
        q = self.torch.round(flat / s[:, None]).clamp(-self.lim, self.lim) * s[:, None]
        return w + (q.reshape(w.shape) - w).detach()


def make_parametrization(torch, nn, fn):
    class P(nn.Module):
        def forward(self, w):
            return fn(w)
    return P()


def quant_modules(net, nn):
    """the weights a file quantises: every conv, and the embedding linear"""
    return [m[0] for m in net.f if isinstance(m, nn.Sequential)] + [net.emb]


def prune_structured(torch, nn, teacher, size, plan, frac, n_classes, dim, arch_key):
    """Channel pruning: drop the (frac) lowest-L1 output channels of every conv
    (rounded to multiples of four for the kernel, never below four), build the
    narrower net and copy the surviving weights — then the caller fine-tunes.
    `teacher` is a loaded .bin (BN folded, so its weights are the ones that
    were actually scored)."""
    blocks = [m for m in teacher.f if isinstance(m, nn.Sequential)]
    keep = []
    for m in blocks:
        w = m[0].weight.detach()
        cout = w.shape[0]
        k = min(cout, max(4, int(round(cout * (1 - frac) / 4)) * 4))
        idx = torch.argsort(w.abs().sum(dim=(1, 2, 3)), descending=True)[:k].sort().values
        keep.append(idx)
    it = iter(keep)
    new_plan = [tuple(int(len(next(it))) for _ in stage) for stage in plan]
    E.ARCHES[arch_key] = (size, new_plan)
    net = E.make_model(torch, nn, n_classes, dim, arch_key)
    nb = [m for m in net.f if isinstance(m, nn.Sequential)]
    prev = torch.arange(blocks[0][0].weight.shape[1])
    with torch.no_grad():
        for m_old, m_new, idx in zip(blocks, nb, keep):
            m_new[0].weight.copy_(m_old[0].weight[idx][:, prev])
            m_new[0].bias.copy_(m_old[0].bias[idx])
            m_new[1].weight.fill_(1.0); m_new[1].bias.fill_(0.0)
            m_new[1].running_mean.fill_(0.0); m_new[1].running_var.fill_(1.0)
            prev = idx
        net.emb.weight.copy_(teacher.emb.weight[:, prev]); net.emb.bias.copy_(teacher.emb.bias)
        net.head.weight.copy_(teacher.head.weight); net.head.bias.copy_(teacher.head.bias)
    return net, new_plan


class AuxExit:
    """One model, two exits: the normal head at the end, plus a linear head on the
    global-average-pooled feature map after the `after`-th pool. The early head
    is what a single-file cascade would use — run the prefix, exit if the
    runner-up is far enough behind, else finish the remaining layers (no
    recomputation). Exported as a sidecar `.aux.bin` + meta auxAfter/auxIn;
    cnnjs.embedPartial runs the prefix."""

    def __init__(self, torch, nn, net, after, head_norm):
        self.torch, self.net, self.after, self.head_norm = torch, net, after, head_norm
        # channel count after the `after`-th pool = cout of the conv before it
        pools = 0
        cin = None
        for m in net.f:
            if isinstance(m, nn.Sequential):
                cin = m[0].out_channels
            elif isinstance(m, nn.MaxPool2d):
                pools += 1
                if pools == after:
                    break
        self.aux_in = cin
        self.aux = nn.Linear(cin, net.head.out_features)

    def parameters(self):
        return list(self.net.parameters()) + list(self.aux.parameters())

    def train(self):
        self.net.train(); self.aux.train()

    def eval(self):
        self.net.eval(); self.aux.eval()

    def both(self, x):
        pools = 0
        early = None
        h = x
        for m in self.net.f:
            h = m(h)
            if isinstance(m, self.torch.nn.MaxPool2d) and early is None:
                pools += 1
                if pools == self.after:
                    early = self.aux(h.mean(dim=(2, 3)))
        e = self.net.emb(h)
        if self.head_norm:
            e = e / (e.norm(dim=1, keepdim=True) + 1e-9)
        return self.net.head(self.torch.relu(e)), early

    def __call__(self, x):
        return self.both(x)[0]


class HeadNorm:
    """Wrap a Net so the softmax head reads relu(L2-normalised embedding).

    The wasm kernel returns the UNIT embedding and nothing else, so a head
    trained on relu(e) cannot be served by it (the bias does not scale with
    ||e||). A head trained on relu(e/||e||) can: kernel embeds, JS applies a
    64x26 linear — softmax at kernel speed. cnnjs.mjs does the same when the
    model's meta says headNorm."""

    def __init__(self, torch, net):
        self.torch, self.net = torch, net

    def __call__(self, x):
        e = self.net.embed(x)
        e = e / (e.norm(dim=1, keepdim=True) + 1e-9)
        return self.net.head(self.torch.relu(e))



def train(torch, nn, X, y, n_classes, arch, dim, epochs, batch, lr, seed, head_norm=False,
          teacher=None, distill_t=4.0, distill_w=0.7, X_teacher=None, aux_after=0, aux_w=0.5,
          init_net=None, qat_bits=0, sparsity=0.0, warm_frac=0.4):
    """`teacher`: a callable giving logits for X_teacher (same rows as X, at the
    teacher's own raster size) — knowledge distillation: loss = (1-w)*CE +
    w*T^2*KL(student/T || teacher/T). The soft targets are computed on the
    UN-augmented image (the teacher saw the clean pool), the student sees the
    augmented one; a mild mismatch that regularises rather than confuses."""
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    net = init_net if init_net is not None else E.make_model(torch, nn, n_classes, dim, arch)
    model = AuxExit(torch, nn, net, aux_after, head_norm) if aux_after else (HeadNorm(torch, net) if head_norm else net)
    from torch.nn.utils import parametrize
    warm_epoch = int(round(epochs * warm_frac)) if (qat_bits or sparsity) else epochs + 1
    armed = False
    opt = torch.optim.AdamW(model.parameters() if aux_after else net.parameters(), lr=lr, weight_decay=1e-4)
    steps = epochs * max(1, len(X) // batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=steps)
    lossf = nn.CrossEntropyLoss(label_smoothing=0.1)
    soft = None
    if teacher is not None:
        with torch.no_grad():
            soft = torch.cat([teacher(torch.from_numpy(X_teacher[i:i + 512][:, None])) for i in range(0, len(X_teacher), 512)])
            soft = torch.log_softmax(soft / distill_t, dim=1)
    net.train()
    for ep in range(epochs):
        if ep == warm_epoch and not armed:
            armed = True
            for m in quant_modules(net, nn):
                if sparsity:
                    # fixed magnitude mask per layer, from the weights as they stand
                    w = m.weight.detach().abs().reshape(-1)
                    k = int(round(len(w) * sparsity))
                    thr = w.kthvalue(k).values if k > 0 else -1.0
                    mask = (m.weight.detach().abs() > thr).to(m.weight.dtype)
                    parametrize.register_parametrization(m, 'weight', make_parametrization(torch, nn, lambda x, mask=mask: x * mask))
                if qat_bits:
                    parametrize.register_parametrization(m, 'weight', make_parametrization(torch, nn, FakeQuant(torch, qat_bits)))
        perm = rng.permutation(len(X))
        for s in range(0, len(perm) - batch + 1, batch):
            idx = perm[s:s + batch]
            av = E.augment(X[idx], rng)
            xb = torch.from_numpy(av[:, None, :, :])
            yb = torch.from_numpy(y[idx]).long()
            opt.zero_grad()
            if aux_after:
                z, z_aux = model.both(xb)
                loss = lossf(z, yb) + aux_w * lossf(z_aux, yb)
            else:
                z = model(xb)
                loss = lossf(z, yb)
            if soft is not None:
                kl = nn.functional.kl_div(torch.log_softmax(z / distill_t, dim=1), soft[idx], log_target=True, reduction='batchmean')
                loss = (1 - distill_w) * loss + distill_w * distill_t * distill_t * kl
            loss.backward()
            opt.step()
            sched.step()
    if armed:
        for m in quant_modules(net, nn):
            parametrize.remove_parametrizations(m, 'weight', leave_parametrized=True)
    model.eval() if aux_after else net.eval()
    with torch.no_grad():
        acc = float(np.mean(np.concatenate([model(torch.from_numpy(X[i:i + 1024][:, None])).argmax(1).numpy() for i in range(0, len(X), 1024)]) == y))
    return net, model, acc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--archs', default='base,small,tiny')
    ap.add_argument('--epochs', type=int, default=300)
    ap.add_argument('--batch', type=int, default=64)
    ap.add_argument('--lr', type=float, default=3e-3)
    ap.add_argument('--dim', type=int, default=64)
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--folds', default='0,1,2,all')
    ap.add_argument('--dir', default='cnnlab/caps', help='dataset dir with meta.json + images-<size>.f32')
    ap.add_argument('--per-class', type=int, default=0, help='train rows per class by rank (0 = every train row)')
    ap.add_argument('--headNorm', action='store_true', help='softmax head on relu(unit embedding) — kernel-servable')
    ap.add_argument('--distill', default='', help='tag of a trained model in --dir to distil from (teacher logits on the same rows)')
    ap.add_argument('--tag', default='', help='output name (default <arch>-f<fold>); {arch} is substituted')
    ap.add_argument('--auxAfter', type=int, default=0, help='also train an early-exit head after the k-th pool (single-file cascade)')
    ap.add_argument('--qat', type=int, default=0, help='quantisation-aware training at N bits (after 40%% of the epochs)')
    ap.add_argument('--sparsity', type=float, default=0.0, help='unstructured magnitude pruning to this fraction of zero weights (mask fixed after 40%% of the epochs)')
    ap.add_argument('--prune-from', default='', help='tag of a trained model to channel-prune and fine-tune')
    ap.add_argument('--prune', type=float, default=0.0, help='fraction of output channels to drop per conv (with --prune-from)')
    ap.add_argument('--export-bits', default='4', help='comma list of extra n-bit files to write (3,4,5,6)')
    args = ap.parse_args()
    caps = args.dir if os.path.isabs(args.dir) else os.path.join(ROOT, args.dir)

    import torch
    import torch.nn as nn
    torch.set_num_threads(max(1, os.cpu_count() // 2))

    meta = json.load(open(os.path.join(caps, 'meta.json')))
    classes = meta['classes']
    cells = meta['cells']
    y_all = np.array([classes.index(c['cls']) for c in cells])
    folds = np.array([-1 if c.get('fold') is None else c['fold'] for c in cells])
    # a split-based set (EMNIST): 'all' means every TRAIN row; test rows are never trained on
    is_test = np.array([c.get('split') == 'test' for c in cells])
    rank = np.array([-1 if c.get('rank') is None else c['rank'] for c in cells])
    in_pool = ~is_test if not args.per_class else (~is_test) & (rank < args.per_class)
    rp = os.path.join(caps, 'train-report.json')
    report = json.load(open(rp)) if os.path.exists(rp) else {}
    images = {}

    def imgs(size):
        if size not in images:
            X = np.fromfile(os.path.join(caps, f'images-{size}.f32'), np.float32).reshape(-1, size, size)
            assert len(X) == len(cells), (len(X), len(cells))
            images[size] = X
        return images[size]

    teacher = None
    if args.distill:
        tm = json.load(open(os.path.join(caps, args.distill + '.meta.json')))
        tsize = E.ARCHES[tm['arch']][0]
        from cnnjs_ref import load_bin_model   # noqa: E402  (torch re-load of an exported .bin)
        tnet = load_bin_model(torch, nn, os.path.join(caps, args.distill + '.bin'),
                              os.path.join(caps, args.distill + '.head.bin'), tm['arch'], args.dim, len(classes))
        tmodel = HeadNorm(torch, tnet) if tm.get('headNorm') else tnet
        tmodel_eval = tnet.eval()
        teacher = tmodel
        print(f'distilling from {args.distill} ({tm["arch"]}, headNorm={tm.get("headNorm", False)})')

    for arch in args.archs.split(','):
        init_net, plan_used = None, None
        if args.prune_from:
            from cnnjs_ref import load_bin_model   # noqa: E402
            pm = json.load(open(os.path.join(caps, args.prune_from + '.meta.json')))
            parch = pm['arch']
            psize, pplan = E.ARCHES[parch][0], (pm.get('plan') or E.ARCHES[parch][1])
            E.ARCHES[parch + '@' + args.prune_from] = (psize, pplan)
            tnet = load_bin_model(torch, nn, os.path.join(caps, args.prune_from + '.bin'),
                                  os.path.join(caps, args.prune_from + '.head.bin'), parch + '@' + args.prune_from, pm.get('dim', args.dim), len(classes))
            arch = f'{parch}-p{int(round(100 * args.prune))}'
            init_net, plan_used = prune_structured(torch, nn, tnet, psize, pplan, args.prune, len(classes), pm.get('dim', args.dim), arch)
            print(f'pruned {args.prune_from}: plan {pplan} -> {plan_used}')
        size = E.ARCHES[arch][0]
        E.SIZE, E.INK = size, int(round(size * 0.75))   # augment() reads the module globals
        X = imgs(size)
        for f in args.folds.split(','):
            keep = in_pool if f == 'all' else (folds != int(f)) & in_pool
            t0 = time.time()
            Xt = imgs(tsize)[keep] if teacher is not None else None
            net, model, acc = train(torch, nn, X[keep], y_all[keep], len(classes), arch, args.dim,
                                    args.epochs, args.batch, args.lr, args.seed, head_norm=args.headNorm,
                                    teacher=teacher, X_teacher=Xt, aux_after=args.auxAfter,
                                    init_net=init_net, qat_bits=args.qat, sparsity=args.sparsity)
            tag = (args.tag or '{arch}-f' + f).replace('{arch}', arch)
            nb, n8 = write_bin(net, nn, size, args.dim, os.path.join(caps, tag + '.bin'), verbose=False)
            # extra n-bit files: exact levels for a QAT model (max rule), least-squares otherwise
            qbytes = {}
            for b in [int(x) for x in args.export_bits.split(',') if x.strip()]:
                rule = 'max' if (args.qat and b == args.qat) else 'mse'
                qbytes[b], _ = write_bin(net, nn, size, args.dim, os.path.join(caps, f'{tag}.q{b}.bin'), verbose=False, bits=b, rule=rule)
            nb4 = qbytes.get(4)
            nh = write_head(net, os.path.join(caps, tag + '.head.bin'))
            aux_meta = {}
            if args.auxAfter:
                from export import linear_block
                blk, _ = linear_block(model.aux.weight.detach().numpy(), model.aux.bias.detach().numpy())
                open(os.path.join(caps, tag + '.aux.bin'), 'wb').write(blk)
                aux_meta = dict(auxAfter=args.auxAfter, auxIn=model.aux_in, aux_bytes=len(blk))
            meta_out = dict(arch=arch, size=size, fold=f, train_rows=int(keep.sum()), per_class=args.per_class or None,
                            train_acc=round(acc, 4), bin_bytes=nb, q4_bytes=nb4, head_bytes=nh, int8=n8, epochs=args.epochs,
                            seed=args.seed, headNorm=bool(args.headNorm), distill=args.distill or None, dim=args.dim,
                            qat=args.qat or None, sparsity=args.sparsity or None, pruneFrom=args.prune_from or None, prune=args.prune or None,
                            plan=plan_used, qbytes=qbytes, **aux_meta)
            json.dump(meta_out, open(os.path.join(caps, tag + '.meta.json'), 'w'))
            report[tag] = meta_out
            print(f'{tag:24s} rows {int(keep.sum()):6d}  train-acc {acc:.4f}  bin {nb} B  head {nh} B  '
                  f'{time.time() - t0:.0f}s', flush=True)
            json.dump(report, open(rp, 'w'), indent=1)


if __name__ == '__main__':
    main()
