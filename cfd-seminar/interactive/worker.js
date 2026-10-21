'use strict';
importScripts('solver.js');
let solver = new FlowSolver(40);
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'reset') { solver = new FlowSolver(data.n || solver.n); solver.configure(data.options || {}); solver.reset(); }
    if (data.type === 'configure') solver.configure(data.options);
    if (data.type === 'advance') for (let i = 0; i < Math.min(12, data.count || 1); i++) solver.step();
    if (data.type === 'stage') solver.stage();
    const state = solver.snapshot();
    self.postMessage({ ...state, request: data.request }, [state.u.buffer, state.v.buffer, state.p.buffer, state.div.buffer]);
  } catch (error) { self.postMessage({ error: error.message, request: data.request }); }
};
