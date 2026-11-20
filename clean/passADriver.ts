// Pass A driver: spawns the WASM worker, runs the global page-cleanup pipeline
// on one image, and returns the flattened page plus the traced rules. The heavy
// lifting lives in the worker (passA/worker.ts) so this stays a thin
// request/response shim.
//
// `PassASession` is the shape a caller that runs Pass A more than once should
// use: one worker, the photo uploaded ONCE, and runs (or partial runs — a stage
// range) issued against it in order. `runPassA` / `detectPageQuad` are the
// one-shot conveniences, each a session of one request.

import * as passA from './passA/params';
import type { RulesJson } from './types';

/** Where the host app serves hw.mjs + hw.wasm from. Set it once at startup if
 *  they are not at /wasm/. */
let assetBase: string | undefined;

export function setWasmAssetBase(base: string): void {
  assetBase = base;
}

/** Where the Pass A worker module lives.
 *
 *  By default the worker is resolved relative to this module, which is what a
 *  bundler that understands `new Worker(new URL(...))` needs. Bundling the
 *  pipeline into one file breaks that — `import.meta.url` then points at the
 *  bundle, not at this source — so a host that ships its own worker build says
 *  where it put it. */
let workerUrl: string | URL | null = null;

export function setWorkerUrl(url: string | URL): void {
  workerUrl = url;
}

// The two branches MUST stay separate statements: bundlers (Turbopack,
// webpack, Vite) detect worker entry points by the LITERAL pattern
// `new Worker(new URL('./x', import.meta.url))`. Folding the override in as
// `workerUrl ?? new URL(...)` broke that detection — Turbopack emitted the
// worker's .ts as a static MEDIA asset instead of compiling it, and every
// photo import in the editor failed with a bare "worker error".
const makeWorker = (): Worker => {
  if (workerUrl != null) return new Worker(workerUrl, { type: 'module' });
  return new Worker(new URL('./passA/worker.ts', import.meta.url), { type: 'module' });
};

export interface PassAResult {
  pageW: number;
  pageH: number;
  /** Flattened (dewarped, illumination-normalized) page as RGBA. Rules are still
   *  present here — this is what Pass B samples and removes per-crop. */
  flat: ImageData;
  /** Same page as a single-channel gray buffer — Pass B samples from this. */
  gray: Uint8Array;
  /** Final cleaned page (stage 8: rules removed, binarized, despeckled). This is
   *  the segmenter's input — rules must be gone or they bridge words into blobs. */
  clean: ImageData;
  /** Traced rules in flat-page coordinates. */
  rules: RulesJson;
  /** Auto-estimated line height (px); 0 if the pipeline couldn't estimate it. */
  lineHeight: number;
  /** Whether page detection reported a quad, and how much real paper edge was
   *  under it (0..1). See `PageQuad.quadScore`. */
  quadFound: boolean;
  quadScore: number;
  quadReject: QuadReject;
  /** See `PageQuad.quadOverflow` — the sheet runs past the picture. */
  quadOverflow: boolean;
}

/** What a STAGE RANGE of Pass A produced. Everything a full run carries is
 *  optional here: `flat`/`gray` exist once stage 4 has run in this request,
 *  `clean` once stage 8 has, `rules` once stage 5 has. A caller that runs
 *  1-4 and then continues with 5-8 stitches the two with `mergeStages`. */
export interface PassAStages {
  /** the stage range this request ran */
  stages: [number, number];
  pageW: number;
  pageH: number;
  flat?: ImageData;
  gray?: Uint8Array;
  clean?: ImageData;
  rules?: RulesJson;
  lineHeight: number;
  quadFound: boolean;
  quadScore: number;
  quadReject: QuadReject;
  quadOverflow: boolean;
}

export interface PassARunOptions {
  /** Inclusive stage range to run (default [1, 8]). A range starting past 1
   *  is a CONTINUATION of the previous request on this session, which must
   *  have run the stages below it with the same parameters. */
  stages?: [number, number];
  /** Which stage previews to render and send back (default: every stage in
   *  the range). The pipeline itself needs only 4 (the flattened page) and 8
   *  (the clean page); a lab that shows every stage asks for all of them. */
  previews?: number[];
}

/** A head run (stages 1..k) and its continuation (k+1..8) as one result. */
export function mergeStages(head: PassAStages, tail: PassAStages): PassAResult {
  const flat = head.flat ?? tail.flat;
  const gray = head.gray ?? tail.gray;
  const clean = tail.clean ?? head.clean;
  const rules = tail.rules ?? head.rules;
  if (!flat || !gray || !clean || !rules) throw new Error('Pass A stages do not add up to a full run');
  return {
    pageW: head.pageW || tail.pageW, pageH: head.pageH || tail.pageH,
    flat, gray, clean, rules,
    lineHeight: tail.lineHeight,
    quadFound: tail.quadFound, quadScore: tail.quadScore,
    quadReject: tail.quadReject, quadOverflow: tail.quadOverflow,
  };
}

interface StageMsg {
  type: 'stage';
  stage: number;
  w: number;
  h: number;
  rgba: ArrayBuffer;
}
interface DoneMsg {
  type: 'done';
  stages?: [number, number];
  pageW: number;
  pageH: number;
  lineHeight: number;
  quadFound: boolean;
  quadScore: number;
  quadReject: number;
  quadOverflow: boolean;
  ruleData: { thickness: number; y: number[] }[];
  vruleData: { thickness: number; x: number[] }[];
}
interface ErrMsg {
  type: 'error';
  message: string;
}
interface QuadMsg {
  type: 'quad';
  quad: number[];
  quadFound: boolean;
  quadScore: number;
  quadReject: number;
  quadOverflow: boolean;
  grayW: number;
  grayH: number;
}

/** Why `stage_page` declined to report a quad. Mirrors the `HW_QUAD_*` enum in
 *  wasm/src/hw.h; the useful one is `overflow` — the sheet runs past the frame,
 *  so there is no page rectangle to find and cropping to one is the bug. */
export const QUAD_REJECT = [
  'ok', 'disabled', 'no-paper', 'overflow', 'no-hull', 'too-small', 'bad-shape',
] as const;
export type QuadReject = (typeof QUAD_REJECT)[number];

export interface PageQuad {
  /** TL,TR,BR,BL as [x,y,x,y,x,y,x,y], in gray (Pass A working-image) coords. */
  quad: number[];
  quadFound: boolean;
  /**
   * 0..1 — how strong and how complete the intensity step across the four
   * fitted edges was.
   *
   * `quadFound` is not a confidence: the detector reports success on any four
   * corners it can fit, and that is exactly how a close-up photo of paper came
   * to be warped into a 13-degree keystone. This is the number to threshold on.
   */
  quadScore: number;
  quadReject: QuadReject;
  /**
   * The sheet runs past the picture — the paper covers three image borders, or
   * an opposite pair — so there is no page rectangle in frame and the reported
   * quad is the bright region's outline rather than the paper's corners.
   *
   * ADVISORY, NOT A REJECTION, and that distinction was measured. Declining
   * outright looks obviously right and costs five words on the six-page photo
   * corpus: the bogus quad was cropping the frame's rim by accident, and the
   * decoder reads phantom words out of a rim that is left in (an inserted
   * "rococo." on page A, an inserted "it's" on page C). The crop is worth
   * having even when the corners are not the paper's; what a caller should
   * decline on this flag is the PERSPECTIVE correction, and only a caller knows
   * whether it has another way to check one (`cleanPage` measures the ruled
   * lines).
   */
  quadOverflow: boolean;
  /** Dimensions of the coordinate space `quad` is expressed in. */
  grayW: number;
  grayH: number;
}

const PASS_A_TIMEOUT_MS = 60_000;

/** One in-flight request on a session. The worker answers strictly in order,
 *  so the queue's head is always the request the next message belongs to. */
interface Pending {
  kind: 'quad' | 'run';
  stageBufs: Map<number, { w: number; h: number; rgba: ArrayBuffer }>;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A Pass A worker holding ONE image, answering runs in order.
 *
 * The photo is copied into the worker once (the `setImage` transfer; the
 * worker uploads it into the WASM heap once more, on the first run). Every
 * request after that reuses it — `cleanPage` runs Pass A two to four times per
 * photo, and before this each run spawned a worker, re-copied 48 MB twice and
 * re-instantiated the module.
 */
/** The most pixels a photo may have: 64 MP, above every phone camera (50 MP is 8160×6120). The
 *  cleaner works at `workMaxDim` (1500 px default) anyway, but the whole photo is copied to the
 *  worker first — a larger one is a memory risk on a phone, so downscale it before calling. */
export const MAX_PIXELS = 64 * 1024 * 1024;

/** Throw a clear error for pixels that cannot be a w×h RGBA image (instead of an empty result or
 *  a TypeError deep inside). Every entry that hands a photo to Pass A comes through here. */
export function checkImage(rgba: unknown, w: number, h: number): asserts rgba is Uint8ClampedArray {
  if (!(rgba instanceof Uint8ClampedArray || rgba instanceof Uint8Array)) {
    const hint = rgba && typeof rgba === 'object' && 'data' in rgba ? ' — got an ImageData; pass image.data, image.width, image.height (or the ImageData alone to cleanPage)' : '';
    throw new TypeError(`millirec-clean: the pixels must be a Uint8ClampedArray of RGBA bytes${hint}`);
  }
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) throw new RangeError(`millirec-clean: width and height must be positive integers (got ${w} × ${h})`);
  if (w * h > MAX_PIXELS) throw new RangeError(`millirec-clean: ${w} × ${h} is over ${MAX_PIXELS / (1024 * 1024)} MP — downscale the photo first (the cleaner works at about 1500 px on the long edge)`);
  if (rgba.length !== w * h * 4) throw new RangeError(`millirec-clean: ${rgba.length} bytes is not a ${w} × ${h} RGBA image (expected ${w * h * 4})`);
}

export class PassASession {
  private worker: Worker;
  private queue: Pending[] = [];
  private dead: Error | null = null;

  constructor(rgba: Uint8ClampedArray, w: number, h: number) {
    checkImage(rgba, w, h);
    this.worker = makeWorker();
    // A module worker that cannot load reports an ErrorEvent with no message at all.
    this.worker.onerror = (e) => this.fail(new Error(e.message || `millirec-clean: the Pass A worker failed to start${workerUrl != null ? ` from ${String(workerUrl)}` : ''} — if your bundler did not ship dist/worker.mjs, serve it and call setWorkerUrl(url)`));
    this.worker.onmessage = (e: MessageEvent<StageMsg | DoneMsg | ErrMsg | QuadMsg>) => this.onMessage(e.data);
    // A copy, transferred: the caller keeps its pixels, the worker owns its own.
    const buf = rgba.slice().buffer;
    this.worker.postMessage({ type: 'setImage', w, h, rgba: buf, assetBase }, [buf]);
  }

  /** Auto-detect the page quad only (stages 1-2), for a live corner-adjustment
   *  preview. Much cheaper than a full run — skips illumination flatten, rule
   *  tracing, binarize, despeckle. */
  detectQuad(): Promise<PageQuad> {
    return this.enqueue('quad', { type: 'detectQuad' });
  }

  /** Run a stage range (default all eight) with `params` (default the shared
   *  Pass A defaults). `manualQuad` (TL,TR,BR,BL, gray coords) overrides auto
   *  page-detection for stage 2 — the caller must also set the `pageManual`
   *  param to 1 when passing this. */
  runStages(
    params: Float32Array = passA.defaultParams(),
    manualQuad?: number[],
    opts: PassARunOptions = {},
  ): Promise<PassAStages> {
    return this.enqueue('run', {
      type: 'run', params: Array.from(params), manualQuad,
      ...(opts.stages ? { stages: opts.stages } : {}),
      ...(opts.previews ? { previews: opts.previews } : {}),
    });
  }

  /** A full run: all eight stages, the two previews the pipeline consumes. */
  async run(params?: Float32Array, manualQuad?: number[]): Promise<PassAResult> {
    const r = await this.runStages(params, manualQuad, { previews: [4, 8] });
    if (!r.flat || !r.gray || !r.clean || !r.rules) throw new Error('Pass A produced no flattened page');
    return {
      pageW: r.pageW, pageH: r.pageH, flat: r.flat, gray: r.gray, clean: r.clean, rules: r.rules,
      lineHeight: r.lineHeight, quadFound: r.quadFound, quadScore: r.quadScore,
      quadReject: r.quadReject, quadOverflow: r.quadOverflow,
    };
  }

  /** Terminate the worker. Pending requests are rejected. */
  close(): void {
    this.fail(new Error('Pass A session closed'));
    this.worker.terminate();
  }

  private enqueue(kind: Pending['kind'], msg: object): Promise<any> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      const p: Pending = {
        kind, stageBufs: new Map(), resolve, reject,
        timer: setTimeout(() => this.settle(p, new Error(kind === 'quad' ? 'Page detection timed out' : 'Pass A timed out')), PASS_A_TIMEOUT_MS),
      };
      this.queue.push(p);
      this.worker.postMessage(msg);
    });
  }

  private settle(p: Pending, err: Error | null, value?: unknown): void {
    const i = this.queue.indexOf(p);
    if (i < 0) return;
    this.queue.splice(i, 1);
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(value);
  }

  private fail(err: Error): void {
    if (!this.dead) this.dead = err;
    for (const p of this.queue.slice()) this.settle(p, err);
  }

  private onMessage(msg: StageMsg | DoneMsg | ErrMsg | QuadMsg): void {
    const p = this.queue[0];
    if (!p) return;
    if (msg.type === 'error') { this.settle(p, new Error(msg.message)); return; }
    if (msg.type === 'stage') { p.stageBufs.set(msg.stage, { w: msg.w, h: msg.h, rgba: msg.rgba }); return; }
    if (msg.type === 'quad') {
      if (p.kind !== 'quad') { this.settle(p, new Error('Pass A protocol: unexpected quad reply')); return; }
      this.settle(p, null, {
        quad: msg.quad, quadFound: msg.quadFound,
        quadScore: msg.quadScore ?? 0,
        quadReject: QUAD_REJECT[msg.quadReject ?? 0] ?? 'ok',
        quadOverflow: !!msg.quadOverflow,
        grayW: msg.grayW, grayH: msg.grayH,
      } satisfies PageQuad);
      return;
    }
    // done
    if (p.kind !== 'run') { this.settle(p, new Error('Pass A protocol: unexpected done reply')); return; }
    const flat = p.stageBufs.get(4);
    const clean = p.stageBufs.get(8);
    const out: PassAStages = {
      stages: msg.stages ?? [1, 8],
      pageW: msg.pageW, pageH: msg.pageH,
      lineHeight: msg.lineHeight,
      quadFound: !!msg.quadFound,
      quadScore: msg.quadScore ?? 0,
      quadReject: QUAD_REJECT[msg.quadReject ?? 0] ?? 'ok',
      quadOverflow: !!msg.quadOverflow,
    };
    if (flat) {
      // Stage 4 = "Illumination flatten" (rules present) → Pass B substrate.
      const bytes = new Uint8ClampedArray(flat.rgba);
      out.flat = new ImageData(bytes, flat.w, flat.h);
      const gray = new Uint8Array(flat.w * flat.h);
      for (let i = 0; i < gray.length; i++) gray[i] = bytes[i * 4];
      out.gray = gray;
    }
    // Stage 8 = "Despeckle" (final clean, rules removed) → segmenter input.
    if (clean) out.clean = new ImageData(new Uint8ClampedArray(clean.rgba), clean.w, clean.h);
    if (out.stages[1] >= 5) {
      out.rules = {
        width: msg.pageW,
        height: msg.pageH,
        lineHeight: msg.lineHeight,
        rules: msg.ruleData,
        vrules: msg.vruleData,
      };
    }
    this.settle(p, null, out);
  }
}

/** Open a session on one image. Close it when done. */
export function openPassA(rgba: Uint8ClampedArray, w: number, h: number): PassASession {
  return new PassASession(rgba, w, h);
}

/**
 * Auto-detect the page quad only (stages 1-2), for a live corner-adjustment
 * preview. Much cheaper than a full runPassA — skips illumination flatten,
 * rule tracing, binarize, despeckle.
 */
export async function detectPageQuad(rgba: Uint8ClampedArray, w: number, h: number): Promise<PageQuad> {
  const s = openPassA(rgba, w, h);
  try { return await s.detectQuad(); } finally { s.close(); }
}

/**
 * Run Pass A on an image's pixels. `params` defaults to the shared Pass A
 * defaults; callers never need to pass it in production. `manualQuad`
 * (TL,TR,BR,BL, gray coords) overrides auto page-detection for stage 2 — the
 * caller must also set the `pageManual` param to 1 when passing this.
 */
export async function runPassA(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  params: Float32Array = passA.defaultParams(),
  manualQuad?: number[],
): Promise<PassAResult> {
  const s = openPassA(rgba, w, h);
  try { return await s.run(params, manualQuad); } finally { s.close(); }
}
