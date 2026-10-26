/* MIT, Copyright (c) 2026 KIDENA-Fumiya. Browser adaptation of cfd-seminar. */
(function (root) {
  'use strict';
  class FlowSolver {
    constructor(n = 32) {
      if (!Number.isInteger(n) || n < 16 || n > 200) throw new Error('Unsupported grid');
      // SI throughout. Pressure storage is (p-p0)/rho, with p0=0 as the gauge.
      this.n = n; this.rho = 1000; this.gravityAcceleration = 9.81;
      this.options = { case: 'channel', advection: true, advectionScheme: 'upwind', viscosity: false, gravity: false, pressure: false, nu: 1e-6, lid: 0.04, inflow: 0.01, cfl: .09 };
      this.reset();
    }
    index(i, j) { return i + this.s * j; }
    configure(options) {
      const next = { ...this.options };
      const changedCase = 'case' in options && options.case !== this.options.case;
      if ('case' in options) {
        if (!['channel', 'cavity', 'pool'].includes(options.case)) throw new Error('Unsupported case');
        next.case = options.case;
      }
      if ('advectionScheme' in options) {
        if (!['upwind', 'godunov'].includes(options.advectionScheme)) throw new Error('Unsupported advection scheme');
        next.advectionScheme = options.advectionScheme;
      }
      for (const key of ['advection', 'viscosity', 'gravity', 'pressure']) if (key in options) next[key] = !!options[key];
      for (const [key, lo, hi] of [['nu', 5e-7, 1e-5], ['lid', 0, 0.04], ['inflow', 0.0001, 0.01], ['cfl', .001, .5]]) {
        if (key in options) {
          const x = Number(options[key]);
          if (!Number.isFinite(x)) throw new Error('Invalid parameter');
          next[key] = Math.max(lo, Math.min(hi, x));
        }
      }
      next.cfl = Math.min(next.cfl, this.cflLimit(next));
      this.options = next;
      if (changedCase) { this.reset(); return; }
      // Parameter changes start a new complete step, not half of the old operator sequence.
      if (this.phase) { this.u.set(this.un); this.v.set(this.vn); this.phase = 0; }
      if (this.dt > 0) this.boundary();
      this.lastStage = '設定変更'; this.stats = this.measure();
    }
    reset() {
      this.options.cfl = Math.min(this.options.cfl, this.cflLimit());
      const channel = this.options.case === 'channel';
      this.ly = channel ? .004 : .01; this.h = this.ly / this.n;
      const pool = this.options.case === 'pool';
      this.nx = (channel ? 5 : pool ? 2 : 1) * this.n;
      this.s = this.nx + 2;
      for (const key of ['u', 'v', 'un', 'vn', 'p', 'rhs', 'r', 'd', 'ad']) this[key] = new Float64Array(this.s * (this.n + 2));
      this.fluid = new Uint8Array(this.u.length); this.fluidCount = 0;
      // Rectangular walls on a 16-unit layout, snapped to the selected mesh.
      const walls = (pool ? [
        [7,9,5,16], [6,10,7,12], [7,10,5,7], [8,10,4,5],
        [0,4,8,10], [0,2,10,12], [0,1,0,4],
        [4,7,0,1], [14,16,9,12], [15,16,12,14], [14,16,0,3]
      ] : []).map(([left,right,bottom,top]) => [
        Math.round(left*this.nx/16), Math.round(right*this.nx/16),
        Math.round(bottom*this.n/16), Math.round(top*this.n/16)
      ]);
      for (let i = 1; i <= this.nx; i++) {
        for (let j = 1; j <= this.n; j++) {
          const solid = walls.some(([left,right,bottom,top]) => i>left && i<=right && j>bottom && j<=top);
          if (!solid) { this.fluid[this.index(i, j)] = 1; this.fluidCount++; }
        }
      }
      this.openU = new Uint8Array(this.u.length); this.openV = new Uint8Array(this.v.length);
      for (let j = 1; j <= this.n; j++) for (let i = 1; i <= this.nx; i++) {
        const k = this.index(i, j);
        this.openU[k] = this.fluid[k] && this.fluid[k + 1];
        this.openV[k] = this.fluid[k] && (this.fluid[k + this.s] || (pool && j === this.n));
      }
      this.time = 0; this.steps = 0; this.phase = 0; this.dt = 0;
      this.cfl = 0; this.diffusionNumber = 0; this.projectionCount = 0;
      this.lastStage = '準備完了'; this.iterations = 0; this.converged = true;
      this.beforeProjection = 0; this.afterProjection = 0;
      this.stats = this.measure();
    }
    boundary(refreshOutlet = true) {
      const { n, nx, s, u, v } = this;
      if (this.options.case === 'pool') {
        for (let k = 0; k < u.length; k++) {
          if (!this.openU[k]) u[k] = 0;
          if (!this.openV[k]) v[k] = 0;
        }
        if (refreshOutlet) for (let i = 1; i <= nx; i++) {
          const k = i + s*n;
          if (this.openV[k]) v[k] = v[k-s];
        }
        return;
      }
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
    referenceSpeed(options = this.options) {
      return options.case === 'pool' ? Math.sqrt(this.gravityAcceleration * .01)
        : Math.max(.01, options.case === 'channel' ? options.inflow : options.lid);
    }
    cflLimit(options = this.options) {
      // Reserve both operators and ghost-cell speeds even when terms are disabled.
      const h = (options.case === 'channel' ? .004 : .01) / this.n;
      const speed = this.referenceSpeed(options);
      const limit = .95 / (4 + 4 * options.nu / (speed * h));
      return Math.floor(limit * 1000) / 1000;
    }
    timeStep() {
      const speed = this.referenceSpeed();
      return Number((Math.min(this.options.cfl, this.cflLimit()) * this.h / speed).toPrecision(12));
    }
    begin() {
      this.boundary(); this.un.set(this.u); this.vn.set(this.v);
      let speed = 0;
      for (let k = 0; k < this.u.length; k++) speed = Math.max(speed, Math.abs(this.u[k]), Math.abs(this.v[k]));
      const nu = this.options.viscosity ? this.options.nu : 0;
      this.dt = this.timeStep();
      if (this.options.gravity) speed += this.gravityAcceleration * this.dt;
      const advectionRate = this.options.advection ? 2 * speed / this.h : 0;
      const diffusionRate = 4 * nu / this.h ** 2;
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
      if (this.options.case === 'pool') { this.poolTransport(false); return; }
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
      if (this.options.case === 'pool') { this.poolTransport(true); return; }
      const { n, nx, s, un, vn, u, v, dt, h } = this, a = dt * this.options.nu / h ** 2;
      for (let j = 1; j <= n; j++) for (let i = 1; i < nx; i++) {
        const k = i + s * j; u[k] += a * (un[k - 1] + un[k + 1] + un[k - s] + un[k + s] - 4 * un[k]);
      }
      for (let j = 1; j < n; j++) for (let i = 1; i <= nx; i++) {
        const k = i + s * j; v[k] += a * (vn[k - 1] + vn[k + 1] + vn[k - s] + vn[k + s] - 4 * vn[k]);
      }
      this.boundary();
    }
    poolTransport(diffusion) {
      const { n, nx, s, un, vn, dt, h } = this;
      for (const [a, old, active, horizontal] of [[this.u, un, this.openU, true], [this.v, vn, this.openV, false]]) {
        for (let j = 1; j <= (horizontal ? n : n-1); j++) for (let i = 1; i <= nx; i++) {
          const k = i + s*j;
          if (!active[k]) continue;
          // Normal wall faces are zero; tangential ghosts enforce no-slip, except at the free surface.
          const neighbor = offset => active[k+offset] ? old[k+offset]
            : horizontal && offset === s && j === n ? old[k]
            : (horizontal ? Math.abs(offset) === 1 : Math.abs(offset) === s) ? 0 : -old[k];
          if (diffusion) {
            a[k] += dt*this.options.nu/h**2 * (neighbor(-1)+neighbor(1)+neighbor(-s)+neighbor(s)-4*old[k]);
          } else {
            const cross = horizontal ? (vn[k]+vn[k+1]+vn[k-s]+vn[k+1-s])/4 : (un[k]+un[k-1]+un[k+s]+un[k-1+s])/4;
            const ownStride = horizontal ? 1 : s, crossStride = horizontal ? s : 1;
            const derivative = (speed, stride) => speed >= 0 ? (old[k]-neighbor(-stride))/h : (neighbor(stride)-old[k])/h;
            const self = this.options.advectionScheme === 'godunov'
              ? (FlowSolver.burgersFlux(old[k],neighbor(ownStride))-FlowSolver.burgersFlux(neighbor(-ownStride),old[k]))/h
              : old[k]*derivative(old[k],ownStride);
            a[k] -= dt*(self+cross*derivative(cross,crossStride));
          }
        }
      }
      this.boundary();
    }
    gravity() {
      for (let k = 0; k < this.v.length; k++) if (this.openV[k]) this.v[k] -= this.gravityAcceleration * this.dt;
      this.boundary(false);
    }
    negativeLaplacian(x, out) {
      const { n, nx, s, h } = this, ih2 = 1 / h ** 2;
      const channel = this.options.case === 'channel';
      if (this.options.case !== 'pool') {
        for (let j = 1; j <= n; j++) for (let i = 1; i <= nx; i++) {
          const k = i + s*j;
          out[k] = ((i > 1 ? x[k]-x[k-1] : 0) + (i < nx ? x[k]-x[k+1] : channel ? 2*x[k] : 0) + (j > 1 ? x[k]-x[k-s] : 0) + (j < n ? x[k]-x[k+s] : 0)) * ih2;
        }
        return;
      }
      for (let j = 1; j <= n; j++) for (let i = 1; i <= nx; i++) {
        const k = i + s * j;
        if (!this.fluid[k]) { out[k] = 0; continue; }
        out[k] = ((this.fluid[k-1] ? x[k]-x[k-1] : 0) + (this.fluid[k+1] ? x[k]-x[k+1] : 0) + (this.fluid[k-s] ? x[k]-x[k-s] : 0) + (this.fluid[k+s] ? x[k]-x[k+s] : j === n ? 2*x[k] : 0)) * ih2;
      }
    }
    dot(a, b) {
      let sum = 0;
      if (this.options.case !== 'pool') {
        for (let j = 1; j <= this.n; j++) for (let i = 1; i <= this.nx; i++) { const k = i + this.s*j; sum += a[k]*b[k]; }
        return sum;
      }
      for (let j = 1; j <= this.n; j++) for (let i = 1; i <= this.nx; i++) { const k = i + this.s * j; if (this.fluid[k]) sum += a[k] * b[k]; }
      return sum;
    }
    projection() {
      const { n, nx, s, h, dt, u, v, p, rhs, r, d, ad } = this;
      const channel = this.options.case === 'channel';
      this.beforeProjection = this.measure().divergence;
      let mean = 0;
      for (let j = 1; j <= n; j++) for (let i = 1; i <= nx; i++) {
        const k = i + s * j; rhs[k] = this.fluid[k] ? -((u[k] - u[k - 1]) + (v[k] - v[k - s])) / h / dt : 0; mean += rhs[k];
      }
      const cavity = this.options.case === 'cavity';
      mean = cavity ? mean / this.fluidCount : 0; p.fill(0);
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
      if (cavity) {
        mean = 0;
        for (let j = 1; j <= n; j++) for (let i = 1; i <= nx; i++) mean += p[i + s * j];
        mean /= nx * n;
        for (let j = 1; j <= n; j++) for (let i = 1; i <= nx; i++) p[i + s * j] -= mean;
      }
      for (let j = 1; j <= n; j++) for (let i = 1; i < nx; i++) { const k = i + s * j; if (this.openU[k]) u[k] -= dt * (p[k + 1] - p[k]) / h; }
      for (let j = 1; j < n; j++) for (let i = 1; i <= nx; i++) { const k = i + s * j; if (this.openV[k]) v[k] -= dt * (p[k + s] - p[k]) / h; }
      if (channel) for (let j = 1; j <= n; j++) {
        const k = nx + s*j;
        // The outlet face is h/2 from the last pressure center; its gauge pressure is zero.
        p[k + 1] = -p[k];
        u[k] += 2*dt*p[k]/h;
      }
      if (this.options.case === 'pool') for (let i = 1; i <= nx; i++) {
        const k = i + s*n;
        if (!this.openV[k]) continue;
        p[k+s] = -p[k]; v[k] += 2*dt*p[k]/h;
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
      if (stage === 2) { if (this.options.gravity) this.gravity(); this.lastStage = this.options.gravity ? '重力' : '重力をスキップ'; }
      if (stage === 3) {
        if (this.options.pressure) this.projection(); else this.p.fill(0);
        this.lastStage = this.options.pressure ? '圧力補正' : '圧力補正をスキップ';
        this.time += this.dt; this.steps++;
      }
      this.phase = (stage + 1) % 4;
      this.stats = this.measure();
      if (!Number.isFinite(this.stats.energy) || this.stats.maxSpeed > 1) throw new Error('速度が計算範囲を超えました。リセットしてください。');
      return stage;
    }
    step() { do { this.stage(); } while (this.phase !== 0); }
    measure() {
      const { n, nx, s, h, u, v } = this; let energy = 0, div2 = 0, maxSpeed = 0;
      for (let j = 1; j <= n; j++) for (let i = 1; i <= nx; i++) {
        const k = i + s * j;
        if (!this.fluid[k]) continue;
        const x = (u[k] + u[k - 1]) / 2, y = (v[k] + v[k - s]) / 2;
        energy += (x * x + y * y) / 2; maxSpeed = Math.max(maxSpeed, Math.hypot(x, y));
        div2 += (((u[k] - u[k - 1]) + (v[k] - v[k - s])) / h) ** 2;
      }
      return { energy: energy / this.fluidCount, divergence: Math.sqrt(div2 / this.fluidCount), maxSpeed };
    }
    profiles() {
      const { n, nx, s, h } = this;
      const channel = this.options.case === 'channel', section = channel ? .9*nx : nx/2;
      const profileU = new Float32Array(n+2), left = Math.floor(section), right = Math.ceil(section);
      const weight = section-left;
      for (let j = 1; j <= n; j++) profileU[j] = (1-weight)*this.u[left+s*j]+weight*this.u[right+s*j];
      profileU[n+1] = this.options.case === 'cavity' && this.dt > 0 ? this.options.lid : 0;
      const sectionY = n/2, bottom = Math.floor(sectionY), top = Math.ceil(sectionY);
      const profileV = new Float32Array(nx+2);
      for (let i = 1; i <= nx; i++) profileV[i] = (this.v[i+s*bottom]+this.v[i+s*top])/2;
      profileV[nx+1] = channel ? profileV[nx] : 0;
      return { profileU, profileX: section*h, profileV, profileY: sectionY*h };
    }
    pressureProfiles() {
      if (this.options.case !== 'pool') return [];
      return [.1875, .8125].map(fraction => {
        const i = Math.floor(this.nx*fraction)+1, values = new Float32Array(this.n+2).fill(NaN);
        for (let j = 1; j <= this.n; j++) if (this.fluid[this.index(i,j)]) values[j] = this.rho*this.p[this.index(i,j)];
        values[this.n+1] = 0;
        return { x:(i-.5)*this.h, values };
      });
    }
    snapshot() {
      const { n, nx, s, h } = this, u = new Float32Array(nx * n), v = new Float32Array(nx * n), p = new Float32Array(nx * n), div = new Float32Array(nx * n);
      const fluid = new Uint8Array(nx*n);
      for (let j = 1; j <= n; j++) for (let i = 1; i <= nx; i++) {
        const k = i + s * j, a = i - 1 + nx * (j - 1);
        fluid[a] = this.fluid[k];
        if (!fluid[a]) continue;
        u[a] = (this.u[k] + this.u[k - 1]) / 2; v[a] = (this.v[k] + this.v[k - s]) / 2; p[a] = this.p[k];
        div[a] = ((this.u[k] - this.u[k - 1]) + (this.v[k] - this.v[k - s])) / h;
      }
      return { n, nx, h, lx: nx * h, ly: this.ly, rho: this.rho, gravityAcceleration: this.gravityAcceleration, referenceSpeed: this.referenceSpeed(), fluid, pressureProfiles:this.pressureProfiles(), u, v, p, div, ...this.profiles(), time: this.time, steps: this.steps, phase: this.phase, dt: this.dt, fixedDt: this.timeStep(), cflLimit: this.cflLimit(), cfl: this.cfl, diffusionNumber: this.diffusionNumber, projectionCount: this.projectionCount, stage: this.lastStage, stats: this.stats, before: this.beforeProjection, after: this.afterProjection, iterations: this.iterations, options: { ...this.options } };
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = FlowSolver;
  else root.FlowSolver = FlowSolver;
})(globalThis);
