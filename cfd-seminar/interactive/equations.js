'use strict';
(() => {
  const equations = {
  "disc-advection": "A(q)_{i,j}=a^+D_x^-q+a^-D_x^+q+b^+D_y^-q+b^-D_y^+q",
  "disc-upwind": "\\begin{aligned}D_x^-q&=\\frac{q_{i,j}-q_{i-1,j}}h,&D_x^+q&=\\frac{q_{i+1,j}-q_{i,j}}h\\\\a^+&=\\max(a,0),&a^-&=\\min(a,0)\\end{aligned}",
  "disc-interpolation": "\\begin{aligned}\\bar v_{i+\\frac12,j}&=\\frac{v_{i,j+\\frac12}+v_{i+1,j+\\frac12}+v_{i,j-\\frac12}+v_{i+1,j-\\frac12}}4\\\\\\bar u_{i,j+\\frac12}&=\\frac{u_{i+\\frac12,j}+u_{i-\\frac12,j}+u_{i+\\frac12,j+1}+u_{i-\\frac12,j+1}}4\\end{aligned}",
  "disc-diffusion": "\\Delta_hq_{i,j}=\\frac{q_{i+1,j}+q_{i-1,j}+q_{i,j+1}+q_{i,j-1}-4q_{i,j}}{h^2}",
  "disc-predictor": "q^*=q^n-\\Delta t\\,A(q^n)+\\nu\\Delta t\\,\\Delta_hq^n",
  "disc-divergence": "d_{i,j}=\\frac{u^*_{i+\\frac12,j}-u^*_{i-\\frac12,j}}h+\\frac{v^*_{i,j+\\frac12}-v^*_{i,j-\\frac12}}h",
  "disc-poisson": "\\Delta_h\\pi_{i,j}=\\frac{d_{i,j}}{\\Delta t}\\quad\\Longleftrightarrow\\quad-\\Delta_h\\pi_{i,j}=-\\frac{d_{i,j}}{\\Delta t}",
  "disc-correction": "\\begin{aligned}u^{n+1}_{i+\\frac12,j}&=u^*_{i+\\frac12,j}-\\frac{\\Delta t}h(\\pi_{i+1,j}-\\pi_{i,j})\\\\v^{n+1}_{i,j+\\frac12}&=v^*_{i,j+\\frac12}-\\frac{\\Delta t}h(\\pi_{i,j+1}-\\pi_{i,j})\\end{aligned}",
  "dimensional-equation": "Re=\\frac{UL}{\\nu},\\qquad U=\\frac{Re\\,\\nu}L,\\qquad x=L\\hat x,\\quad u=U\\hat u,\\quad t=\\frac LU\\hat t"
};
  const render = (el, tex, displayMode = false) => {
    if (window.katex) katex.render(tex, el, { throwOnError: true, displayMode });
    else el.textContent = tex;
  };
  for (const [id, tex] of Object.entries(equations)) render(document.getElementById(id), tex, true);
  document.querySelectorAll('[data-math]').forEach(el => render(el, el.dataset.math));
  const kernels = {
    advection: ['0', '0', '0', '-a', 'a+b', '0', '0', '-b', '0'],
    diffusion: ['0', '1', '0', '1', '-4', '1', '0', '1', '0'],
    poisson: ['0', '-1', '0', '-1', '4', '-1', '0', '-1', '0']
  };
  document.querySelectorAll('[data-kernel]').forEach(el => {
    kernels[el.dataset.kernel].forEach((tex, i) => {
      const cell = document.createElement('span');
      cell.className = (tex === '0' ? 'unused' : 'used') + (i === 4 ? ' center' : '');
      render(cell, tex); el.appendChild(cell);
    });
  });
})();
