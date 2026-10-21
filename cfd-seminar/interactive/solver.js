/* MIT, Copyright (c) 2026 KIDENA-Fumiya. Browser adaptation of cfd-seminar. */
(function (root) {
  'use strict';
  class FlowSolver {
    constructor(n = 40) {
      if (![24, 40, 56].includes(n)) throw new Error('Unsupported grid');
      this.n = n; this.s = n + 2; this.h = 1 / n;
      this.options = { advection: true, viscosity: false, pressure: false, nu: 0.008, lid: 0 };
      for (const key of ['u', 'v', 'un', 'vn', 'p', 'rhs', 'r', 'd', 'ad']) this[key] = new Float64Array(this.s ** 2);
      this.reset();
    }
    index(i, j) { return i + this.s * j; }
    configure(options) {
      for (const key of ['advection', 'viscosity', 'pressure']) if (key in options) this.options[key] = !!options[key];
      for (const [key, lo, hi] of [['nu', 0.001, 0.04], ['lid', 0, 1]]) {
        if (key in options) {
          const x = Number(options[key]);
          if (!Number.isFinite(x)) throw new Error('Invalid parameter');
          this.options[key] = Math.max(lo, Math.min(hi, x));
        }
      }
      // Parameter changes start a new complete step, not half of the old operator sequence.
      if (this.phase) { this.u.set(this.un); this.v.set(this.vn); this.phase = 0; }
      this.boundary();
      this.lastStage = '設定変更'; this.stats = this.measure();
    }
    reset() {
      const n = this.n, h = this.h, s = this.s;
      for (const key of ['u', 'v', 'un', 'vn', 'p']) this[key].fill(0);
      const psi = (i, j) => 0.12 * Math.sin(Math.PI * i / n) ** 2 * Math.sin(Math.PI * j / n) ** 2;
      for (let j = 1; j <= n; j++) for (let i = 0; i <= n; i++) this.u[i + s * j] = (psi(i, j) - psi(i, j - 1)) / h;
      for (let j = 0; j <= n; j++) for (let i = 1; i <= n; i++) this.v[i + s * j] = -(psi(i, j) - psi(i - 1, j)) / h;
      this.time = 0; this.steps = 0; this.phase = 0; this.dt = 0;
      this.lastStage = '準備完了'; this.iterations = 0; this.converged = true;
      this.beforeProjection = 0; this.afterProjection = 0;
      this.boundary(); this.stats = this.measure();
    }
    boundary() {
      const { n, s, u, v } = this;
      for (let j = 1; j <= n; j++) { u[s * j] = 0; u[n + s * j] = 0; v[s * j] = -v[1 + s * j]; v[n + 1 + s * j] = -v[n + s * j]; }
      for (let i = 1; i <= n; i++) { v[i] = 0; v[i + s * n] = 0; u[i] = -u[i + s]; u[i + s * (n + 1)] = 2 * this.options.lid - u[i + s * n]; }
    }
    begin() {
      this.boundary(); this.un.set(this.u); this.vn.set(this.v);
      let speed = 0;
      for (let k = 0; k < this.u.length; k++) speed = Math.max(speed, Math.abs(this.u[k]), Math.abs(this.v[k]));
      const nu = this.options.viscosity ? this.options.nu : 0;
      this.dt = Math.min(0.02, 0.35 / (2 * speed / this.h + 4 * nu / this.h ** 2 + 1e-10));
    }
    advection() {
      const { n, s, un, vn, u, v, dt, h } = this;
      // cfd-seminar/advection.f90 MAC interpolation; first-order upwind from advection2.html.
      const diff = (a, k, stride, speed) => speed >= 0 ? (a[k] - a[k - stride]) / h : (a[k + stride] - a[k]) / h;
      for (let j = 1; j <= n; j++) for (let i = 1; i < n; i++) {
        const k = i + s * j, va = (vn[k] + vn[k + 1] + vn[k - s] + vn[k + 1 - s]) / 4;
        u[k] -= dt * (un[k] * diff(un, k, 1, un[k]) + va * diff(un, k, s, va));
      }
      for (let j = 1; j < n; j++) for (let i = 1; i <= n; i++) {
        const k = i + s * j, ua = (un[k] + un[k - 1] + un[k + s] + un[k - 1 + s]) / 4;
        v[k] -= dt * (ua * diff(vn, k, 1, ua) + vn[k] * diff(vn, k, s, vn[k]));
      }
      this.boundary();
    }
    diffusion() {
      const { n, s, un, vn, u, v, dt, h } = this, a = dt * this.options.nu / h ** 2;
      for (let j = 1; j <= n; j++) for (let i = 1; i < n; i++) {
        const k = i + s * j; u[k] += a * (un[k - 1] + un[k + 1] + un[k - s] + un[k + s] - 4 * un[k]);
      }
      for (let j = 1; j < n; j++) for (let i = 1; i <= n; i++) {
        const k = i + s * j; v[k] += a * (vn[k - 1] + vn[k + 1] + vn[k - s] + vn[k + s] - 4 * vn[k]);
      }
      this.boundary();
    }
    negativeLaplacian(x, out) {
      const { n, s, h } = this, ih2 = 1 / h ** 2;
      for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) {
        const k = i + s * j;
        out[k] = ((i > 1 ? x[k] - x[k - 1] : 0) + (i < n ? x[k] - x[k + 1] : 0) + (j > 1 ? x[k] - x[k - s] : 0) + (j < n ? x[k] - x[k + s] : 0)) * ih2;
      }
    }
    dot(a, b) {
      let sum = 0;
      for (let j = 1; j <= this.n; j++) for (let i = 1; i <= this.n; i++) { const k = i + this.s * j; sum += a[k] * b[k]; }
      return sum;
    }
    projection() {
      const { n, s, h, dt, u, v, p, rhs, r, d, ad } = this;
      this.beforeProjection = this.measure().divergence;
      let mean = 0;
      for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) {
        const k = i + s * j; rhs[k] = -((u[k] - u[k - 1]) + (v[k] - v[k - s])) / h / dt; mean += rhs[k];
      }
      mean /= n * n; p.fill(0);
      for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) { const k = i + s * j; r[k] = d[k] = rhs[k] - mean; }
      let rr = this.dot(r, r), tolerance = Math.max(1e-20, rr * 1e-14), iter = 0;
      // Mean-zero conjugate gradients for the same Neumann Poisson problem as the seminar.
      while (rr > tolerance && iter < n * 6) {
        this.negativeLaplacian(d, ad);
        const denom = this.dot(d, ad);
        if (!(denom > 0)) break;
        const alpha = rr / denom;
        for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) { const k = i + s * j; p[k] += alpha * d[k]; r[k] -= alpha * ad[k]; }
        const next = this.dot(r, r), beta = next / rr;
        for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) { const k = i + s * j; d[k] = r[k] + beta * d[k]; }
        rr = next; iter++;
      }
      mean = 0;
      for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) mean += p[i + s * j];
      mean /= n * n;
      for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) p[i + s * j] -= mean;
      for (let j = 1; j <= n; j++) for (let i = 1; i < n; i++) { const k = i + s * j; u[k] -= dt * (p[k + 1] - p[k]) / h; }
      for (let j = 1; j < n; j++) for (let i = 1; i <= n; i++) { const k = i + s * j; v[k] -= dt * (p[k + s] - p[k]) / h; }
      this.boundary(); this.iterations = iter; this.converged = rr <= tolerance;
      this.afterProjection = this.measure().divergence;
      if (!this.converged) throw new Error('圧力計算が収束しませんでした。条件を戻してリセットしてください。');
    }
    stage() {
      if (this.phase === 0) this.begin();
      const stage = this.phase;
      if (stage === 0) { if (this.options.advection) this.advection(); this.lastStage = this.options.advection ? '移流' : '移流をスキップ'; }
      if (stage === 1) { if (this.options.viscosity) this.diffusion(); this.lastStage = this.options.viscosity ? '粘性' : '粘性をスキップ'; }
      if (stage === 2) {
        if (this.options.pressure) this.projection(); else this.p.fill(0);
        this.lastStage = this.options.pressure ? '圧力補正' : '圧力補正をスキップ';
        this.time += this.dt; this.steps++;
      }
      this.phase = (stage + 1) % 3;
      this.stats = this.measure();
      if (!Number.isFinite(this.stats.energy) || this.stats.maxSpeed > 20) throw new Error('速度が計算範囲を超えました。リセットしてください。');
      return stage;
    }
    step() { do { this.stage(); } while (this.phase !== 0); }
    measure() {
      const { n, s, h, u, v } = this; let energy = 0, div2 = 0, maxSpeed = 0;
      for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) {
        const k = i + s * j, x = (u[k] + u[k - 1]) / 2, y = (v[k] + v[k - s]) / 2;
        energy += (x * x + y * y) / 2; maxSpeed = Math.max(maxSpeed, Math.hypot(x, y));
        div2 += (((u[k] - u[k - 1]) + (v[k] - v[k - s])) / h) ** 2;
      }
      return { energy: energy / n ** 2, divergence: Math.sqrt(div2 / n ** 2), maxSpeed };
    }
    snapshot() {
      const { n, s, h } = this, u = new Float32Array(n * n), v = new Float32Array(n * n), p = new Float32Array(n * n), div = new Float32Array(n * n);
      for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) {
        const k = i + s * j, a = i - 1 + n * (j - 1);
        u[a] = (this.u[k] + this.u[k - 1]) / 2; v[a] = (this.v[k] + this.v[k - s]) / 2; p[a] = this.p[k];
        div[a] = ((this.u[k] - this.u[k - 1]) + (this.v[k] - this.v[k - s])) / h;
      }
      return { n, u, v, p, div, time: this.time, steps: this.steps, phase: this.phase, dt: this.dt, stage: this.lastStage, stats: this.stats, before: this.beforeProjection, after: this.afterProjection, iterations: this.iterations, options: { ...this.options } };
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = FlowSolver;
  else root.FlowSolver = FlowSolver;
})(globalThis);
