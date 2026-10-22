'use strict';
(() => {
  const equations = {
  "time-step-equation": "\\begin{aligned}\\Delta t&=\\min\\!\\left(\\Delta t_{\\max},\\frac{0.35}{2U_{\\max}/h+4\\nu/h^2}\\right)\\\\t^{n+1}&=t^n+\\Delta t\\end{aligned}",
  "disc-advection": "A(q)_{i,j}=a\\,\\delta_x q_{i,j}+b\\,\\delta_y q_{i,j}",
  "disc-upwind-x": "\\delta_x q_{i,j}=\\begin{cases}\\dfrac{q_{i,j}-q_{i-1,j}}{h}&a\\geq0\\\\[8pt]\\dfrac{q_{i+1,j}-q_{i,j}}{h}&a<0\\end{cases}",
  "disc-upwind-y": "\\delta_y q_{i,j}=\\begin{cases}\\dfrac{q_{i,j}-q_{i,j-1}}{h}&b\\geq0\\\\[8pt]\\dfrac{q_{i,j+1}-q_{i,j}}{h}&b<0\\end{cases}",
  "disc-interpolation": "\\begin{aligned}\\bar v_{i+\\frac12,j}={}&\\tfrac14\\bigl(v_{i,j+\\frac12}+v_{i+1,j+\\frac12}\\\\&\\quad+v_{i,j-\\frac12}+v_{i+1,j-\\frac12}\\bigr)\\\\[6pt]\\bar u_{i,j+\\frac12}={}&\\tfrac14\\bigl(u_{i+\\frac12,j}+u_{i-\\frac12,j}\\\\&\\quad+u_{i+\\frac12,j+1}+u_{i-\\frac12,j+1}\\bigr)\\end{aligned}",
  "disc-diffusion": "\\begin{aligned}\\Delta_hq_{i,j}={}&\\frac{q_{i+1,j}-2q_{i,j}+q_{i-1,j}}{h^2}\\\\&+\\frac{q_{i,j+1}-2q_{i,j}+q_{i,j-1}}{h^2}\\end{aligned}",
  "disc-predictor": "q^*=q^n-\\Delta t\\,A(q^n)+\\nu\\Delta t\\,\\Delta_hq^n",
  "disc-divergence": "\\begin{aligned}d_{i,j}={}&\\frac{u^*_{i+\\frac12,j}-u^*_{i-\\frac12,j}}h\\\\&+\\frac{v^*_{i,j+\\frac12}-v^*_{i,j-\\frac12}}h\\end{aligned}",
  "disc-poisson": "\\begin{aligned}&\\frac{\\pi_{i+1,j}-2\\pi_{i,j}+\\pi_{i-1,j}}{h^2}\\\\&\\quad+\\frac{\\pi_{i,j+1}-2\\pi_{i,j}+\\pi_{i,j-1}}{h^2}=\\frac{d_{i,j}}{\\Delta t}\\end{aligned}",
  "disc-outlet": "\\begin{aligned}\\pi_{N_x+1,j}&=-\\pi_{N_x,j}\\\\u^{n+1}_{N_x+\\frac12,j}&=u^*_{N_x+\\frac12,j}+\\frac{2\\Delta t}{h}\\pi_{N_x,j}\\end{aligned}",
  "disc-correction": "\\begin{aligned}u^{n+1}_{i+\\frac12,j}&=u^*_{i+\\frac12,j}\\\\&\\quad-\\frac{\\Delta t}h(\\pi_{i+1,j}-\\pi_{i,j})\\\\[6pt]v^{n+1}_{i,j+\\frac12}&=v^*_{i,j+\\frac12}\\\\&\\quad-\\frac{\\Delta t}h(\\pi_{i,j+1}-\\pi_{i,j})\\end{aligned}",
  "dimensional-equation": "\\begin{gathered}Re=\\frac{UL}{\\nu},\\qquad U=\\frac{Re\\,\\nu}L\\\\x=L\\hat x,\\quad u=U\\hat u,\\quad t=\\frac LU\\hat t\\end{gathered}"
};
  const render = (el, tex, displayMode = false) => {
    if (window.katex) katex.render(tex, el, { throwOnError: true, displayMode });
    else el.textContent = tex;
  };
  for (const [id, tex] of Object.entries(equations)) render(document.getElementById(id), tex, true);
  document.querySelectorAll('[data-math]').forEach(el => render(el, el.dataset.math));
})();
