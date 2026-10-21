/* MIT, Copyright (c) 2026 KIDENA-Fumiya. Browser adaptation of cfd-seminar. */
(function (root) {
  'use strict';
  class FlowSolver {
    constructor(n = 100) {
      if (!Number.isInteger(n) || n < 20 || n > 200) throw new Error('Unsupported grid');
      // SI throughout: m, s, m/s, m^2/s. Pressure storage is p/rho (m^2/s^2).
      this.n = n; this.ly = 0.1; this.h = this.ly / n; this.rho = 1000;
      this.options = { case: 'channel', advection: true, viscosity: false, pressure: false, nu: 1e-6, lid: 0.001, inflow: 0.001, dtMax: 0.1 };
      this.reset();
    }
    index(i, j) { return i + this.s * j; }
    configure(options) {
      const changedCase = 'case' in options && options.case !== this.options.case;
      if ('case' in options) {
        if (!['channel', 'cavity'].includes(options.case)) throw new Error('Unsupported case');
        this.options.case = options.case;
      }
      for (const key of ['advection', 'viscosity', 'pressure']) if (key in options) this.options[key] = !!options[key];
      for (const [key, lo, hi] of [['nu', 5e-7, 1e-5], ['lid', 0, 0.01], ['inflow', 0.0001, 0.01], ['dtMax', 0.001, 1]]) {
        if (key in options) {
          const x = Number(options[key]);
          if (!Number.isFinite(x)) throw new Error('Invalid parameter');
          this.options[key] = Math.max(lo, Math.min(hi, x));
        }
      }
      if (changedCase) { this.reset(); return; }
      // Parameter changes start a new complete step, not half of the old operator sequence.
      if (this.phase) { this.u.set(this.un); this.v.set(this.vn); this.phase = 0; }
      if (this.dt > 0) this.boundary();
      this.lastStage = '設定変更'; this.stats = this.measure();
    }
    reset() {
      this.nx = this.options.case === 'channel' ? 2 * this.n : this.n;
      this.s = this.nx + 2;
      for (const key of ['u', 'v', 'un', 'vn', 'p', 'rhs', 'r', 'd', 'ad']) this[key] = new Float64Array(this.s * (this.n + 2));
      this.time = 0; this.steps = 0; this.phase = 0; this.dt = 0;
      this.cfl = 0; this.diffusionNumber = 0; this.projectionCount = 0;
      this.lastStage = '準備完了'; this.iterations = 0; this.converged = true;
      this.beforeProjection = 0; this.afterProjection = 0;
      this.stats = this.measure();
    }
    boundary(refreshOutlet = true) {
      const { n, nx, s, u, v } = this;
      const channel = this.options.case === 'channel';
      if (channel && refreshOutlet) {
        let outflow = 0;
        for (let j = 1; j <= n; j++) outflow += u[nx - 1 + s * j];
        for (let j = 1; j <= n; j++) u[nx + s * j] = outflow > 1e-12 ? u[nx - 1 + s * j] * n * this.options.inflow / outflow : this.options.inflow;
      }
      for (let j = 1; j <= n; j++) {
        u[s * j] = channel ? this.options.inflow : 0;
        if (!channel) u[nx + s * j] = 0;
        v[s * j] = -v[1 + s * j]; v[nx + 1 + s * j] = (channel ? 1 : -1) * v[nx + s * j];
      }
      for (let i = 1; i <= nx; i++) { v[i] = 0; v[i + s * n] = 0; u[i] = -u[i + s]; u[i + s * (n + 1)] = 2 * (channel ? 0 : this.options.lid) - u[i + s * n]; }
    }
    begin() {
      this.boundary(); this.un.set(this.u); this.vn.set(this.v);
      let speed = 0;
      for (let k = 0; k < this.u.length; k++) speed = Math.max(speed, Math.abs(this.u[k]), Math.abs(this.v[k]));
      const nu = this.options.viscosity ? this.options.nu : 0;
      const advectionRate = this.options.advection ? 2 * speed / this.h : 0;
      const diffusionRate = 4 * nu / this.h ** 2;
      this.dt = Math.min(this.options.dtMax, 0.35 / (advectionRate + diffusionRate + 1e-30));
      this.cfl = advectionRate * this.dt;
      this.diffusionNumber = diffusionRate * this.dt;
    }
    advection() {
      const { n, nx, s, un, vn, u, v, dt, h } = this;
      // cfd-seminar/advection.f90 MAC interpolation; first-order upwind from advection2.html.
      const diff = (a, k, stride, speed) => speed >= 0 ? (a[k] - a[k - stride]) / h : (a[k + stride] - a[k]) / h;
      for (let j = 1; j <= n; j++) for (let i = 1; i < nx; i++) {
        const k = i + s * j, va = (vn[k] + vn[k + 1] + vn[k - s] + vn[k + 1 - s]) / 4;
        u[k] -= dt * (un[k] * diff(un, k, 1, un[k]) + va * diff(un, k, s, va));
      }
      for (let j = 1; j < n; j++) for (let i = 1; i <= nx; i++) {
        const k = i + s * j, ua = (un[k] + un[k - 1] + un[k + s] + un[k - 1 + s]) / 4;
        v[k] -= dt * (ua * diff(vn, k, 1, ua) + vn[k] * diff(vn, k, s, vn[k]));
      }
      this.boundary();
    }
    diffusion() {
      const { n, nx, s, un, vn, u, v, dt, h } = this, a = dt * this.options.nu / h ** 2;
      for (let j = 1; j <= n; j++) for (let i = 1; i < nx; i++) {
        const k = i + s * j; u[k] += a * (un[k - 1] + un[k + 1] + un[k - s] + un[k + s] - 4 * un[k]);
      }
      for (let j = 1; j < n; j++) for (let i = 1; i <= nx; i++) {
        const k = i + s * j; v[k] += a * (vn[k - 1] + vn[k + 1] + vn[k - s] + vn[k + s] - 4 * vn[k]);
      }
      this.boundary();
    }
    negativeLaplacian(x, out) {
      const { n, nx, s, h } = this, ih2 = 1 / h ** 2;
      for (let j = 1; j <= n; j++) for (let i = 1; i <= nx; i++) {
        const k = i + s * j;
        out[k] = ((i > 1 ? x[k] - x[k - 1] : 0) + (i < nx ? x[k] - x[k + 1] : 0) + (j > 1 ? x[k] - x[k - s] : 0) + (j < n ? x[k] - x[k + s] : 0)) * ih2;
      }
    }
    dot(a, b) {
      let sum = 0;
      for (let j = 1; j <= this.n; j++) for (let i = 1; i <= this.nx; i++) { const k = i + this.s * j; sum += a[k] * b[k]; }
      return sum;
    }
    projection() {
      const { n, nx, s, h, dt, u, v, p, rhs, r, d, ad } = this;
      this.beforeProjection = this.measure().divergence;
      let mean = 0;
      for (let j = 1; j <= n; j++) for (let i = 1; i <= nx; i++) {
        const k = i + s * j; rhs[k] = -((u[k] - u[k - 1]) + (v[k] - v[k - s])) / h / dt; mean += rhs[k];
      }
      mean /= nx * n; p.fill(0);
      for (let j = 1; j <= n; j++) for (let i = 1; i <= nx; i++) { const k = i + s * j; r[k] = d[k] = rhs[k] - mean; }
      let rr = this.dot(r, r), tolerance = Math.max(1e-20, rr * 1e-14), iter = 0;
      // Mean-zero conjugate gradients for the same Neumann Poisson problem as the seminar.
      while (rr > tolerance && iter < Math.max(nx, n) * 6) {
        this.negativeLaplacian(d, ad);
        const denom = this.dot(d, ad);
        if (!(denom > 0)) break;
        const alpha = rr / denom;
        for (let j = 1; j <= n; j++) for (let i = 1; i <= nx; i++) { const k = i + s * j; p[k] += alpha * d[k]; r[k] -= alpha * ad[k]; }
        const next = this.dot(r, r), beta = next / rr;
        for (let j = 1; j <= n; j++) for (let i = 1; i <= nx; i++) { const k = i + s * j; d[k] = r[k] + beta * d[k]; }
        rr = next; iter++;
      }
      mean = 0;
      for (let j = 1; j <= n; j++) for (let i = 1; i <= nx; i++) mean += p[i + s * j];
      mean /= nx * n;
      for (let j = 1; j <= n; j++) for (let i = 1; i <= nx; i++) p[i + s * j] -= mean;
      for (let j = 1; j <= n; j++) for (let i = 1; i < nx; i++) { const k = i + s * j; u[k] -= dt * (p[k + 1] - p[k]) / h; }
      for (let j = 1; j < n; j++) for (let i = 1; i <= nx; i++) { const k = i + s * j; v[k] -= dt * (p[k + s] - p[k]) / h; }
      // Preserve the flux-compatible outlet during correction; refreshing it here would reintroduce divergence.
      this.boundary(false); this.iterations = iter; this.converged = rr <= tolerance;
      this.afterProjection = this.measure().divergence;
      if (!this.converged) throw new Error('圧力計算が収束しませんでした。条件を戻してリセットしてください。');
      this.projectionCount++;
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
      if (!Number.isFinite(this.stats.energy) || this.stats.maxSpeed > 1) throw new Error('速度が計算範囲を超えました。リセットしてください。');
      return stage;
    }
    step() { do { this.stage(); } while (this.phase !== 0); }
    measure() {
      const { n, nx, s, h, u, v } = this; let energy = 0, div2 = 0, maxSpeed = 0;
      for (let j = 1; j <= n; j++) for (let i = 1; i <= nx; i++) {
        const k = i + s * j, x = (u[k] + u[k - 1]) / 2, y = (v[k] + v[k - s]) / 2;
        energy += (x * x + y * y) / 2; maxSpeed = Math.max(maxSpeed, Math.hypot(x, y));
        div2 += (((u[k] - u[k - 1]) + (v[k] - v[k - s])) / h) ** 2;
      }
      return { energy: energy / (nx * n), divergence: Math.sqrt(div2 / (nx * n)), maxSpeed };
    }
    snapshot() {
      const { n, nx, s, h } = this, u = new Float32Array(nx * n), v = new Float32Array(nx * n), p = new Float32Array(nx * n), div = new Float32Array(nx * n);
      for (let j = 1; j <= n; j++) for (let i = 1; i <= nx; i++) {
        const k = i + s * j, a = i - 1 + nx * (j - 1);
        u[a] = (this.u[k] + this.u[k - 1]) / 2; v[a] = (this.v[k] + this.v[k - s]) / 2; p[a] = this.p[k];
        div[a] = ((this.u[k] - this.u[k - 1]) + (this.v[k] - this.v[k - s])) / h;
      }
      return { n, nx, h, lx: nx * h, ly: this.ly, rho: this.rho, u, v, p, div, time: this.time, steps: this.steps, phase: this.phase, dt: this.dt, cfl: this.cfl, diffusionNumber: this.diffusionNumber, projectionCount: this.projectionCount, stage: this.lastStage, stats: this.stats, before: this.beforeProjection, after: this.afterProjection, iterations: this.iterations, options: { ...this.options } };
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = FlowSolver;
  else root.FlowSolver = FlowSolver;
})(globalThis);
