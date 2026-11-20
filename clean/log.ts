// Diagnostic logging for the page cleaner, OFF unless asked for. The cleaner ships as an npm
// package (millirec-clean), and a library must not write to its host's console on every page.
//
// On when any of these holds:
//   globalThis.__MILLIREC_CLEAN_DEBUG = true            (any runtime, set before cleanPage)
//   localStorage['hw-pipeline-v2-debug'] === '1'       (a browser page — the flag debug.ts reads)
//   HW_DEBUG=1 in the environment                      (Node: the gates and tuning scripts)
// Read at each call, so it can be switched on from the console mid-session.

export function cleanDebugOn(): boolean {
  try {
    if ((globalThis as { __MILLIREC_CLEAN_DEBUG?: unknown }).__MILLIREC_CLEAN_DEBUG) return true;
    if (typeof localStorage !== 'undefined' && localStorage.getItem('hw-pipeline-v2-debug') === '1') return true;
    if (typeof process !== 'undefined' && process.env?.HW_DEBUG) return true;
  } catch { /* storage blocked (sandboxed iframe, privacy mode): treat as off */ }
  return false;
}

/** console.log, only when cleanDebugOn(). Pass a function to skip building the message when off. */
export function debugLog(msg: string | (() => string), ...rest: unknown[]): void {
  if (!cleanDebugOn()) return;
  // eslint-disable-next-line no-console
  console.log(typeof msg === 'function' ? msg() : msg, ...rest);
}
