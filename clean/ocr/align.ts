// Triplet-window OCR alignment — the accuracy core shared by the wordlab lab
// and the editor's import. TrOCR reads isolated words poorly; it does much better
// on a whole line of context. So we OCR each word crop (for top-K evidence) AND
// composite sliding 3-line windows, then DP-align each window's word sequence
// back to the boxes and vote across the (≤3) window positions each box appears
// in. The middle line of a window is the most accurate, so it is canonical.
//
// This module is pure logic + canvas compositing (no DOM UI, no app state): the
// caller injects an OCR fetch function and passes the per-word records. wordlab
// and the editor both consume it so there is one implementation to tune.

/** One beam-search reading of a crop. */
export interface OcrAlt {
  text: string;
  confidence: number;
}

/** The OCR transport. `topk` > 1 asks the server for that many candidates in
 *  `alternatives`; `texts`/`confidences` always carry the best reading. */
export type OcrFetch = (
  images: string[],
  topk: number,
) => Promise<{ texts: string[]; confidences: number[]; alternatives?: OcrAlt[][] }>;

export type AlignNote = 'ok' | 'split' | 'merge-first' | 'merge-second';
export type WordSource = 'first' | 'middle' | 'last';
export interface BoxAssign { words: string[]; note: AlignNote }
export interface WordCandidate { source: WordSource; words: string[]; note: AlignNote }

/** Minimal per-word record the aligner needs (Pass B's WordRec satisfies it). */
export interface AlignRec {
  index: number;
  line: number;
  box: { x: number; w: number; mergeNext?: boolean };
  smooth?: ImageData;
  scaledBaselineRow?: number;
  sdf?: { paper: number };
}

/** Result for one box: the aligned text, how it was aligned, and a confidence. */
export interface AlignedWord {
  text: string;
  note: AlignNote;
  confidence: number;
}

const WORD_TOPK_DEFAULT = 3;

/* ---------------- string similarity ---------------- */

function editDist(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const prev = Array.from({ length: n + 1 }, (_, i) => i);
  const curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    for (let k = 0; k <= n; k++) prev[k] = curr[k];
  }
  return prev[n];
}

export function wordSim(a: string, b: string): number {
  const al = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  const bl = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  const maxLen = Math.max(al.length, bl.length, 1);
  return 1 - editDist(al, bl) / maxLen;
}

export function normWord(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* ---------------- sequence alignment DP ---------------- */

/** Align a triplet's OCR word sequence to the boxes of all 3 lines via DP.
 *  Cost per match combines text similarity (triplet word vs the box's own word
 *  OCR alternatives) with position (the word's cumulative character fraction vs
 *  the box's cumulative width fraction in the composited row — this carries
 *  empty/unreadable boxes and locates the line breaks). Transitions: 1:1 (ok),
 *  2:1 (box should split), 1:2 (boxes should merge), and skips on either side. */
export function alignTripletWords(
  tripWords: string[], boxes: AlignRec[], boxAlts: OcrAlt[][],
): BoxAssign[] {
  const T = tripWords.length, B = boxes.length;
  const assigns: BoxAssign[] = Array.from({ length: B }, () => ({ words: [], note: 'ok' }));
  if (!T || !B) return assigns;

  const wLen = tripWords.map((w) => Math.max(1, normWord(w).length));
  const wCenter: number[] = [];
  {
    let acc = 0;
    for (let i = 0; i < T; i++) { wCenter.push(acc + wLen[i] / 2); acc += wLen[i] + 1; }
    const total = acc - 1;
    for (let i = 0; i < T; i++) wCenter[i] /= total;
  }
  const bW = boxes.map((r) => r.smooth?.width ?? r.box.w);
  const gap = (bW.reduce((a, b) => a + b, 0) / B) * 0.18;
  const bCenter: number[] = [];
  {
    let acc = 0;
    for (let j = 0; j < B; j++) {
      if (j > 0) acc += boxes[j].line !== boxes[j - 1].line ? gap * 2.4 : gap;
      bCenter.push(acc + bW[j] / 2);
      acc += bW[j];
    }
    for (let j = 0; j < B; j++) bCenter[j] /= acc;
  }

  const posCost = (wc: number, bc: number) => Math.min(0.8, Math.abs(wc - bc) * T * 0.15);
  const simCostAlts = (w: string, alts: OcrAlt[]) => {
    let best = -1;
    for (const a of alts) {
      if (!normWord(a.text)) continue;
      const s = wordSim(w, a.text) * (0.6 + 0.4 * a.confidence);
      if (s > best) best = s;
    }
    return best < 0 ? 0.55 : 1 - best;
  };
  const simCostStr = (w: string, ocr: string) =>
    normWord(ocr) ? 1 - wordSim(w, ocr) : 0.55;

  const SPLIT_PEN = 0.35, MERGE_PEN = 0.35, SKIP_WORD = 0.9, SKIP_BOX = 0.75;
  const INF = 1e9;
  const dp: Float64Array[] = Array.from({ length: T + 1 },
    () => new Float64Array(B + 1).fill(INF));
  const track: [number, number][][] = Array.from({ length: T + 1 }, () =>
    Array.from({ length: B + 1 }, (): [number, number] => [0, 0]));
  dp[0][0] = 0;

  for (let i = 0; i <= T; i++) {
    for (let j = 0; j <= B; j++) {
      const cur = dp[i][j];
      if (cur >= INF) continue;
      if (i < T && j < B) {
        const c = cur + simCostAlts(tripWords[i], boxAlts[j]) + posCost(wCenter[i], bCenter[j]);
        if (c < dp[i + 1][j + 1]) { dp[i + 1][j + 1] = c; track[i + 1][j + 1] = [1, 1]; }
      }
      if (i + 1 < T && j < B) {
        const combined = tripWords[i] + tripWords[i + 1];
        const wc = (wCenter[i] + wCenter[i + 1]) / 2;
        const c = cur + simCostAlts(combined, boxAlts[j]) + posCost(wc, bCenter[j]) + SPLIT_PEN;
        if (c < dp[i + 2][j + 1]) { dp[i + 2][j + 1] = c; track[i + 2][j + 1] = [2, 1]; }
      }
      if (i < T && j + 1 < B && boxes[j].line === boxes[j + 1].line) {
        const combined = (boxAlts[j][0]?.text ?? '') + (boxAlts[j + 1][0]?.text ?? '');
        const bc = (bCenter[j] + bCenter[j + 1]) / 2;
        const c = cur + simCostStr(tripWords[i], combined) + posCost(wCenter[i], bc) + MERGE_PEN;
        if (c < dp[i + 1][j + 2]) { dp[i + 1][j + 2] = c; track[i + 1][j + 2] = [1, 2]; }
      }
      if (i < T) {
        const c = cur + SKIP_WORD;
        if (c < dp[i + 1][j]) { dp[i + 1][j] = c; track[i + 1][j] = [1, 0]; }
      }
      if (j < B) {
        const c = cur + SKIP_BOX;
        if (c < dp[i][j + 1]) { dp[i][j + 1] = c; track[i][j + 1] = [0, 1]; }
      }
    }
  }

  let i = T, j = B;
  while (i > 0 || j > 0) {
    const [di, dj] = track[i][j];
    if (!di && !dj) break;
    if (di === 1 && dj === 1) {
      assigns[j - 1] = { words: [tripWords[i - 1]], note: 'ok' };
    } else if (di === 2 && dj === 1) {
      assigns[j - 1] = { words: [tripWords[i - 2], tripWords[i - 1]], note: 'split' };
    } else if (di === 1 && dj === 2) {
      assigns[j - 2] = { words: [tripWords[i - 1]], note: 'merge-first' };
      assigns[j - 1] = { words: [tripWords[i - 1]], note: 'merge-second' };
    }
    i -= di; j -= dj;
  }
  return assigns;
}

/** Confidence-weighted similarity of a candidate reading to a box's top-K word
 *  OCR readings (0 = no support, ~1 = a high-confidence reading matches). */
export function ocrSupport(alts: OcrAlt[], words: string[]): number {
  const joined = words.join('');
  let best = 0;
  for (const a of alts) {
    if (!normWord(a.text)) continue;
    const s = wordSim(joined, a.text) * (0.5 + 0.5 * a.confidence);
    if (s > best) best = s;
  }
  return best;
}

/** Pick the best candidate reading for one box across its window positions. */
export function chooseAssignment(cands: WordCandidate[], alts: OcrAlt[]): WordCandidate | null {
  const c0 = cands.filter((c) => c.words.length);
  if (!c0.length) return null;
  let best: WordCandidate | null = null;
  let bestScore = -1;
  for (const c of c0) {
    const joined = c.words.join(' ');
    let score = c.source === 'middle' ? 1.0 : 0.55;
    score += 0.6 * ocrSupport(alts, c.words);
    for (const o of c0)
      if (o !== c && normWord(o.words.join(' ')) === normWord(joined)) score += 0.3;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

/* ---------------- compositing ---------------- */

/** PNG data URL of a single crop. */
export function imageDataToDataUrl(img: ImageData): string {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

/** Composite words from one or more lines into a single horizontal, baseline-
 *  aligned row on white (paper remapped to white). Groups (= lines) run
 *  left-to-right with a wider inter-line gap. Null if nothing to composite or
 *  the row would exceed the canvas width limit. */
export function compositeLinesRow(lineGroups: AlignRec[][]): string | null {
  const groups = lineGroups
    .map((lr) => [...lr]
      .filter((r) => r.smooth && r.scaledBaselineRow !== undefined)
      .sort((a, b) => a.box.x - b.box.x))
    .filter((g) => g.length > 0);
  if (!groups.length) return null;

  const allWords = groups.flat();
  const avgH = allWords.reduce((s, r) => s + r.smooth!.height, 0) / allWords.length;
  const wordGap = Math.max(16, Math.round(avgH * 0.25));
  const groupGap = Math.max(32, Math.round(avgH * 0.6));
  const PAD = Math.max(8, Math.round(avgH * 0.15));

  const maxAbove = Math.max(...allWords.map((r) => r.scaledBaselineRow!));
  const maxBelow = Math.max(...allWords.map((r) => r.smooth!.height - r.scaledBaselineRow!));

  let totalW = PAD * 2;
  groups.forEach((gr, gi) => {
    totalW += gr.reduce((s, r) => s + r.smooth!.width, 0) + wordGap * (gr.length - 1);
    if (gi < groups.length - 1) totalW += groupGap;
  });
  const totalH = PAD * 2 + maxAbove + maxBelow;
  const baseY = PAD + maxAbove;
  if (totalW > 32000) return null;

  const c = document.createElement('canvas');
  c.width = Math.max(1, totalW); c.height = Math.max(1, totalH);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);

  let x = PAD;
  for (let gi = 0; gi < groups.length; gi++) {
    for (const r of groups[gi]) {
      const src = r.smooth!;
      const paper = r.sdf?.paper ?? 250;
      const k = 255 / Math.max(paper, 1);
      const norm = new ImageData(src.width, src.height);
      for (let jj = 0; jj < src.width * src.height; jj++) {
        const v = Math.min(255, Math.round(src.data[jj * 4] * k));
        norm.data[jj * 4] = norm.data[jj * 4 + 1] = norm.data[jj * 4 + 2] = v;
        norm.data[jj * 4 + 3] = 255;
      }
      const tmp = document.createElement('canvas');
      tmp.width = src.width; tmp.height = src.height;
      tmp.getContext('2d')!.putImageData(norm, 0, 0);
      ctx.drawImage(tmp, x, baseY - r.scaledBaselineRow!);
      x += src.width + wordGap;
    }
    if (gi < groups.length - 1) x += groupGap - wordGap;
  }
  return c.toDataURL('image/png');
}

/* ---------------- orchestration ---------------- */

const EMPTY = { texts: [] as string[], confidences: [] as number[], alternatives: [] as OcrAlt[][] };

/**
 * Run the full triplet-window OCR alignment over `recs` and return the best
 * text (+ note + confidence) for each box, keyed by `rec.index`. Boxes with no
 * confident reading are absent from the map. `note` distinguishes clean 1:1
 * reads from `split`/`merge-first`/`merge-second` (which the caller may act on
 * for reflow). Does not mutate `recs`.
 */
export async function alignOcr(
  recs: AlignRec[],
  fetchOcr: OcrFetch,
  opts: { wordTopk?: number } = {},
): Promise<Map<number, AlignedWord>> {
  const out = new Map<number, AlignedWord>();
  const wordRecs = recs.filter((r) => r.smooth);
  if (!wordRecs.length) return out;

  const wordTopk = opts.wordTopk ?? WORD_TOPK_DEFAULT;

  const lineMap = new Map<number, AlignRec[]>();
  for (const r of recs) {
    if (!lineMap.has(r.line)) lineMap.set(r.line, []);
    lineMap.get(r.line)!.push(r);
  }
  const lineNums = [...lineMap.keys()].sort((a, b) => a - b);
  const sortedLine = (ln: number) =>
    [...(lineMap.get(ln) ?? [])].sort((a, b) => a.box.x - b.box.x);

  const tripletJobs: { startIdx: number; url: string }[] = [];
  for (let i = 0; i <= lineNums.length - 3; i++) {
    const url = compositeLinesRow([0, 1, 2].map((k) => sortedLine(lineNums[i + k])));
    if (url) tripletJobs.push({ startIdx: i, url });
  }

  const [wordData, tripData] = await Promise.all([
    fetchOcr(wordRecs.map((r) => imageDataToDataUrl(r.smooth!)), wordTopk),
    tripletJobs.length ? fetchOcr(tripletJobs.map((j) => j.url), 1) : Promise.resolve(EMPTY),
  ]);

  const alts = new Map<number, OcrAlt[]>();
  const bestConf = new Map<number, number>();
  wordRecs.forEach((r, i) => {
    const a = wordData.alternatives?.[i];
    alts.set(r.index, a?.length
      ? a
      : [{ text: wordData.texts[i] ?? '', confidence: wordData.confidences?.[i] ?? 0 }]);
    bestConf.set(r.index, wordData.confidences?.[i] ?? 0);
  });

  const candidates = new Map<number, WordCandidate[]>();
  const sources: WordSource[] = ['first', 'middle', 'last'];
  tripletJobs.forEach(({ startIdx }, ti) => {
    const tripWords = (tripData.texts[ti] ?? '').trim().split(/\s+/).filter(Boolean);
    if (!tripWords.length) return;
    const groups = [0, 1, 2].map((k) => sortedLine(lineNums[startIdx + k]));
    const boxes = groups.flat();
    if (!boxes.length) return;
    const boxAlts = boxes.map((r) => alts.get(r.index) ?? []);
    const assigns = alignTripletWords(tripWords, boxes, boxAlts);
    let bi = 0;
    groups.forEach((g, gi) => {
      for (const r of g) {
        const a = assigns[bi++];
        if (!a.words.length) continue;
        if (!candidates.has(r.index)) candidates.set(r.index, []);
        candidates.get(r.index)!.push({ source: sources[gi], words: a.words, note: a.note });
      }
    });
  });

  for (const ln of lineNums) {
    for (const r of sortedLine(ln)) {
      const c = chooseAssignment(candidates.get(r.index) ?? [], alts.get(r.index) ?? []);
      if (!c) continue;
      out.set(r.index, {
        text: c.words.join(' '),
        note: c.note,
        confidence: bestConf.get(r.index) ?? 0,
      });
    }
  }
  return out;
}
