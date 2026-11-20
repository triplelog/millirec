// Development-only diagnostics for the v2 import. Gated behind the
// `hw-pipeline-v2-debug` localStorage flag; a no-op otherwise. Lets us dump the
// exact lab inputs plus rendered overlays so a failing page can be inspected
// directly (rules traced right? boxes sane?) and replayed in wordlab/better.

import type { BoxesJson } from './types';
import type * as passB from './passB/pipeline';
import type { PassAResult } from './passADriver';

function canvasOf(img: ImageData): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}

/** Render a single-channel gray buffer to a PNG data URL. */
function grayToPng(gray: Uint8Array, w: number, h: number): string {
  const img = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = gray[i];
    img.data[i * 4 + 3] = 255;
  }
  return canvasOf(img).toDataURL('image/png');
}

/** Flat page with the traced rules drawn on top: horizontal red, vertical blue. */
function rulesOverlay(pa: PassAResult): string {
  const c = canvasOf(pa.flat);
  const ctx = c.getContext('2d')!;
  ctx.lineWidth = 1.5;

  ctx.strokeStyle = 'rgba(255,0,0,0.85)';
  for (const r of pa.rules.rules) {
    ctx.beginPath();
    for (let x = 0; x < r.y.length; x++) x ? ctx.lineTo(x, r.y[x]) : ctx.moveTo(x, r.y[x]);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(0,80,255,0.85)';
  for (const v of pa.rules.vrules ?? []) {
    ctx.beginPath();
    for (let y = 0; y < v.x.length; y++) y ? ctx.lineTo(v.x[y], y) : ctx.moveTo(v.x[y], y);
    ctx.stroke();
  }
  return c.toDataURL('image/png');
}

/** Clean (segmenter) page with the detected word boxes drawn in green. */
function boxesOverlay(pa: PassAResult, boxes: BoxesJson): string {
  const c = canvasOf(pa.clean);
  const ctx = c.getContext('2d')!;
  ctx.strokeStyle = 'rgba(0,170,0,0.9)';
  ctx.lineWidth = 2;
  for (const line of boxes.lines)
    for (const b of line.words) ctx.strokeRect(b.x, b.y, b.w, b.h);
  return c.toDataURL('image/png');
}

function download(name: string, url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}

function jsonUrl(obj: unknown): string {
  return 'data:application/json,' + encodeURIComponent(JSON.stringify(obj));
}

/**
 * Log a one-line-per-fact summary and stash artifacts on `window.__hwV2`. Call
 * `window.__hwV2.download()` in the console to save:
 *   flat.png, clean.png, rules-overlay.png, boxes-overlay.png, rules.json, boxes.json
 * The overlays show whether rules are traced correctly and boxes are sane; the
 * JSON + PNGs load into the wordlab lab for full per-stage inspection.
 */
export function dumpV2Debug(
  pa: PassAResult,
  boxes: BoxesJson,
  recs: passB.WordRec[],
  targetXh: number,
  enabled?: boolean,
): void {
  // `enabled` is the caller's decision. When it is omitted we fall back to the
  // browser flag, so a console user can still switch dumps on without a rebuild
  // — but the pipeline itself never requires localStorage to exist, which is
  // what lets it run in a worker or in Node.
  const on = enabled ?? (typeof localStorage !== 'undefined'
    && localStorage.getItem('hw-pipeline-v2-debug') === '1');
  if (!on) return;

  const boxCount = boxes.lines.reduce((n, l) => n + l.words.length, 0);
  const byStatus: Record<string, number> = {};
  for (const r of recs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

  // eslint-disable-next-line no-console
  console.log('[hw v2]', {
    pageW: pa.pageW, pageH: pa.pageH, lineHeight: pa.lineHeight,
    rules: pa.rules.rules.length, vrules: pa.rules.vrules?.length ?? 0,
    segLines: boxes.lines.length, boxes: boxCount,
    recs: recs.length, recStatus: byStatus, targetXh,
    withSmooth: recs.filter((r) => r.smooth).length,
  });

  (window as unknown as { __hwV2?: unknown }).__hwV2 = {
    rules: pa.rules,
    boxes,
    download() {
      download('flat.png', canvasOf(pa.flat).toDataURL('image/png'));
      download('clean.png', canvasOf(pa.clean).toDataURL('image/png'));
      // Pass B grayscale substrate AFTER vertical-rule removal — the margin
      // line should be gone here (horizontal rules are still present; those are
      // removed per-word downstream).
      download('passB-gray.png', grayToPng(pa.gray, pa.pageW, pa.pageH));
      download('rules-overlay.png', rulesOverlay(pa));
      download('boxes-overlay.png', boxesOverlay(pa, boxes));
      download('rules.json', jsonUrl(pa.rules));
      download('boxes.json', jsonUrl(boxes));
    },
  };
  // eslint-disable-next-line no-console
  console.log('[hw v2] artifacts ready — run window.__hwV2.download() (flat, clean, rule + box overlays, JSON)');
}
