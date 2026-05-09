/**
 * Try/catch wrapper used to guard ECharts (and other third-party) calls
 * that can throw mid-HMR or during a React StrictMode double-mount when
 * the underlying instance is half-initialised.
 *
 * Returns `fallback` (default `undefined`) on any exception. We swallow
 * silently because the call sites are hot-path (rAF loops) and the
 * recovery is "skip this frame" — logging would spam the console.
 */
export function safe(fn, fallback) {
  try { return fn() } catch { return fallback }
}
