'use strict';
importScripts('solver.js?v=20261022-coefficients-re100');
let solver = new FlowSolver();
let batch = null;
function reply(request) {
  const state = solver.snapshot();
  self.postMessage({ ...state, request }, [state.u.buffer, state.v.buffer, state.p.buffer, state.div.buffer, state.profileU.buffer]);
}
function finishBatch(error) {
  if (!batch) return;
  const { request, timer } = batch;
  clearTimeout(timer);
  batch = null;
  if (error) self.postMessage({ error: error.message, request });
  else reply(request);
}
function advanceBatch() {
  try {
    const start = performance.now();
    do { solver.step(); batch.remaining--; }
    while (batch.remaining > 0 && performance.now() - start < 25);
    // Yield between complete timesteps so stop/reset can interrupt long batches.
    if (batch.remaining > 0) batch.timer = setTimeout(advanceBatch, 0);
    else finishBatch();
  } catch (error) { finishBatch(error); }
}
self.onmessage = ({ data }) => {
  try {
    finishBatch();
    if (data.type === 'stop') return;
    if (data.type === 'reset') { solver = new FlowSolver(data.n || solver.n); solver.configure(data.options || {}); solver.reset(); }
    if (data.type === 'configure') solver.configure(data.options);
    if (data.type === 'advance') {
      const count = Number.isFinite(data.count) ? Math.max(1, Math.min(60, Math.floor(data.count))) : 1;
      batch = { remaining: count, request: data.request, timer: null };
      advanceBatch();
      return;
    }
    if (data.type === 'stage') solver.stage();
    reply(data.request);
  } catch (error) { self.postMessage({ error: error.message, request: data.request }); }
};
