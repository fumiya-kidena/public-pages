'use strict';
importScripts('solver.js?v=20261022-cavity400');
let solver = new FlowSolver();
let batch = null;
const profileAges = [60, 120, 180];
let profileHistory = [];
function recordProfile() {
  if (solver.options.case !== 'channel' || solver.phase || profileHistory.at(-1)?.steps === solver.steps) return;
  profileHistory.push({ steps: solver.steps, time: solver.time, ...solver.profiles() });
  if (profileHistory.length > profileAges.at(-1) + 1) profileHistory.shift();
}
recordProfile();
function reply(request) {
  const state = solver.snapshot();
  const history = profileAges.map(age => profileHistory.find(item => item.steps === state.steps-age)).filter(Boolean);
  // History buffers stay in the worker; cloning these small profiles preserves the ring.
  self.postMessage({ ...state, profileHistory: history, request }, [state.u.buffer, state.v.buffer, state.p.buffer, state.div.buffer, state.profileU.buffer, state.profileV.buffer]);
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
    do { solver.step(); recordProfile(); batch.remaining--; }
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
    if (data.type === 'reset' || data.type === 'configure') { profileHistory = []; recordProfile(); }
    if (data.type === 'advance') {
      const count = Number.isFinite(data.count) ? Math.max(1, Math.min(60, Math.floor(data.count))) : 1;
      batch = { remaining: count, request: data.request, timer: null };
      advanceBatch();
      return;
    }
    if (data.type === 'stage') { solver.stage(); recordProfile(); }
    reply(data.request);
  } catch (error) { self.postMessage({ error: error.message, request: data.request }); }
};
