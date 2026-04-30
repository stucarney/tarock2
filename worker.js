/* Tarock 2.0 — search worker.
 * Runs Engine.bestMoveForSide off the main thread so the page stays
 * responsive (no "Page Unresponsive" prompts, no iOS tab kill) during
 * long searches like depth-8 from a fresh start. */
importScripts('engine.js');

self.onmessage = function (e) {
  const msg = e.data || {};
  if (msg.type !== 'suggest') return;
  const { state, side, depth } = msg;
  const t0 = (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();
  let best = null;
  let err = null;
  try {
    best = Engine.bestMoveForSide(state, side, depth);
  } catch (e) {
    err = (e && e.message) ? e.message : String(e);
  }
  const ms = Math.round(((typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now()) - t0);
  self.postMessage({ type: 'result', best, ms, err });
};
