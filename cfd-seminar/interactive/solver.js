/* MIT, Copyright (c) 2026 KIDENA-Fumiya. Browser adaptation of cfd-seminar. */
(function (root) {
  'use strict';
  class FlowSolver {
    constructor(n = 32) {
      if (!Number.isInteger(n) || n < 16 || n > 200) throw new Error('Unsupported grid');
      // SI throughout. Pressure storage is (p-p0)/rho, with p0=0 as the gauge.
      this.n = n; this.rho = 1000;
      this.options = { case: 'channel', advection: true, advectionScheme: 'upwind', viscosity: false, pressure: false, nu: 1e-6, lid: 0.04, inflow: 0.01 };
      this.reset();
    }
    index(i, j) { return i + this.s * j; }
    configure(options) {
      const next = { ...this.options };
      const changedCase = 'case' in options && options.case !== this.options.case;
      if ('case' in options) {
        if (!['channel', 'cavity'].includes(options.case)) throw new Error('Unsupported case');
        next.case = options.case;
      }
      if ('advectionScheme' in options) {
        if (!['upwind', 'godunov'].includes(options.advectionScheme)) throw new Error('Unsupported advection scheme');
        next.advectionScheme = options.advectionScheme;
      }
      for (const key of ['advection', 'viscosity', 'pressure']) if (key in options) next[key] = !!options[key];
      for (const [key, lo, hi] of [['nu', 5e-7, 1e-5], ['lid', 0, 0.04], ['inflow', 0.0001, 0.01]]) {
        if (key in options) {
          const x = Number(options[key]);
          if (!Number.isFinite(x)) throw new Error('Invalid parameter');
          next[key] = Math.max(lo, Math.min(hi, x));
        }
      }
      this.options = next;
      if (changedCase) { this.reset(); return; }
      // Parameter changes start a new complete step, not half of the old operator sequence.
      if (this.phase) { this.u.set(this.un); this.v.set(this.vn); this.phase = 0; }
      if (this.dt > 0) this.boundary();
      this.lastStage = '設定変更'; this.stats = this.measure();
    }
    reset() {
      const channel = this.options.case === 'channel';
      this.ly = channel ? .004 : .01; this.h = this.ly / this.n;
      this.nx = channel ? 5 * this.n : this.n;
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
        for (let j = 1; j <= n; j++) u[nx + s * j] = u[nx - 1 + s * j];
      }
      for (let j = 1; j <= n; j++) {
        u[s * j] = channel ? this.options.inflow : 0;
        if (!channel) u[nx + s * j] = 0;
        v[s * j] = -v[1 + s * j]; v[nx + 1 + s * j] = (channel ? 1 : -1) * v[nx + s * j];
      }
      for (let i = 1; i <= nx; i++) { v[i] = 0; v[i + s * n] = 0; u[i] = -u[i + s]; u[i + s * (n + 1)] = 2 * (channel ? 0 : this.options.lid) - u[i + s * n]; }
    }
    timeStep() {
      // Reserve both operators and a 2U ghost-cell speed, independent of the toggles.
      const speed = Math.max(.01, this.options.case === 'channel' ? this.options.inflow : this.options.lid);
      const limit = .35 / (4 * speed / this.h + 4 * this.options.nu / this.h ** 2);
      const unit = 10 ** Math.floor(Math.log10(limit));
      return Number((Math.floor(limit / unit) * unit).toPrecision(1));
    }
    begin() {
      this.boundary(); this.un.set(this.u); this.vn.set(this.v);
      let speed = 0;
      for (let k = 0; k < this.u.length; k++) speed = Math.max(speed, Math.abs(this.u[k]), Math.abs(this.v[k]));
      const nu = this.options.viscosity ? this.options.nu : 0;
      const advectionRate = this.options.advection ? 2 * speed / this.h : 0;
      const diffusionRate = 4 * nu / this.h ** 2;
      this.dt = this.timeStep();
      this.cfl = advectionRate * this.dt;
      this.diffusionNumber = diffusionRate * this.dt;
      if (this.cfl + this.diffusionNumber > 1) throw new Error('固定の時間刻みで安定条件を超えました。リセットしてください。');
    }
    static burgersFlux(left, right) {
      const fl = left * left / 2, fr = right * right / 2;
      if (left > right) return Math.max(fl, fr);
      return left <= 0 && right >= 0 ? 0 : Math.min(fl, fr);
    }
    advection() {
      const { n, nx, s, un, vn, u, v, dt, h } = this;
      // cfd-seminar/advection.f90 MAC interpolation; first-order upwind from advection2.html.
      const diff = (a, k, stride, speed) => speed >= 0 ? (a[k] - a[k - stride]) / h : (a[k + stride] - a[k]) / h;
      // Godunov for self-advection (Burgers); cross-advection retains MAC upwinding.
      const flux = FlowSolver.burgersFlux, godunov = this.options.advectionScheme === 'godunov';
      for (let j = 1; j <= n; j++) for (let i = 1; i < nx; i++) {
        const k = i + s * j, va = (vn[k] + vn[k + 1] + vn[k - s] + vn[k + 1 - s]) / 4;
        const self = godunov ? (flux(un[k], un[k + 1]) - flux(un[k - 1], un[k])) / h : un[k] * diff(un, k, 1, un[k]);
        u[k] -= dt * (self + va * diff(un, k, s, va));
      }
      for (let j = 1; j < n; j++) for (let i = 1; i <= nx; i++) {
        const k = i + s * j, ua = (un[k] + un[k - 1] + un[k + s] + un[k - 1 + s]) / 4;
        const self = godunov ? (flux(vn[k], vn[k + s]) - flux(vn[k - s], vn[k])) / h : vn[k] * diff(vn, k, s, vn[k]);
        v[k] -= dt * (ua * diff(vn, k, 1, ua) + self);
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
      const channel = this.options.case === 'channel';
      for (let j = 1; j <= n; j++) for (let i = 1; i <= nx; i++) {
        const k = i + s * j;
        out[k] = ((i > 1 ? x[k] - x[k - 1] : 0) + (i < nx ? x[k] - x[k + 1] : channel ? 2*x[k] : 0) + (j > 1 ? x[k] - x[k - s] : 0) + (j < n ? x[k] - x[k + s] : 0)) * ih2;
      }
    }
    dot(a, b) {
      let sum = 0;
      for (let j = 1; j <= this.n; j++) for (let i = 1; i <= this.nx; i++) { const k = i + this.s * j; sum += a[k] * b[k]; }
      return sum;
    }
    projection() {
      const { n, nx, s, h, dt, u, v, p, rhs, r, d, ad } = this;
      const channel = this.options.case === 'channel';
      this.beforeProjection = this.measure().divergence;
      let mean = 0;
      for (let j = 1; j <= n; j++) for (let i = 1; i <= nx; i++) {
        const k = i + s * j; rhs[k] = -((u[k] - u[k - 1]) + (v[k] - v[k - s])) / h / dt; mean += rhs[k];
      }
      mean = channel ? 0 : mean / (nx * n); p.fill(0);
      for (let j = 1; j <= n; j++) for (let i = 1; i <= nx; i++) { const k = i + s * j; r[k] = d[k] = rhs[k] - mean; }
      let rr = this.dot(r, r), tolerance = Math.max(1e-20, rr * 1e-14), iter = 0;
      // Outlet-face Dirichlet pressure for channel; mean-zero Neumann problem for cavity.
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
      if (!channel) {
        mean = 0;
        for (let j = 1; j <= n; j++) for (let i = 1; i <= nx; i++) mean += p[i + s * j];
        mean /= nx * n;
        for (let j = 1; j <= n; j++) for (let i = 1; i <= nx; i++) p[i + s * j] -= mean;
      }
      for (let j = 1; j <= n; j++) for (let i = 1; i < nx; i++) { const k = i + s * j; u[k] -= dt * (p[k + 1] - p[k]) / h; }
      for (let j = 1; j < n; j++) for (let i = 1; i <= nx; i++) { const k = i + s * j; v[k] -= dt * (p[k + s] - p[k]) / h; }
      if (channel) for (let j = 1; j <= n; j++) {
        const k = nx + s*j;
        // The outlet face is h/2 from the last pressure center; its gauge pressure is zero.
        p[k + 1] = -p[k];
        u[k] += 2*dt*p[k]/h;
      }
      // Keep the pressure-corrected outlet face so the discrete divergence stays consistent.
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
    profiles() {
      const { n, nx, s, h } = this;
      const channel = this.options.case === 'channel', section = channel ? .9*nx : nx/2;
      const profileU = new Float32Array(n+2), left = Math.floor(section), right = Math.ceil(section);
      const weight = section-left;
      for (let j = 1; j <= n; j++) profileU[j] = (1-weight)*this.u[left+s*j]+weight*this.u[right+s*j];
      profileU[n+1] = !channel && this.dt > 0 ? this.options.lid : 0;
      const sectionY = n/2, bottom = Math.floor(sectionY), top = Math.ceil(sectionY);
      const profileV = new Float32Array(nx+2);
      for (let i = 1; i <= nx; i++) profileV[i] = (this.v[i+s*bottom]+this.v[i+s*top])/2;
      profileV[nx+1] = channel ? profileV[nx] : 0;
      return { profileU, profileX: section*h, profileV, profileY: sectionY*h };
    }
    snapshot() {
      const { n, nx, s, h } = this, u = new Float32Array(nx * n), v = new Float32Array(nx * n), p = new Float32Array(nx * n), div = new Float32Array(nx * n);
      for (let j = 1; j <= n; j++) for (let i = 1; i <= nx; i++) {
        const k = i + s * j, a = i - 1 + nx * (j - 1);
        u[a] = (this.u[k] + this.u[k - 1]) / 2; v[a] = (this.v[k] + this.v[k - s]) / 2; p[a] = this.p[k];
        div[a] = ((this.u[k] - this.u[k - 1]) + (this.v[k] - this.v[k - s])) / h;
      }
      return { n, nx, h, lx: nx * h, ly: this.ly, rho: this.rho, u, v, p, div, ...this.profiles(), time: this.time, steps: this.steps, phase: this.phase, dt: this.dt, fixedDt: this.timeStep(), cfl: this.cfl, diffusionNumber: this.diffusionNumber, projectionCount: this.projectionCount, stage: this.lastStage, stats: this.stats, before: this.beforeProjection, after: this.afterProjection, iterations: this.iterations, options: { ...this.options } };
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = FlowSolver;
  else root.FlowSolver = FlowSolver;
})(globalThis);
