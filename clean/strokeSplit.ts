/**
 * STROKE SEPARATION for a welded component.
 *
 * A descender that lands on the line below welds two lines' letters into one
 * connected component. Neither a ROW cut nor a geodesic competition can take
 * that apart correctly: warehouse2's `Parking` has a g whose loop runs the
 * full depth of the next line's x-height band and is welded, at its bottom,
 * to the `e` of `new` — a row cut above the weld hands the top of the `e` to
 * `Parking`, a row cut below it hands the loop's bottom to `new`, and any
 * zone rule calls the loop lower-line ink because that is where it sits.
 *
 * What the pen did is recoverable from the ink's SKELETON. Thin the component
 * (Zhang-Suen), read the skeleton as a graph — endpoints, junctions, the arcs
 * between them — and at each junction pair the two arcs that continue each
 * other (the smallest turning angle): a stroke passes THROUGH a junction, a
 * different stroke branches OFF it. The paired arcs are chains, i.e. the pen
 * strokes as far as the raster can tell; every ink pixel then belongs to the
 * chain of its nearest skeleton pixel. The caller decides which line a chain
 * belongs to — by WHERE IT STARTS, not where it sits: a chain whose top
 * touches the upper line's zone hangs from that line however deep it reaches.
 *
 * Used by `separateCrossLine` (ccWordSeg.ts, raw components before the
 * character boxes exist) and by `componentOwnership` (ccOwnership.ts, segPage
 * components before the line crops are cut) — one definition, so the two
 * stages agree about what a stroke is.
 */

export interface StrokeUnit {
  /** unit id (index into `units`) */
  id: number;
  /** a CYCLE (a closed stroke, or a letter's counter — a biconnected block of the
   *  skeleton graph) or a CHAIN (open arcs paired through junctions by tangent
   *  continuity: a stroke passing through, or a tail) */
  kind: 'cycle' | 'chain';
  /** ink pixels (local indices) */
  pixels: number[];
  x0: number; y0: number; x1: number; y1: number;
  /** skeleton pixel count */
  skel: number;
  /** for a chain: the units it is ATTACHED to at its two ends (a chain that
   *  passes THROUGH a junction is not attached there — only its ends attach) */
  ends: number[];
  /** every other unit sharing a junction with this one (cycles that touch, a
   *  chain and the loop it branches off) */
  touches: number[];
}

export interface StrokeSplit {
  /** per local pixel: unit id, -1 = not ink */
  unitOf: Int16Array;
  units: StrokeUnit[];
}

const N8: [number, number][] = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/** Zhang-Suen thinning on a binary local mask (1 = ink). Returns the skeleton mask. */
export function thinZhangSuen(mask: Uint8Array, w: number, h: number): Uint8Array {
  const img = new Uint8Array(mask);
  const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? 0 : img[y * w + x]);
  let changed = true;
  const del: number[] = [];
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!img[y * w + x]) continue;
          const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y), p5 = at(x + 1, y + 1);
          const p6 = at(x, y + 1), p7 = at(x - 1, y + 1), p8 = at(x - 1, y), p9 = at(x - 1, y - 1);
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let a = 0;
          for (let i = 0; i < 8; i++) if (seq[i] === 0 && seq[i + 1] === 1) a++;
          if (a !== 1) continue;
          if (step === 0) {
            if (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) continue;
          } else if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue;
          del.push(y * w + x);
        }
      }
      if (del.length) { changed = true; for (const i of del) img[i] = 0; }
    }
  }
  return img;
}

interface Arc { a: number; b: number; pix: number[]; dead?: boolean; bcc: number }

/**
 * Split a component's ink into stroke UNITS — cycles and chains.
 * `mask` is the component's ink (1) on a local w×h grid; `penW` the stroke
 * width in px (spurs shorter than it are noise on their stroke; junction
 * pixels within it are one junction). Returns null when the skeleton has no
 * junction at all — one stroke, nothing to separate.
 */
export function splitStrokes(mask: Uint8Array, w: number, h: number, penW: number): StrokeSplit | null {
  const n = w * h;
  // CLOSE one-pixel breaks before thinning. A stroke rendered a shade too
  // light at one pixel (warehouse2's g-loop has one, on its right side) turns
  // a closed loop into a U in the skeleton graph, and a U is not a cycle. A
  // 3x3 closing bridges that; the pixels it adds serve the TOPOLOGY only —
  // every labelled pixel below is one of the caller's own.
  const closed = new Uint8Array(n);
  {
    const dil = new Uint8Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h) dil[yy * w + xx] = 1;
      }
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let all = 1;
      for (let dy = -1; dy <= 1 && all; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h || !dil[yy * w + xx]) { all = 0; break; }
      }
      closed[y * w + x] = all;
    }
    for (let i = 0; i < n; i++) if (mask[i]) closed[i] = 1;
  }
  const skel = thinZhangSuen(closed, w, h);
  const deg = new Int8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!skel[i]) { deg[i] = -1; continue; }
      let d = 0;
      for (const [dx, dy] of N8) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        if (skel[yy * w + xx]) d++;
      }
      deg[i] = d;
    }
  }
  // NODES: junction pixels (deg >= 3) clustered within penW, then endpoints (deg 1)
  const nodeOf = new Int32Array(n).fill(-1);
  const nodes: { x: number; y: number; pix: number[]; junction: boolean }[] = [];
  const reach = Math.max(1, Math.round(penW));
  for (let i = 0; i < n; i++) {
    if (deg[i] < 3 || nodeOf[i] >= 0) continue;
    const pix = [i];
    nodeOf[i] = nodes.length;
    const q: [number, number][] = [[i, 0]];
    for (let head = 0; head < q.length; head++) {
      const [p, d] = q[head];
      if (d >= reach) continue;
      const py = (p / w) | 0, px = p - py * w;
      for (const [dx, dy] of N8) {
        const xx = px + dx, yy = py + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (!skel[j] || nodeOf[j] >= 0) continue;
        if (deg[j] >= 3) { nodeOf[j] = nodes.length; pix.push(j); q.push([j, 0]); }
        else if (d + 1 < reach) q.push([j, d + 1]);
      }
    }
    let sx = 0, sy = 0;
    for (const p of pix) { sy += (p / w) | 0; sx += p % w; }
    nodes.push({ x: sx / pix.length, y: sy / pix.length, pix, junction: true });
  }
  if (!nodes.length) return null;
  for (let i = 0; i < n; i++) {
    if (deg[i] === 1 && nodeOf[i] < 0) { nodeOf[i] = nodes.length; nodes.push({ x: i % w, y: (i / w) | 0, pix: [i], junction: false }); }
  }
  // ARCS: walk skeleton pixels from each node until another node
  const arcOf = new Int32Array(n).fill(-1);
  const arcs: Arc[] = [];
  for (let ni = 0; ni < nodes.length; ni++) {
    for (const p of nodes[ni].pix) {
      const py = (p / w) | 0, px = p - py * w;
      for (const [dx, dy] of N8) {
        const xx = px + dx, yy = py + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (!skel[j] || nodeOf[j] >= 0 || arcOf[j] >= 0) continue;
        const pix: number[] = [];
        let cur = j, prev = p, end = -1;
        const id = arcs.length;
        for (let guard = 0; guard < n; guard++) {
          arcOf[cur] = id;
          pix.push(cur);
          const cy = (cur / w) | 0, cx = cur - cy * w;
          let next = -1;
          for (const [ex, ey] of N8) {
            const nx = cx + ex, ny = cy + ey;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const k = ny * w + nx;
            if (!skel[k] || k === prev) continue;
            if (nodeOf[k] >= 0) { if (nodeOf[k] !== ni || pix.length > 2) { end = nodeOf[k]; next = -1; break; } continue; }
            if (arcOf[k] >= 0) continue;
            next = k;
          }
          if (end >= 0 || next < 0) break;
          prev = cur; cur = next;
        }
        arcs.push({ a: ni, b: end, pix, bcc: -1 });
      }
    }
  }
  // a walk that ended nowhere (a stray skeleton fragment) ends at its own start
  for (const arc of arcs) if (arc.b < 0) arc.b = arc.a;
  // PRUNE spurs: an arc ending at an endpoint node, shorter than penW, hanging off a junction
  for (const arc of arcs) {
    const endA = !nodes[arc.a].junction, endB = !nodes[arc.b].junction;
    if (endA !== endB && arc.pix.length < penW) arc.dead = true;
  }
  const live = arcs.map((arc, i) => i).filter((i) => !arcs[i].dead);
  if (!live.length) return null;
  const trace = (globalThis as { __strokeTrace?: boolean }).__strokeTrace;
  if (trace) {
    console.log(`[strokes] ${nodes.length} nodes: ` + nodes.map((nd, i) => `${i}${nd.junction ? 'J' : 'E'}(${nd.x.toFixed(0)},${nd.y.toFixed(0)}|${nd.pix.length})`).join(' '));
  }

  // BICONNECTED COMPONENTS over the live arcs (a multigraph: two arcs between
  // the same nodes are a two-edge cycle, and a self-loop is a cycle). Every
  // block with a cycle in it is a CLOSED STROKE — a g's loop, an e's counter;
  // a block that is one arc is a bridge, part of some open chain.
  const adj: number[][] = nodes.map(() => []);
  for (const i of live) { adj[arcs[i].a].push(i); if (arcs[i].b !== arcs[i].a) adj[arcs[i].b].push(i); }
  const disc = new Int32Array(nodes.length).fill(-1);
  const low = new Int32Array(nodes.length);
  let time = 0, nBcc = 0;
  const stack: number[] = [];
  const dfs = (u: number, parentArc: number): void => {
    disc[u] = low[u] = time++;
    for (const ai of adj[u]) {
      if (ai === parentArc) continue;
      const arc = arcs[ai];
      const v = arc.a === u ? arc.b : arc.a;
      if (arc.bcc >= 0) continue;
      if (disc[v] < 0) {
        stack.push(ai);
        dfs(v, ai);
        low[u] = Math.min(low[u], low[v]);
        if (low[v] >= disc[u]) {
          const id = nBcc++;
          for (;;) { const t = stack.pop() as number; arcs[t].bcc = id; if (t === ai) break; }
        }
      } else if (disc[v] < disc[u] || v === u) {
        stack.push(ai);
        if (v === u) { arcs[ai].bcc = nBcc++; stack.pop(); }
        else low[u] = Math.min(low[u], disc[v]);
      }
    }
  };
  for (let u = 0; u < nodes.length; u++) if (disc[u] < 0 && adj[u].length) dfs(u, -1);
  for (const i of live) if (arcs[i].bcc < 0) arcs[i].bcc = nBcc++;
  const bccSize = new Map<number, number>();
  for (const i of live) bccSize.set(arcs[i].bcc, (bccSize.get(arcs[i].bcc) || 0) + 1);
  const isCycle = (i: number): boolean => (bccSize.get(arcs[i].bcc) || 0) >= 2 || arcs[i].a === arcs[i].b;
  if (trace) {
    console.log(`[strokes] arcs: ` + arcs.map((arc, i) => `#${i} ${arc.a}-${arc.b} len${arc.pix.length}${arc.dead ? ' DEAD' : ` bcc${arc.bcc}${isCycle(i) ? 'C' : ''}`} path ${arc.pix.map((q) => `${q % w},${(q / w) | 0}`).join(' ')}`).join('\n   '));
  }

  // CHAINS over the bridge arcs: at each junction pair the two whose
  // directions continue each other (a stroke passing through turns least).
  // A bridge never pairs with a cycle arc — a bridge meeting a loop is a branch.
  const parent = arcs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const dirAt = (arc: Arc, node: number): [number, number] => {
    const pix = arc.a === node ? arc.pix : [...arc.pix].reverse();
    const k = Math.min(pix.length - 1, Math.max(2, Math.round(penW * 1.5)));
    const p0 = pix[0], p1 = pix[k];
    const dx = (p1 % w) - (p0 % w), dy = ((p1 / w) | 0) - ((p0 / w) | 0);
    const L = Math.hypot(dx, dy) || 1;
    return [dx / L, dy / L];
  };
  const passes = new Set<string>();           // `${arcIdx}@${node}` = the chain continues through this node
  for (let ni = 0; ni < nodes.length; ni++) {
    if (!nodes[ni].junction) continue;
    const here = live.filter((i) => !isCycle(i) && (arcs[i].a === ni || arcs[i].b === ni));
    if (here.length < 2) continue;
    const dirs = here.map((i) => dirAt(arcs[i], ni));
    const used = new Set<number>();
    const pairs: [number, number, number][] = [];
    for (let p = 0; p < here.length; p++) for (let q = p + 1; q < here.length; q++) {
      pairs.push([dirs[p][0] * dirs[q][0] + dirs[p][1] * dirs[q][1], p, q]);
    }
    pairs.sort((u, v) => u[0] - v[0]);
    for (const [cos, p, q] of pairs) {
      if (cos > -0.5) break;                    // over 120° of turn is a branch, not a continuation
      if (used.has(p) || used.has(q)) continue;
      used.add(p); used.add(q);
      parent[find(here[p])] = find(here[q]);
      passes.add(`${here[p]}@${ni}`); passes.add(`${here[q]}@${ni}`);
    }
  }
  // cycle arcs of one block are one unit
  for (const i of live) if (isCycle(i)) for (const j of live) if (j !== i && arcs[j].bcc === arcs[i].bcc) parent[find(i)] = find(j);
  // dead spurs join a live arc at their junction
  for (let i = 0; i < arcs.length; i++) {
    const arc = arcs[i];
    if (!arc.dead) continue;
    const j = nodes[arc.a].junction ? arc.a : arc.b;
    const host = live.find((o) => arcs[o].a === j || arcs[o].b === j);
    if (host !== undefined) parent[find(i)] = find(host);
  }
  const unitId = new Map<number, number>();
  const unitOf = new Int16Array(n).fill(-1);
  const seeds: number[] = [];
  const kinds: ('cycle' | 'chain')[] = [];
  for (const i of live) {
    const r = find(i);
    if (!unitId.has(r)) { unitId.set(r, unitId.size); kinds.push(isCycle(i) ? 'cycle' : 'chain'); }
  }
  if (unitId.size < 2) return null;
  for (let i = 0; i < arcs.length; i++) {
    const r = find(i);
    if (!unitId.has(r)) continue;
    const u = unitId.get(r)!;
    for (const p of arcs[i].pix) { unitOf[p] = u; seeds.push(p); }
  }
  // ATTACHMENTS: a chain's END at a junction attaches it to the units there
  const ends: Set<number>[] = [];
  for (let u = 0; u < unitId.size; u++) ends.push(new Set());
  for (const i of live) {
    if (isCycle(i)) continue;
    const u = unitId.get(find(i))!;
    for (const node of [arcs[i].a, arcs[i].b]) {
      if (!nodes[node].junction || passes.has(`${i}@${node}`)) continue;
      for (const o of live) {
        if (o === i || (arcs[o].a !== node && arcs[o].b !== node)) continue;
        const v = unitId.get(find(o))!;
        if (v !== u) ends[u].add(v);
      }
    }
  }
  // junction node pixels take the unit of a cycle through them, else the first live arc
  for (let ni = 0; ni < nodes.length; ni++) {
    const at = live.filter((o) => arcs[o].a === ni || arcs[o].b === ni);
    if (!at.length) continue;
    const host = at.find((o) => isCycle(o)) ?? at[0];
    const u = unitId.get(find(host))!;
    for (const p of nodes[ni].pix) if (unitOf[p] < 0) { unitOf[p] = u; seeds.push(p); }
  }
  // every ink pixel takes the unit of its nearest skeleton pixel (BFS through the ink)
  const q = seeds.slice();
  for (let head = 0; head < q.length; head++) {
    const p = q[head];
    const u = unitOf[p];
    const py = (p / w) | 0, px = p - py * w;
    for (const [dx, dy] of N8) {
      const xx = px + dx, yy = py + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (!mask[j] || unitOf[j] >= 0) continue;
      unitOf[j] = u;
      q.push(j);
    }
  }
  const touches: Set<number>[] = [];
  for (let u = 0; u < unitId.size; u++) touches.push(new Set());
  for (let ni = 0; ni < nodes.length; ni++) {
    if (!nodes[ni].junction) continue;
    const here = new Set<number>();
    for (const o of live) if (arcs[o].a === ni || arcs[o].b === ni) here.add(unitId.get(find(o))!);
    for (const u of here) for (const v of here) if (u !== v) touches[u].add(v);
  }
  const units: StrokeUnit[] = [];
  for (let u = 0; u < unitId.size; u++) units.push({ id: u, kind: kinds[u], pixels: [], x0: w, y0: h, x1: -1, y1: -1, skel: 0, ends: [...ends[u]], touches: [...touches[u]] });
  for (let i = 0; i < n; i++) {
    const u = unitOf[i];
    if (u < 0) continue;
    const un = units[u];
    const y = (i / w) | 0, x = i - y * w;
    un.pixels.push(i);
    if (x < un.x0) un.x0 = x; if (x > un.x1) un.x1 = x; if (y < un.y0) un.y0 = y; if (y > un.y1) un.y1 = y;
    if (skel[i]) un.skel++;
  }
  return { unitOf, units };
}

/**
 * Give every unit a LINE. `judge(unit)` is the caller's own evidence — 0 for
 * the upper line, 1 for the lower, -1 when the unit's own position says
 * nothing (its top sits in the gutter). The undecided then FOLLOW what they
 * are attached to: a loop or a tail hanging off a stroke of the upper line
 * is the upper line's however deep it reaches, and a chain branching off a
 * lower letter's counter is that letter's. Attached to both, upper wins — a
 * descender belongs to the letter it hangs from — and a unit attached to
 * nothing decided is judged by `fallback`. Returns the per-unit line.
 */
export function resolveUnitLines(
  sp: StrokeSplit,
  judge: (u: StrokeUnit) => number,
  fallback: (u: StrokeUnit) => number,
): Int16Array {
  const line = new Int16Array(sp.units.length).fill(-1);
  for (const u of sp.units) line[u.id] = judge(u);
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (const u of sp.units) {
      if (line[u.id] >= 0) continue;
      let up = false, down = false;
      for (const v of [...u.ends, ...u.touches]) {
        if (line[v] === 0) up = true;
        else if (line[v] === 1) down = true;
      }
      if (up) { line[u.id] = 0; moved = true; }
      else if (down) { line[u.id] = 1; moved = true; }
    }
    if (!moved) break;
  }
  for (const u of sp.units) if (line[u.id] < 0) line[u.id] = fallback(u);
  return line;
}
