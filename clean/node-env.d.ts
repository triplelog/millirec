// clean/ compiles for the browser — the tsconfig's lib set is DOM + WebWorker and
// there is no @types/node here — but the pipeline keeps one `process.env` debug
// hatch (HW_SEG_DEBUG) for runs under the node harness, guarded at runtime by
// `typeof process !== 'undefined'`. Declare just enough of `process` for the
// standalone typecheck to pass; the runtime guard is what keeps it browser-safe.
declare const process: { env?: Record<string, string | undefined> };
