// Deterministic synthetic "photo" of a ruled page with handwriting-like
// squiggles: cream paper, blue rules, red margin line, lighting gradient,
// slight rotation, dark desk background, noise. Pure pixel code so it runs
// in both the browser and Node (smoke tests).

export function makeSample(opts = {}) {
  const W = opts.width ?? 900;
  const H = opts.height ?? 1200;
  let s = (opts.seed ?? 42) >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

  const data = new Uint8ClampedArray(W * H * 4);

  // dark desk background with texture
  for (let i = 0; i < W * H; i++) {
    const v = 65 + rnd() * 22;
    data[i * 4] = v * 0.95;
    data[i * 4 + 1] = v * 0.8;
    data[i * 4 + 2] = v * 0.62;
    data[i * 4 + 3] = 255;
  }

  // ---- render the page in page space ----
  const PW = Math.round(W * 0.78);
  const PH = Math.round(H * 0.82);
  const page = new Uint8ClampedArray(PW * PH * 3);
  const inked = new Uint8Array(PW * PH); // 1 = something drawn here

  const RULE_GAP = opts.ruleGap ?? 46;
  const RULE_START = 80;
  // `marginSide: 'right'` mirrors the margin rule to the right edge and the
  // writing stops short of it, as on a right-hand-margin notebook. The default
  // (left) path is arithmetic-identical to what it was, so every existing
  // fixture renders byte for byte as before.
  const MARGIN_RIGHT = opts.marginSide === 'right';
  const MARGIN_X = MARGIN_RIGHT ? Math.round(W * 0.78) - 70 : 70;

  const putInk = (x, y, r, g, b, rad) => {
    for (let oy = -rad; oy <= rad; oy++) {
      for (let ox = -rad; ox <= rad; ox++) {
        const px = Math.round(x + ox);
        const py = Math.round(y + oy);
        if (px < 0 || py < 0 || px >= PW || py >= PH) continue;
        const i = (py * PW + px) * 3;
        page[i] = r;
        page[i + 1] = g;
        page[i + 2] = b;
        inked[py * PW + px] = 1;
      }
    }
  };

  // paper base with a diagonal lighting gradient
  for (let y = 0; y < PH; y++) {
    for (let x = 0; x < PW; x++) {
      const L = 1 - 0.32 * (0.5 * (x / PW) + 0.5 * (y / PH));
      const i = (y * PW + x) * 3;
      page[i] = 247 * L;
      page[i + 1] = 242 * L;
      page[i + 2] = 226 * L;
    }
  }

  // horizontal rules. `ruled: false` is PLAIN paper — no printed lines at all,
  // which is the case that exposes the rule tracer finding "rules" in dense
  // writing (it is a peak finder over horizontal line-energy, and writing has
  // plenty of that).
  const RULED = opts.ruled ?? true;
  if (RULED) {
    for (let ry = RULE_START; ry < PH - 20; ry += RULE_GAP) {
      for (let x = 8; x < PW - 8; x++) {
        const L = 1 - 0.32 * (0.5 * (x / PW) + 0.5 * (ry / PH));
        for (let t = 0; t < 2; t++)
          putInk(x, ry + t, 150 * L, 160 * L, 205 * L, 0);
      }
    }
  }

  // GRID PAPER: a vertical line every `gridGap` px across the whole sheet. Drawn
  // in the rules' own colour and weight, because on real graph paper they are
  // the same printing — which is exactly why one of them gets mistaken for a
  // margin.
  if (opts.grid) {
    const GG = opts.gridGap ?? RULE_GAP;
    for (let gx = GG; gx < PW - 8; gx += GG) {
      for (let y = 8; y < PH - 8; y++) {
        const L = 1 - 0.32 * (0.5 * (gx / PW) + 0.5 * (y / PH));
        for (let t = 0; t < 2; t++)
          putInk(gx + t, y, 150 * L, 160 * L, 205 * L, 0);
      }
    }
  }

  // DOT GRID: a printed lattice of small dots. Deliberately drawn UNIFORM in
  // size and depth, because that uniformity is what the remover keys on to tell
  // a printed dot from an i-dot or a full stop.
  if (opts.dots) {
    const DX = opts.dotGap ?? 34;
    const DY = opts.dotGap ?? 34;
    for (let dy = DY; dy < PH - 10; dy += DY) {
      for (let dx = DX; dx < PW - 10; dx += DX) {
        const L = 1 - 0.32 * (0.5 * (dx / PW) + 0.5 * (dy / PH));
        putInk(dx, dy, 168 * L, 172 * L, 186 * L, 1);
      }
    }
  }

  // red margin line (optionally doubled; optionally absent)
  if (opts.margin ?? true) {
    for (let y = 8; y < PH - 8; y++) {
      const L = 1 - 0.32 * (0.5 * (MARGIN_X / PW) + 0.5 * (y / PH));
      for (let t = 0; t < 2; t++)
        putInk(MARGIN_X + t, y, 225 * L, 130 * L, 130 * L, 0);
      // Second rule of a double margin. `marginGap` is the LIGHT gap between
      // the two 2px lines, which is what the thickness probe has to span.
      if (opts.doubleMargin) {
        const off = 2 + (opts.marginGap ?? 4);
        for (let t = 0; t < 2; t++)
          putInk(MARGIN_X + off + t, y, 225 * L, 130 * L, 130 * L, 0);
      }
    }
  }

  // Detached junk near the page borders: the marks a photograph picks up that
  // are not writing — bleed-through, a torn edge, a scribble in the margin.
  // They sit ALONE, far from the words on their line, which is what the
  // segmenter's edge filter keys on.
  if (opts.edgeSpecks) {
    const blob = (cx, cy, rx, ry) => {
      for (let dy = -ry; dy <= ry; dy++)
        for (let dx = -rx; dx <= rx; dx++)
          if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1)
            putInk(cx + dx, cy + dy, 40, 40, 45, 0);
    };
    // Each sits near a border AND far from the writing — a speck dropped in the
    // middle of a line at normal word spacing is not junk, it is a word, and
    // the filter is meant to keep it.
    blob(PW - 12, Math.round(PH * 0.35), 4, 9);   // right, past the end of its line
    blob(PW - 14, Math.round(PH * 0.62), 5, 7);   // right, another line
    blob(Math.round(PW * 0.55), 6, 9, 4);         // top, above the first text line
    blob(Math.round(PW * 0.40), PH - 7, 8, 4);    // bottom, below the last
  }

  // page-edge shadow strip (for testing edge rejection)
  if (opts.edgeShadow) {
    for (let y = 0; y < PH; y++)
      for (let x = 0; x < 4; x++) {
        const i = (y * PW + x) * 3;
        page[i] = 90;
        page[i + 1] = 85;
        page[i + 2] = 80;
        inked[y * PW + x] = 1;
      }
  }

  // handwriting-like squiggles on each line, with descenders crossing rules.
  // Written at the SAME pitch whether or not the paper is ruled: an unruled page
  // still has lines of writing, and a plain-paper test with no writing on it
  // would not exercise the thing that goes wrong there.
  let lineIdx = 0;
  const HAS_MARGIN = opts.margin ?? true;
  const WRITE_LEFT = HAS_MARGIN && !MARGIN_RIGHT ? MARGIN_X + 20 : 30;
  const WRITE_RIGHT = HAS_MARGIN && MARGIN_RIGHT ? MARGIN_X - 20 : PW - 30;
  for (let ry = RULE_START; ry < PH - 40; ry += RULE_GAP, lineIdx++) {
    if (lineIdx % 5 === 4) continue; // occasional blank line
    const phase = rnd() * 6.28;
    const phase2 = rnd() * 6.28;
    const xEnd = WRITE_RIGHT - rnd() * (PW * 0.3);
    for (let x = WRITE_LEFT; x < xEnd; x++) {
      const t = (x - WRITE_LEFT) / (WRITE_RIGHT - WRITE_LEFT);
      if (Math.sin(t * 47 + phase2) > 0.72) continue; // word gaps
      const wave = Math.sin(t * 90 + phase) * 7 + Math.sin(t * 31 + phase2) * 4;
      let y = ry - 12 + wave * 0.6;
      // descender dipping below (through) the rule
      if (Math.sin(t * 23 + phase) > 0.86) y = ry + 6 + wave * 0.4;
      putInk(x, y, 38, 34, 48, 1);
    }
  }

  // noise specks on the paper
  for (let k = 0; k < 260; k++) {
    const x = rnd() * PW;
    const y = rnd() * PH;
    if (rnd() < 0.6) putInk(x, y, 120, 110, 100, 0);
  }

  // ---- composite with slight rotation onto the background ----
  const theta = (opts.angleDeg ?? 3) * (Math.PI / 180);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const cx = W / 2;
  const cy = H / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // inverse-rotate into page space
      const dx = x - cx;
      const dy = y - cy;
      const px = Math.round(cos * dx + sin * dy + PW / 2);
      const py = Math.round(-sin * dx + cos * dy + PH / 2);
      if (px < 0 || py < 0 || px >= PW || py >= PH) continue;
      const i = (y * W + x) * 4;
      const j = (py * PW + px) * 3;
      data[i] = page[j];
      data[i + 1] = page[j + 1];
      data[i + 2] = page[j + 2];
    }
  }

  return { width: W, height: H, data };
}
