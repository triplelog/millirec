"""
A learned metric instead of a hand-tuned one — the offline read.

The point-cloud matcher is a DISTANCE: alpha*orientation + beta*position +
gamma*curvature, swept by coordinate descent. This trains a small CNN to
produce a 64-d embedding and uses cosine distance in that space instead. The
templates, the test set, the leave-one-out rule and the class-score formula are
all unchanged, so the only thing being compared is the metric.

  python3 cnnlab/embed.py --train           train + evaluate
  python3 cnnlab/embed.py --eval-only       evaluate a saved model

PROTOCOL (`scripts/sweep-pen.cjs --mode pixel`, so the numbers are comparable):
  test set    training/pen-glyphs — 675 crops, 75 classes, exactly 9 each
  templates   all 9 of every class; a test glyph excludes ITSELF -> 674
  metrics     top1 / top3 / sse over the ranked class list
  class score best^2 * second-best, 0.9*best^3 when a class has one usable
              value — identify()'s own combination

The matcher scores 91.11 / 98.96 / 146 under exactly this.

WHAT THE CNN MAY SEE. Never the 675 test crops. It trains on `pen-prose` (2173
stylus glyphs harvested from paragraphs — a different writing session, no file
overlap) plus the photo-domain glyph sets. Both arms therefore get the same 9
templates per class at test time; the CNN additionally got to LEARN ITS METRIC
from other data, which is the whole proposition and also the whole cost. It is
not a free comparison and the README says so.

SCALE IS THROWN AWAY on purpose. Each crop is cropped to its ink and rescaled
to fit the box, exactly as the matcher's cloud normalisation discards scale, so
neither arm can see that `C` is bigger than `c`. Case twins are handled
downstream by `geoW` and giving the CNN a size channel here would be measuring
a different thing. `--geo` adds it back as a diagnostic.
"""

import argparse
import json
import os
import sys
from collections import Counter

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIZE = 32
INK = 24          # ink box inside SIZE, leaving a margin the augmenter can move into

TEST_DIR = 'pen-glyphs'
PEN_DIRS = ['pen-prose']
PHOTO_DIRS = ['glyphs', 'L1-iso', 'L2-iso', 'L3-iso', 'harv-w1-all', 'harv-w2-all',
              'harv-w3-all', 'glyphs-harvest', 'f1-iso', 'f2-iso', 'f3-iso',
              'L1-harv', 'L2-harv', 'L3-harv']


# ------------------------------------------------------------------- data --

def load_dir(name):
    """manifest + crops -> [(gray HxW float32 ink=1, char, meta)]"""
    d = os.path.join(ROOT, 'training', name)
    mf = os.path.join(d, 'manifest.json')
    if not os.path.exists(mf):
        return []
    out = []
    for m in json.load(open(mf)):
        ch = m.get('char')
        p = os.path.join(d, m['file'])
        if not ch or not os.path.exists(p):
            continue
        a = np.asarray(Image.open(p).convert('L'), dtype=np.float32) / 255.0
        out.append((1.0 - a, ch, m))          # ink = 1
    return out


def normalize(ink, size=None, box=None):
    """Crop to ink, scale to fit `box` preserving aspect, centre in `size`.

    This is the raster twin of the cloud normalisation: centroid-centred and
    scale-free. Everything the matcher cannot see, the CNN cannot see either.
    """
    # resolved at CALL time: `--arch tiny` changes SIZE after import, and a
    # default argument would still be holding 32
    size = SIZE if size is None else size
    box = INK if box is None else box
    ys, xs = np.nonzero(ink > 0.15)
    if len(xs) == 0:
        return np.zeros((size, size), np.float32)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    crop = ink[y0:y1, x0:x1]
    h, w = crop.shape
    s = box / max(h, w)
    nh, nw = max(1, int(round(h * s))), max(1, int(round(w * s)))
    im = Image.fromarray((crop * 255).astype(np.uint8)).resize((nw, nh), Image.BILINEAR)
    out = np.zeros((size, size), np.float32)
    oy, ox = (size - nh) // 2, (size - nw) // 2
    out[oy:oy + nh, ox:ox + nw] = np.asarray(im, np.float32) / 255.0
    return out


def geo_of(ink, meta):
    """The three size cues normalisation throws away, in x-heights: how tall the
    ink is, how far it drops below the baseline, and its aspect. This is the
    channel `geoW` feeds on downstream; it exists here only to measure how much
    of the residual error is case twins."""
    ys, xs = np.nonzero(ink > 0.15)
    if len(xs) == 0:
        return np.zeros(3, np.float32)
    xh = float(meta.get('xh') or 60) or 60.0
    h = (ys.max() - ys.min() + 1) / xh
    w = (xs.max() - xs.min() + 1) / xh
    desc = (ys.max() - float(meta.get('baselineY', ys.max()))) / xh
    return np.array([h, desc, w / max(h, 1e-6)], np.float32)


def build(dirs, cache=None, hires_angles=False, hires_cross=False):
    X, Y, M, G, C = [], [], [], [], []
    for d in dirs:
        rows = load_dir(d)
        for ink, ch, meta in rows:
            if hires_angles:
                # THE POINT: the tensor is computed on the FULL-RESOLUTION crop
                # and then downsampled. Computing it on the 32x32 raster instead
                # is a deterministic function of what the net already sees, and
                # measures as nothing (see README).
                t = tangent_channels(ink)
                X.append(normalize_planes(ink, [t[1], t[2]]))
            elif hires_cross:
                # same argument, and it bites harder here: a 32x32 resample WELDS
                # two runs into one, which is the exact quantity being counted
                X.append(normalize_planes(ink, cross_planes(ink), signed=False))
            else:
                X.append(normalize(ink))
            Y.append(ch)
            M.append((d, meta))
            G.append(geo_of(ink, meta))
            C.append(cross_feat(ink))
        if rows:
            print(f'  {d}: {len(rows)}')
    return (np.stack(X) if X else np.zeros((0, SIZE, SIZE), np.float32),
            Y, M, np.stack(G) if G else np.zeros((0, 3), np.float32),
            np.stack(C) if C else np.zeros((0, 2 * SIZE), np.float32))


def augment_planes(batch, rng):
    """Affine on every plane, then ROTATE THE ANGLE PAIR. Rotating an image by
    `a` turns every stroke orientation by `a`, so the double-angle field must
    turn by 2a — forgetting that trains the net on a contradiction."""
    out = np.empty_like(batch)
    for i, st in enumerate(batch):
        ang = rng.uniform(-9, 9) * np.pi / 180
        sc = rng.uniform(0.86, 1.14)
        shear = rng.uniform(-0.16, 0.16)
        tx, ty = rng.uniform(-2.5, 2.5), rng.uniform(-2.5, 2.5)
        ca, sa = np.cos(ang) / sc, np.sin(ang) / sc
        a, b = ca, sa + shear
        c_, d_ = -sa, ca
        cx = cy = SIZE / 2
        e = cx - a * cx - b * cy + tx
        f = cy - c_ * cx - d_ * cy + ty
        warped = []
        for c in range(st.shape[0]):
            v = st[c]
            im = Image.fromarray((((v * 0.5 + 0.5) if c else v) * 255).clip(0, 255).astype(np.uint8))
            im = im.transform((SIZE, SIZE), Image.AFFINE, (a, b, e, c_, d_, f), Image.BILINEAR)
            u = np.asarray(im, np.float32) / 255.0
            warped.append((u * 2 - 1) if c else u)
        ink = np.clip(warped[0] + rng.normal(0, 0.03, warped[0].shape), 0, 1)
        c2, s2 = warped[1], warped[2]
        cc, ss = np.cos(2 * ang), np.sin(2 * ang)
        out[i] = np.stack([ink, c2 * cc - s2 * ss, c2 * ss + s2 * cc])
    return out


def augment_cross(batch, rng):
    """(N,3,H,W) with the crossing planes precomputed at full resolution.

    The affine carries all three planes together — a profile plane is constant
    along one axis, so warping it transports each count with the ink it
    describes, which is what the tangent arm's explicit 2a rotation is doing in
    its own units.

    THICKNESS AND GREY go on the INK PLANE ONLY, and that is deliberate rather
    than an oversight: a dilate welding two runs into one is exactly the
    rasterisation dependence that makes the scalar crossings feature brittle, so
    a hires profile that survives it is the more robust quantity, and it is also
    what inference sees (the profile is read off the real full-resolution crop).
    Note this is strictly MORE augmentation than `augment_planes` applies — the
    hires tangent arm was measured without thickness or grey at all.
    """
    out = np.empty_like(batch)
    for i, st in enumerate(batch):
        ang = rng.uniform(-9, 9) * np.pi / 180
        sc = rng.uniform(0.86, 1.14)
        shear = rng.uniform(-0.16, 0.16)
        tx, ty = rng.uniform(-2.5, 2.5), rng.uniform(-2.5, 2.5)
        ca, sa = np.cos(ang) / sc, np.sin(ang) / sc
        a, b = ca, sa + shear
        c_, d_ = -sa, ca
        cx = cy = SIZE / 2
        e = cx - a * cx - b * cy + tx
        f = cy - c_ * cx - d_ * cy + ty
        warped = []
        for c in range(st.shape[0]):
            im = Image.fromarray((st[c] * 255).clip(0, 255).astype(np.uint8))
            im = im.transform((SIZE, SIZE), Image.AFFINE, (a, b, e, c_, d_, f), Image.BILINEAR)
            warped.append(np.asarray(im, np.float32) / 255.0)
        v = warped[0]
        t = rng.random()
        if t < 0.25:
            v = np.maximum.reduce([v, np.roll(v, 1, 0), np.roll(v, -1, 0),
                                   np.roll(v, 1, 1), np.roll(v, -1, 1)]) * 0.9
        elif t < 0.4:
            v = np.minimum.reduce([v, np.roll(v, 1, 0), np.roll(v, 1, 1)])
        v = np.clip(v + rng.normal(0, 0.03, v.shape), 0, 1)
        r = rng.random()
        if r < 0.5:
            v = v ** rng.uniform(0.5, 1.8)
        if r < 0.7:
            v = v * rng.uniform(0.55, 1.0)
        pk = v.max()
        if pk > 0.05:
            v = v / pk
        out[i] = np.stack([v, warped[1], warped[2]])
    return out


# ------------------------------------------------------------- channels --

def tangent_channels(img, sigma=1.0):
    """ink -> (3, H, W): [ink, cos2t*coh, sin2t*coh].

    The matcher measures a tangent per sample point from a windowed structure
    tensor over the Sobel field (`core/pipeline/image.js`); a raster CNN has to
    infer the same thing from 32x32, where a stroke is two pixels wide. This
    hands it the measurement instead.

    DOUBLE ANGLE. Stroke orientation is undirected — the matcher folds it mod pi
    for exactly this reason — so the field is carried as (cos 2t, sin 2t), where
    wraparound is plain Euclidean distance. That also means it falls straight
    out of the structure tensor without an atan2: with
    Jxx, Jyy, Jxy the smoothed products of the gradients,

        cos2t = (Jyy - Jxx) / r,  sin2t = -2 Jxy / r,  r = hypot(Jxx-Jyy, 2Jxy)

    describes the TANGENT (perpendicular to the dominant gradient). Scaling by
    coherence r/(Jxx+Jyy) makes magnitude mean confidence, so junctions and blob
    interiors fade to zero rather than voting with noise — the same trick
    charlab used for its per-pixel angles.

    Computed AFTER augmentation, never before: rotating an image rotates its
    orientation field too, and recomputing is simpler than transforming it.
    """
    from scipy.ndimage import sobel, gaussian_filter
    gx = sobel(img, axis=1, mode='constant')
    gy = sobel(img, axis=0, mode='constant')
    Jxx = gaussian_filter(gx * gx, sigma, mode='constant')
    Jyy = gaussian_filter(gy * gy, sigma, mode='constant')
    Jxy = gaussian_filter(gx * gy, sigma, mode='constant')
    d = Jxx - Jyy
    r = np.sqrt(d * d + 4 * Jxy * Jxy) + 1e-8
    coh = r / (Jxx + Jyy + 1e-6)
    c2 = (-d / r) * coh
    s2 = (-2 * Jxy / r) * coh
    m = img > 0.15                       # orientation only where there is ink
    return np.stack([img, np.clip(c2, -1, 1) * m, np.clip(s2, -1, 1) * m]).astype(np.float32)


# ------------------------------------------------------------- crossings --

CROSS_CAP = 4.0   # runs per scanline above this are saturated, not scaled


def crossing_profiles(ink, thr=0.15):
    """ink -> (runs per ROW, runs per COLUMN).

    `charscore.crossingsOf` counts the ink runs a horizontal scanline meets and
    averages three of them into one number. That scalar is measured, fitted and
    OFF everywhere (docs/pen.md): it is monotonically harmful as a letter
    channel because the decoder scores LATTICE SEGMENTS, where a discrete count
    jumps by a whole run for a cut a few pixels over.

    A PROFILE does not have that failure mode — a bad cut moves a few entries of
    a 32-vector instead of the single number the whole Gaussian rides on, which
    is the same graceful-degradation property that made closure ship. So this
    keeps the quantity and throws away the summary.

    Counted as 0->1 transitions plus the left/top edge, which is the same run
    definition crossingsOf uses.
    """
    m = ink > thr
    row = (m[:, 1:] & ~m[:, :-1]).sum(1) + m[:, 0]
    col = (m[1:, :] & ~m[:-1, :]).sum(0) + m[0, :]
    return row.astype(np.float32), col.astype(np.float32)


def cross_planes(ink):
    """The two profiles broadcast back to 2-D: [row runs along y, col runs along x].

    Broadcasting is what makes this readable by a conv stack at all. A run COUNT
    is a non-local function of a whole scanline, and 3x3 filters under global
    average pooling cannot compute one however deep they get — unlike the
    tangent field, which the first conv layer is free to learn for itself and
    duly measured as nothing. That difference is the reason this is worth a run.
    """
    r, c = crossing_profiles(ink)
    r = np.minimum(r, CROSS_CAP) / CROSS_CAP
    c = np.minimum(c, CROSS_CAP) / CROSS_CAP
    h, w = ink.shape
    return [np.repeat(r[:, None], w, 1), np.repeat(c[None, :], h, 0)]


def cross_feat(ink, size=None, box=None):
    """The same profiles as a 2*SIZE FEATURE VECTOR in normalised coordinates —
    the diagnostic arm. Fused as a distance (`--crossW`) it asks whether the
    profiles carry anything the CNN embedding does not already hold, which is
    the question that decides whether any architecture is worth building."""
    size = SIZE if size is None else size
    p = normalize_planes(ink, cross_planes(ink), size, box, signed=False)
    # MAX along the broadcast axis, not mean: the plane is constant across the
    # ink box and zero in the margin, so a mean would divide every count by the
    # glyph's aspect ratio and quietly turn a run counter into a width sensor
    return np.concatenate([p[1].max(1), p[2].max(0)]).astype(np.float32)


def cross_feat_from_raster(img):
    """The same vector counted on the already-normalised raster — the arm the
    resample has had its way with, kept so the two can be differenced."""
    r, c = crossing_profiles(img)
    return np.concatenate([np.minimum(r, CROSS_CAP) / CROSS_CAP,
                           np.minimum(c, CROSS_CAP) / CROSS_CAP]).astype(np.float32)


def normalize_planes(ink, extra, size=None, box=None, signed=True):
    """Same crop-and-fit as normalize(), applied to the ink AND to any extra
    planes, using the INK's bounding box for all of them.

    `signed`: the angle planes live in [-1,1] and are shifted for the 8-bit
    resample; the crossing planes are already in [0,1] and must NOT be, or the
    margin's zero fill would read as two runs rather than none."""
    size = SIZE if size is None else size
    box = INK if box is None else box
    ys, xs = np.nonzero(ink > 0.15)
    C = 1 + len(extra)
    if len(xs) == 0:
        return np.zeros((C, size, size), np.float32)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    h, w = y1 - y0, x1 - x0
    s = box / max(h, w)
    nh, nw = max(1, int(round(h * s))), max(1, int(round(w * s)))
    out = np.zeros((C, size, size), np.float32)
    oy, ox = (size - nh) // 2, (size - nw) // 2
    for c, plane in enumerate([ink] + list(extra)):
        sg = signed and c > 0
        crop = plane[y0:y1, x0:x1]
        # the angle planes live in [-1,1]; shift into [0,1] for the 8-bit
        # resample and back, so one code path serves both
        im = Image.fromarray(((crop * 0.5 + 0.5 if sg else crop) * 255).clip(0, 255).astype(np.uint8))
        v = np.asarray(im.resize((nw, nh), Image.BILINEAR), np.float32) / 255.0
        out[c, oy:oy + nh, ox:ox + nw] = (v * 2 - 1) if sg else v
    return out


def to_input(batch, use_angles, use_cross=False):
    """(N,H,W) or (N,C,H,W) -> (N,C,H,W)"""
    if batch.ndim == 4:
        return batch
    if use_cross:
        # computed AFTER augmentation, so the profile always describes the image
        # the net is actually shown — a dilate that welds two runs into one must
        # move the channel too, or the net trains on a contradiction
        return np.stack([np.concatenate([b[None], cross_planes(b)]) for b in batch])
    if not use_angles:
        return batch[:, None, :, :]
    return np.stack([tangent_channels(b) for b in batch])


# ----------------------------------------------------------- augmentation --

def augment(batch, rng):
    """Small affine + thickness. Written out rather than pulled from
    torchvision, which is not installed and would be one dependency for six
    lines of arithmetic."""
    out = np.empty_like(batch)
    for i, img in enumerate(batch):
        ang = rng.uniform(-9, 9) * np.pi / 180
        sc = rng.uniform(0.86, 1.14)
        shear = rng.uniform(-0.16, 0.16)
        tx, ty = rng.uniform(-2.5, 2.5), rng.uniform(-2.5, 2.5)
        ca, sa = np.cos(ang) / sc, np.sin(ang) / sc
        # PIL's AFFINE maps OUTPUT -> INPUT
        a, b = ca, sa + shear
        c_, d_ = -sa, ca
        cx = cy = SIZE / 2
        e = cx - a * cx - b * cy + tx
        f = cy - c_ * cx - d_ * cy + ty
        im = Image.fromarray((img * 255).astype(np.uint8))
        im = im.transform((SIZE, SIZE), Image.AFFINE, (a, b, e, c_, d_, f), Image.BILINEAR)
        v = np.asarray(im, np.float32) / 255.0
        # thickness: a cheap dilate/erode via max/min over a shifted stack
        t = rng.random()
        if t < 0.25:
            v = np.maximum.reduce([v, np.roll(v, 1, 0), np.roll(v, -1, 0),
                                   np.roll(v, 1, 1), np.roll(v, -1, 1)]) * 0.9
        elif t < 0.4:
            v = np.minimum.reduce([v, np.roll(v, 1, 0), np.roll(v, 1, 1)])
        v = np.clip(v + rng.normal(0, 0.03, v.shape), 0, 1)
        # GREY-INK augmentation: segPage renders page ink at one flat darkness
        # (measured 0.647 vs the training crops' 1.000). Random gamma + level,
        # then peak renormalisation exactly as the inference path does — so the
        # model trains on the same residual variation it will see after the
        # contrast fix, instead of only ever seeing saturated ink.
        r = rng.random()
        if r < 0.5:
            v = v ** rng.uniform(0.5, 1.8)
        if r < 0.7:
            v = v * rng.uniform(0.55, 1.0)
        pk = v.max()
        if pk > 0.05:
            v = v / pk
        out[i] = v
    return out


# ------------------------------------------------------------------ model --

ARCHES = {
    # (input size, channel plan). Each entry is a stage: a tuple runs two convs
    # at that width, an int runs one, and every stage is followed by a 2x pool.
    'base': (32, [(16, 16), (32, 32), (64,)]),
    'small': (32, [(12,), (24,), (48,)]),
    'tiny': (24, [(8,), (16,), (32,)]),
}


def macs_of(arch, dim, n_classes, cin0=1):
    """Multiply-accumulates per glyph. The number that decides whether this can
    run in a wasm kernel at page speed, so it is counted rather than guessed."""
    size, plan = ARCHES[arch]
    res, cin, total = size, cin0, 0
    for stage in plan:
        for cout in stage:
            total += res * res * cout * cin * 9
            cin = cout
        res //= 2
    total += cin * dim + dim * n_classes
    return total


AUX_H = 32        # width of the profile branch


def make_model(torch, nn, n_classes, dim, arch='base', cin0=1, aux=0):
    """`aux`: length of a 1-D side input joined at the embedding rather than
    broadcast into the convs. A crossing profile IS a 1-D signal, so a branch is
    the honest shape for it — broadcasting spends a whole 32x32 plane carrying
    32 numbers and asks 3x3 filters to read a quantity that is constant along
    one axis. Measuring both says whether the plane arm's result is about the
    information or about the plumbing."""
    size, plan = ARCHES[arch]

    class Net(nn.Module):
        def __init__(self):
            super().__init__()
            def blk(i, o):
                return nn.Sequential(nn.Conv2d(i, o, 3, padding=1), nn.BatchNorm2d(o), nn.ReLU(inplace=True))
            layers, cin = [], cin0
            for stage in plan:
                for cout in stage:
                    layers.append(blk(cin, cout))
                    cin = cout
                layers.append(nn.MaxPool2d(2))
            layers += [nn.AdaptiveAvgPool2d(1), nn.Flatten()]
            self.f = nn.Sequential(*layers)
            self.aux = nn.Sequential(nn.Linear(aux, AUX_H), nn.ReLU(),
                                     nn.Linear(AUX_H, AUX_H), nn.ReLU()) if aux else None
            self.emb = nn.Linear(cin + (AUX_H if aux else 0), dim)
            self.head = nn.Linear(dim, n_classes)

        def embed(self, x, a=None):
            v = self.f(x)
            if self.aux is not None:
                v = torch.cat([v, self.aux(a)], 1)
            return self.emb(v)

        def forward(self, x, a=None):
            return self.head(torch.relu(self.embed(x, a)))
    return Net()


# ------------------------------------------------------------- evaluation --

def rank_classes(dists, tmpl_cls, n_classes, mode='p2'):
    best = np.full(n_classes, np.inf)
    second = np.full(n_classes, np.inf)
    for i, d in enumerate(dists):
        c = tmpl_cls[i]
        if d < best[c]:
            second[c] = best[c]
            best[c] = d
        elif d < second[c]:
            second[c] = d
    score = np.full(n_classes, np.inf)
    for c in range(n_classes):
        if not np.isfinite(best[c]):
            continue
        if mode == 'nn':
            score[c] = best[c]
        elif np.isfinite(second[c]):
            score[c] = best[c] * best[c] * second[c]
        else:
            score[c] = 0.9 * best[c] ** 3
    return np.argsort(score, kind='stable')


def loo_score(emb, labels, classes, mode='p2', geo=None, geoW=0.0, tmplMask=None, nTest=None,
              cross=None, crossW=0.0):
    """Leave-one-out over the test set: every glyph is a template AND a test,
    excluding itself. Identical to `group()` in sweep-pen.cjs at spc 9."""
    n_classes = len(classes)
    cls_idx = np.array([classes.index(c) for c in labels])
    E = emb / (np.linalg.norm(emb, axis=1, keepdims=True) + 1e-9)
    D = 1.0 - E @ E.T                      # cosine distance
    if geo is not None and geoW:
        # |dh| + |ddesc| + |daspect| in x-heights, the same three cues the page
        # path fuses — added, not concatenated, so the shape metric is untouched
        Dg = np.abs(geo[:, None, :] - geo[None, :, :]).sum(-1)
        D = D + geoW * Dg
    if cross is not None and crossW:
        # mean |Δ| over the 2*SIZE profile vector, added to the cosine exactly as
        # the size cues are. This measures the INFORMATION, not an architecture:
        # if the profiles hold nothing the embedding is missing, no way of
        # feeding them to the net can help either.
        Dc = np.abs(cross[:, None, :] - cross[None, :, :]).mean(-1)
        D = D + crossW * Dc
    np.fill_diagonal(D, np.inf)            # the leave-one-out exclusion
    if tmplMask is not None:               # only these rows may serve as templates
        D[:, ~tmplMask] = np.inf
    top1 = top3 = sse = 0
    conf = Counter()
    nT = len(E) if nTest is None else nTest      # rows past nTest are template-only
    for i in range(nT):
        order = rank_classes(D[i], cls_idx, n_classes, mode)
        want = cls_idx[i]
        rank = 0 if order[0] == want else 1 if order[1] == want else 2 if order[2] == want else 3
        top1 += rank == 0
        top3 += rank <= 2
        sse += rank * rank
        if rank:
            conf[f'{classes[want]}->{classes[order[0]]}'] += 1
    return dict(top1=round(100 * top1 / nT, 2), top3=round(100 * top3 / nT, 2),
                sse=int(sse), n=nT, conf=conf)


# ------------------------------------------------------------------- main --

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--epochs', type=int, default=60)
    ap.add_argument('--dim', type=int, default=64)
    ap.add_argument('--batch', type=int, default=128)
    ap.add_argument('--lr', type=float, default=3e-3)
    ap.add_argument('--pen-only', action='store_true', help='train on pen-prose only')
    ap.add_argument('--no-pen', action='store_true',
                    help='train on photo dirs only — the control for "is the pen data used at all"')
    ap.add_argument('--arch', default='base', choices=list(ARCHES))
    ap.add_argument('--angles', action='store_true',
                    help='tangent field as 2 extra channels, computed on the 32x32 raster')
    ap.add_argument('--angles-hires', action='store_true',
                    help='same, but computed on the FULL-RESOLUTION crop and then downsampled')
    ap.add_argument('--cross', action='store_true',
                    help='row + column ink-crossing profiles as 2 extra channels, '
                         'counted on the 32x32 raster AFTER augmentation')
    ap.add_argument('--cross-hires', action='store_true',
                    help='same, but counted on the FULL-RESOLUTION crop — where two '
                         'runs a 32x32 resample would weld are still two')
    ap.add_argument('--cross-branch', action='store_true',
                    help='the profiles as a 1-D side branch joined at the embedding, '
                         'instead of broadcast planes')
    ap.add_argument('--dump', action='store_true', help='write test images + reference embeddings')
    ap.add_argument('--test-dir', default=TEST_DIR, help='which glyph set is the held-out test')
    ap.add_argument('--add-templates', default='',
                    help='extra glyph dirs contributed as TEMPLATES only, never scored — '
                         'the "does a bigger bank help / does mixing media help" question')
    ap.add_argument('--add-spc', type=int, default=9)
    ap.add_argument('--spc', type=int, default=0,
                    help='templates per class (0 = every test crop is also a template)')
    ap.add_argument('--geoW', type=float, default=0.0,
                    help='diagnostic: fuse the size cues normalisation discards')
    ap.add_argument('--crossW', default='',
                    help='diagnostic: comma-separated weights at which to fuse the crossing '
                         'profiles as a DISTANCE, the way geoW fuses the size cues')
    ap.add_argument('--seeds', type=int, default=1, help='train N models and report mean +- sd')
    ap.add_argument('--out', default=os.path.join(ROOT, 'cnnlab', 'model.npz'))
    args = ap.parse_args()

    import torch
    import torch.nn as nn
    global SIZE, INK
    SIZE = ARCHES[args.arch][0]
    INK = int(round(SIZE * 0.75))

    print('test set:')
    HI = args.angles_hires
    HX = args.cross_hires
    Xt, Yt, Mt, Gt, Ct = build([args.test_dir], hires_angles=HI, hires_cross=HX)
    classes = sorted(set(Yt))
    print(f'  {len(Xt)} crops, {len(classes)} classes')

    print('train set (never the test crops):')
    # the test dir is ALWAYS excluded from training; that is the whole protocol
    base = PEN_DIRS if args.pen_only else PHOTO_DIRS if args.no_pen else PEN_DIRS + PHOTO_DIRS
    dirs = [d for d in base if d != args.test_dir]
    Xr, Yr, Mr, _Gr, _Cr = build(dirs, hires_angles=HI, hires_cross=HX)
    # train only on classes the test set actually contains; the head is thrown
    # away afterwards, but a class with no test presence just adds noise
    keep = [i for i, y in enumerate(Yr) if y in classes]
    Xr, Yr = Xr[keep], [Yr[i] for i in keep]
    yr = np.array([classes.index(c) for c in Yr])
    print(f'  {len(Xr)} crops over {len(set(Yr))} of the {len(classes)} test classes')

    CIN = 3 if (args.angles or HI or args.cross or HX) else 1
    XC = args.cross
    AUX = 2 * SIZE if args.cross_branch else 0

    def prof(batch):
      """the branch's input, counted on whatever raster the net is being shown —
      so augmentation can never desynchronise the two"""
      return np.stack([cross_feat_from_raster(b) for b in batch]) if AUX else None

    def run(seed):
      torch.manual_seed(seed)
      rng = np.random.default_rng(seed)
      model = make_model(torch, nn, len(classes), args.dim, args.arch, CIN, AUX)
      opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
      sched = torch.optim.lr_scheduler.OneCycleLR(
        opt, max_lr=args.lr, total_steps=args.epochs * max(1, len(Xr) // args.batch))
      lossf = nn.CrossEntropyLoss(label_smoothing=0.1)
      # rebuilt here: --add-templates appends rows to Xt AFTER the arg parse
      Xv = torch.from_numpy(to_input(Xt, args.angles, XC))
      Av = torch.from_numpy(prof(Xt)) if AUX else None
      # VALIDATION SPLIT from the TRAINING data (every 8th row), so the epoch is
      # chosen against data the test set never sees — the standing "epochs were
      # picked against the test set" caveat, closed.
      vi = np.arange(len(Xr)) % 8 == 0
      Xtr, ytr = Xr[~vi], yr[~vi]
      Xva = torch.from_numpy(to_input(Xr[vi], args.angles, XC))
      Ava = torch.from_numpy(prof(Xr[vi])) if AUX else None
      yva = torch.from_numpy(yr[vi]).long()
      bestVal, bestState = -1.0, None
      for ep in range(args.epochs):
        model.train()
        perm = rng.permutation(len(Xtr))
        tot = nb = 0
        for s in range(0, len(perm) - args.batch + 1, args.batch):
            idx = perm[s:s + args.batch]
            aug = (augment_planes if HI else augment_cross if HX else augment)
            av = aug(Xtr[idx], rng)
            xb = torch.from_numpy(to_input(av, args.angles, XC))
            ab = torch.from_numpy(prof(av)) if AUX else None
            yb = torch.from_numpy(ytr[idx]).long()
            opt.zero_grad()
            loss = lossf(model(xb, ab), yb)
            loss.backward()
            opt.step()
            sched.step()
            tot += loss.item()
            nb += 1
        model.eval()
        with torch.no_grad():
            va = float((model(Xva, Ava).argmax(1) == yva).float().mean())
        if va > bestVal:
            bestVal, bestState = va, {k: v.clone() for k, v in model.state_dict().items()}
        model.train()
      model.load_state_dict(bestState)
      model.eval()
      with torch.no_grad():
          emb = model.embed(Xv, Av).numpy()
          logits = model(Xv, Av).numpy()
      print(f'    best val {bestVal:.4f}')
      return model, emb, logits

    nparam0 = sum(p.numel() for p in
                  make_model(torch, nn, len(classes), args.dim, args.arch, CIN, AUX).parameters())
    infer = nparam0 - (args.dim * len(classes) + len(classes))
    mm = macs_of(args.arch, args.dim, len(classes), CIN) + AUX * AUX_H + AUX_H * AUX_H
    print(f'model[{args.arch}] {SIZE}x{SIZE} cin{CIN} aux{AUX}: {nparam0} params, {infer} at inference '
          f'({infer / 1024:.0f} KB int8), {mm/1e6:.2f} MMAC/glyph')

    # spc: keep the first N of each class as templates, exactly as
    # sweep-pen.cjs's group() does, so a matcher arm can be run on the same set
    tmplMask = None
    if args.spc:
        tmplMask = np.zeros(len(Yt), bool)
        seen = {}
        for i, y in enumerate(Yt):
            seen[y] = seen.get(y, 0) + 1
            if seen[y] <= args.spc:
                tmplMask[i] = True
        print(f'templates: {int(tmplMask.sum())} of {len(Yt)} (spc {args.spc})')

    # extra templates: appended after the test rows, marked template-only
    nTest = len(Xt)
    if args.add_templates:
        print('extra templates:')
        Xa, Ya, _, Ga, Ca = build([d for d in args.add_templates.split(',')],
                                  hires_angles=HI, hires_cross=HX)
        pick, seen = [], {}
        for i, y in enumerate(Ya):
            if y not in classes:
                continue
            seen[y] = seen.get(y, 0) + 1
            if seen[y] <= args.add_spc:
                pick.append(i)
        Xt = np.concatenate([Xt, Xa[pick]])
        Gt = np.concatenate([Gt, Ga[pick]])
        Ct = np.concatenate([Ct, Ca[pick]])
        Yt = Yt + [Ya[i] for i in pick]
        if tmplMask is not None:
            tmplMask = np.concatenate([tmplMask, np.ones(len(pick), bool)])
        print(f'  +{len(pick)} template-only rows from {args.add_templates}')

    cw = [float(v) for v in args.crossW.split(',') if v.strip()]
    seeds = list(range(args.seeds))
    runs = []
    for sd in seeds:
        model, emb, logits = run(sd)
        r = loo_score(emb, Yt, classes, tmplMask=tmplMask, nTest=nTest)
        rn = loo_score(emb, Yt, classes, 'nn', tmplMask=tmplMask, nTest=nTest)
        rg = {gw: loo_score(emb, Yt, classes, 'p2', Gt, gw, tmplMask=tmplMask, nTest=nTest)
              for gw in (0.15, 0.3, 0.6)}
        rc = {w: loo_score(emb, Yt, classes, 'p2', tmplMask=tmplMask, nTest=nTest,
                           cross=Ct, crossW=w) for w in cw}
        cls_idx = np.array([classes.index(c) for c in Yt])
        order = np.argsort(-logits, axis=1)
        soft = float((order[:, 0] == cls_idx).mean() * 100)
        runs.append((r, rn, rg, soft, emb, rc))
        print(f'  seed {sd}: p2 {r["top1"]:.2f}  nn {rn["top1"]:.2f}  '
              + '  '.join(f'geo{g} {v["top1"]:.2f}' for g, v in rg.items())
              + '  '.join(f'  cross{w} {v["top1"]:.2f}' for w, v in rc.items())
              + f'  softmax {soft:.2f}')

    def ms(vals):
        a = np.array(vals, float)
        return f'{a.mean():6.2f} +- {a.std(ddof=1) if len(a) > 1 else 0:.2f}'

    print('\n--- leave-one-out on the 675 pen drill glyphs, %d seeds -------' % len(seeds))
    print('arm                                     top1            top3     sse')
    print(f'test dir {args.test_dir}, {len(Xt)} crops')
    print(f'cnn embedding + kNN (best^2*second)     {ms([r[0]["top1"] for r in runs])}   '
          f'{np.mean([r[0]["top3"] for r in runs]):.2f}   {np.mean([r[0]["sse"] for r in runs]):.0f}')
    print(f'cnn embedding + kNN (nearest template)  {ms([r[1]["top1"] for r in runs])}')
    for gw in (0.15, 0.3, 0.6):
        print(f'  + size cues (diagnostic, geoW {gw})     {ms([r[2][gw]["top1"] for r in runs])}   '
              f'{np.mean([r[2][gw]["top3"] for r in runs]):.2f}   {np.mean([r[2][gw]["sse"] for r in runs]):.0f}')
    for w in cw:
        print(f'  + crossing profiles (crossW {w})        {ms([r[5][w]["top1"] for r in runs])}   '
              f'{np.mean([r[5][w]["top3"] for r in runs]):.2f}   {np.mean([r[5][w]["sse"] for r in runs]):.0f}')
    print(f'cnn softmax head (no templates)         {ms([r[3] for r in runs])}')

    emb = runs[0][4]
    logits = None

    r = loo_score(emb, Yt, classes)
    print('\ntop confusions: ' + '  '.join(f'{k}x{v}' for k, v in r['conf'].most_common(15)))
    np.savez(args.out, **{k: v.detach().numpy() for k, v in model.state_dict().items()},
             classes=np.array(classes), arch=np.array(args.arch), dim=np.array(args.dim))
    if args.dump:
        # the EXACT inputs the wasm kernel will be verified against, so a
        # mismatch can only be the kernel and never the preprocessing
        Xt.astype(np.float32).tofile(os.path.join(ROOT, 'cnnlab', 'test-images.f32'))
        emb.astype(np.float32).tofile(os.path.join(ROOT, 'cnnlab', 'test-embed.f32'))
        json.dump({'classes': classes, 'labels': Yt, 'size': int(SIZE), 'dim': int(args.dim),
                   'geo': Gt.tolist()},
                  open(os.path.join(ROOT, 'cnnlab', 'test-meta.json'), 'w'))
        print(f'dumped {len(Xt)} test images + reference embeddings')
    print(f'wrote {os.path.relpath(args.out, ROOT)}')


if __name__ == '__main__':
    main()
