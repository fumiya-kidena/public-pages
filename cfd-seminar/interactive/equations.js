'use strict';
(() => {
  const equations = {
  "disc-upwind2-ux": String.raw`\begin{gathered}\left(\frac{\partial u}{\partial x}\right)_{i,j}\approx\\\begin{cases}\dfrac{3u_{i,j}-4u_{i-1,j}+u_{i-2,j}}{2h}&u_{i,j}\geq0\\[8pt]\dfrac{-3u_{i,j}+4u_{i+1,j}-u_{i+2,j}}{2h}&u_{i,j}<0\end{cases}\end{gathered}`,
  "disc-upwind2-uy": String.raw`\begin{gathered}\left(\frac{\partial u}{\partial y}\right)_{i,j}\approx\\\begin{cases}\dfrac{3u_{i,j}-4u_{i,j-1}+u_{i,j-2}}{2h}&\bar v_{i,j}\geq0\\[8pt]\dfrac{-3u_{i,j}+4u_{i,j+1}-u_{i,j+2}}{2h}&\bar v_{i,j}<0\end{cases}\end{gathered}`,
  "disc-upwind2-u": String.raw`\begin{aligned}u^{(m+1)}_{i,j}={}&u^{(m)}_{i,j}\\&-\Delta t_a\,u^{(m)}_{i,j}\\&\quad\cdot\frac{3u^{(m)}_{i,j}-4u^{(m)}_{i-1,j}+u^{(m)}_{i-2,j}}{2h}\\&-\Delta t_a\,\bar v^{(m)}_{i,j}\\&\quad\cdot\frac{3u^{(m)}_{i,j}-4u^{(m)}_{i,j-1}+u^{(m)}_{i,j-2}}{2h}\end{aligned}`,
  "disc-upwind2-v": String.raw`\begin{aligned}v^{(m+1)}_{i,j}={}&v^{(m)}_{i,j}\\&-\Delta t_a\,\bar u^{(m)}_{i,j}\\&\quad\cdot\frac{3v^{(m)}_{i,j}-4v^{(m)}_{i-1,j}+v^{(m)}_{i-2,j}}{2h}\\&-\Delta t_a\,v^{(m)}_{i,j}\\&\quad\cdot\frac{3v^{(m)}_{i,j}-4v^{(m)}_{i,j-1}+v^{(m)}_{i,j-2}}{2h}\end{aligned}`,
  "disc-upwind2-rk": String.raw`\begin{gathered}u^{(0)}=u_{\rm start},\quad v^{(0)}=v_{\rm start}\\m=0,1,\qquad\Delta t_a=\Delta t/N_a\\u_{\rm end}=\tfrac12(u^{(0)}+u^{(2)})\\v_{\rm end}=\tfrac12(v^{(0)}+v^{(2)})\end{gathered}`,
  "disc-gravity": String.raw`\begin{gathered}\mathbf{g}=(0,-g),\quad g=9.81\ \mathrm{m/s^2}\\v^*_{i,j}\leftarrow v^*_{i,j}-g\Delta t\end{gathered}`,
  "hydrostatic-equation": String.raw`\begin{aligned}0&=-\frac1\rho\frac{\partial p}{\partial y}-g\\p(y)-p_0&=\rho g(H-y),\quad H=10\ \mathrm{mm}\end{aligned}`,
  "disc-godunov-u": String.raw`\begin{aligned}u'_{i,j}={}&u^n_{i,j}\\&-\frac{\Delta t}h F(u^n_{i,j},u^n_{i+1,j})\\&+\frac{\Delta t}h F(u^n_{i-1,j},u^n_{i,j})\\&-\Delta t\,\bar v^n_{i,j}\frac{u^n_{i,j}-u^n_{i,j-1}}h\end{aligned}`,
  "disc-godunov-v": String.raw`\begin{aligned}v'_{i,j}={}&v^n_{i,j}\\&-\Delta t\,\bar u^n_{i,j}\frac{v^n_{i,j}-v^n_{i-1,j}}h\\&-\frac{\Delta t}h F(v^n_{i,j},v^n_{i,j+1})\\&+\frac{\Delta t}h F(v^n_{i,j-1},v^n_{i,j})\end{aligned}`,
  "disc-godunov-flux": String.raw`\begin{gathered}F(u_L,u_R)=\\\begin{cases}\max(u_L^2,u_R^2)/2&u_L>u_R\\[5pt]0&u_L\leq0\leq u_R\\[5pt]\min(u_L^2,u_R^2)/2&\text{otherwise}\end{cases}\end{gathered}`,
  "time-step-equation": "\\begin{aligned}C&=\\frac{U\\Delta t}{h}\\\\C_{\\max}&\\leq\\frac{0.95}{4+4\\nu/(Uh)}\\\\\\Delta t&=\\frac{Ch}{U}\\end{aligned}",
  "disc-advection-u": String.raw`\begin{aligned}u'_{i,j}={}&u^n_{i,j}\\&-\Delta t\,u^n_{i,j}\frac{u^n_{i,j}-u^n_{i-1,j}}h\\&-\Delta t\,\bar v^n_{i,j}\frac{u^n_{i,j}-u^n_{i,j-1}}h\end{aligned}`,
  "disc-advection-v": String.raw`\begin{aligned}v'_{i,j}={}&v^n_{i,j}\\&-\Delta t\,\bar u^n_{i,j}\frac{v^n_{i,j}-v^n_{i-1,j}}h\\&-\Delta t\,v^n_{i,j}\frac{v^n_{i,j}-v^n_{i,j-1}}h\end{aligned}`,
  "disc-average-v": String.raw`\begin{aligned}\bar v^n_{i,j}={}&\tfrac14\bigl(v^n_{i,j}+v^n_{i+1,j}\\&\quad+v^n_{i,j-1}+v^n_{i+1,j-1}\bigr)\end{aligned}`,
  "disc-average-u": String.raw`\begin{aligned}\bar u^n_{i,j}={}&\tfrac14\bigl(u^n_{i,j}+u^n_{i-1,j}\\&\quad+u^n_{i,j+1}+u^n_{i-1,j+1}\bigr)\end{aligned}`,
  "disc-upwind-ux": String.raw`\left(\frac{\partial u}{\partial x}\right)^n_{i,j}\!\approx\begin{cases}\dfrac{u^n_{i,j}-u^n_{i-1,j}}h&u^n_{i,j}\geq0\\[8pt]\dfrac{u^n_{i+1,j}-u^n_{i,j}}h&u^n_{i,j}<0\end{cases}`,
  "disc-upwind-uy": String.raw`\left(\frac{\partial u}{\partial y}\right)^n_{i,j}\!\approx\begin{cases}\dfrac{u^n_{i,j}-u^n_{i,j-1}}h&\bar v^n_{i,j}\geq0\\[8pt]\dfrac{u^n_{i,j+1}-u^n_{i,j}}h&\bar v^n_{i,j}<0\end{cases}`,
  "disc-upwind-vx": String.raw`\left(\frac{\partial v}{\partial x}\right)^n_{i,j}\!\approx\begin{cases}\dfrac{v^n_{i,j}-v^n_{i-1,j}}h&\bar u^n_{i,j}\geq0\\[8pt]\dfrac{v^n_{i+1,j}-v^n_{i,j}}h&\bar u^n_{i,j}<0\end{cases}`,
  "disc-upwind-vy": String.raw`\left(\frac{\partial v}{\partial y}\right)^n_{i,j}\!\approx\begin{cases}\dfrac{v^n_{i,j}-v^n_{i,j-1}}h&v^n_{i,j}\geq0\\[8pt]\dfrac{v^n_{i,j+1}-v^n_{i,j}}h&v^n_{i,j}<0\end{cases}`,
  "disc-diffusion-u": String.raw`\begin{aligned}u^*_{i,j}={}&u'_{i,j}\\&+\nu\Delta t\,\frac{u^n_{i+1,j}-2u^n_{i,j}+u^n_{i-1,j}}{h^2}\\&+\nu\Delta t\,\frac{u^n_{i,j+1}-2u^n_{i,j}+u^n_{i,j-1}}{h^2}\end{aligned}`,
  "disc-diffusion-v": String.raw`\begin{aligned}v^*_{i,j}={}&v'_{i,j}\\&+\nu\Delta t\,\frac{v^n_{i+1,j}-2v^n_{i,j}+v^n_{i-1,j}}{h^2}\\&+\nu\Delta t\,\frac{v^n_{i,j+1}-2v^n_{i,j}+v^n_{i,j-1}}{h^2}\end{aligned}`,
  "poisson-equation": String.raw`\begin{aligned}&\frac{\partial^2 p}{\partial x^2}+\frac{\partial^2 p}{\partial y^2}\\&=\frac\rho{\Delta t}\left(\frac{\partial u^*}{\partial x}+\frac{\partial v^*}{\partial y}\right)\end{aligned}`,
  "disc-poisson": String.raw`\begin{aligned}&\frac{p_{i+1,j}-2p_{i,j}+p_{i-1,j}}{h^2}\\&\quad+\frac{p_{i,j+1}-2p_{i,j}+p_{i,j-1}}{h^2}\\&=\frac\rho{\Delta t}\left(\frac{u^*_{i,j}-u^*_{i-1,j}}h\right.\\&\qquad\qquad\left.+\frac{v^*_{i,j}-v^*_{i,j-1}}h\right)\end{aligned}`,
  "disc-correction-u": String.raw`\begin{aligned}u^{n+1}_{i,j}={}&u^*_{i,j}\\&-\frac{\Delta t}{\rho h}(p_{i+1,j}-p_{i,j})\end{aligned}`,
  "disc-correction-v": String.raw`\begin{aligned}v^{n+1}_{i,j}={}&v^*_{i,j}\\&-\frac{\Delta t}{\rho h}(p_{i,j+1}-p_{i,j})\end{aligned}`,
  "disc-continuity": String.raw`\begin{aligned}&\frac{u^{n+1}_{i,j}-u^{n+1}_{i-1,j}}h\\&\quad+\frac{v^{n+1}_{i,j}-v^{n+1}_{i,j-1}}h\approx0\end{aligned}`,
  "disc-outlet": String.raw`\begin{aligned}p_{N_x+1,j}&=2p_0-p_{N_x,j}\\u^{n+1}_{N_x,j}&=u^*_{N_x,j}\\&\quad+\frac{2\Delta t}{\rho h}(p_{N_x,j}-p_0)\end{aligned}`,
  "dimensional-equation": "\\begin{gathered}Re=\\frac{UL}{\\nu},\\qquad U=\\frac{Re\\,\\nu}L\\\\x=L\\hat x,\\quad u=U\\hat u,\\quad t=\\frac LU\\hat t\\end{gathered}"
};
  const render = (el, tex, displayMode = false) => {
    if (window.katex) katex.render(tex, el, { throwOnError: true, displayMode });
    else el.textContent = tex;
  };
  for (const [id, tex] of Object.entries(equations)) render(document.getElementById(id), tex, true);
  document.querySelectorAll('[data-math]').forEach(el => render(el, el.dataset.math));
  const kernels = {
    'upwind2-x-back': { title: '\\partial u/\\partial x\\quad(u\\geq0)', factor: '\\frac1{2h}', x: ['i-2', 'i-1', 'i'], y: ['j'], values: [[1, -4, 3]] },
    'upwind2-x-forward': { title: '\\partial u/\\partial x\\quad(u<0)', factor: '\\frac1{2h}', x: ['i', 'i+1', 'i+2'], y: ['j'], values: [[-3, 4, -1]] },
    'upwind2-y-back': { title: '\\partial u/\\partial y\\quad(\\bar v\\geq0)', factor: '\\frac1{2h}', x: ['i'], y: ['j', 'j-1', 'j-2'], values: [[3], [-4], [1]] },
    'upwind2-y-forward': { title: '\\partial u/\\partial y\\quad(\\bar v<0)', factor: '\\frac1{2h}', x: ['i'], y: ['j+2', 'j+1', 'j'], values: [[-1], [4], [-3]] },
    'upwind-x-back': { title: '\\partial u/\\partial x\\quad(u\\geq0)', factor: '\\frac1h', x: ['i-1', 'i', 'i+1'], y: ['j'], values: [[-1, 1, 0]] },
    'upwind-x-forward': { title: '\\partial u/\\partial x\\quad(u<0)', factor: '\\frac1h', x: ['i-1', 'i', 'i+1'], y: ['j'], values: [[0, -1, 1]] },
    'upwind-y-back': { title: '\\partial u/\\partial y\\quad(\\bar v\\geq0)', factor: '\\frac1h', x: ['i'], y: ['j+1', 'j', 'j-1'], values: [[0], [1], [-1]] },
    'upwind-y-forward': { title: '\\partial u/\\partial y\\quad(\\bar v<0)', factor: '\\frac1h', x: ['i'], y: ['j+1', 'j', 'j-1'], values: [[1], [-1], [0]] },
    'laplacian-u': { title: '\\partial^2 u/\\partial x^2+\\partial^2 u/\\partial y^2', factor: '\\frac1{h^2}', x: ['i-1', 'i', 'i+1'], y: ['j+1', 'j', 'j-1'], values: [[0, 1, 0], [1, -4, 1], [0, 1, 0]] },
    'laplacian-v': { title: '\\partial^2 v/\\partial x^2+\\partial^2 v/\\partial y^2', factor: '\\frac1{h^2}', x: ['i-1', 'i', 'i+1'], y: ['j+1', 'j', 'j-1'], values: [[0, 1, 0], [1, -4, 1], [0, 1, 0]] },
    'laplacian-p': { title: '\\partial^2 p/\\partial x^2+\\partial^2 p/\\partial y^2', factor: '\\frac1{h^2}', x: ['i-1', 'i', 'i+1'], y: ['j+1', 'j', 'j-1'], values: [[0, 1, 0], [1, -4, 1], [0, 1, 0]] }
  };
  const mathElement = (tag, tex) => {
    const el = document.createElement(tag); render(el, tex); return el;
  };
  document.querySelectorAll('[data-kernel]').forEach(figure => {
    const kernel = kernels[figure.dataset.kernel];
    figure.appendChild(mathElement('figcaption', kernel.title));
    const expression = document.createElement('div'); expression.className = 'kernel-expression';
    expression.appendChild(mathElement('span', kernel.factor));
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    head.appendChild(document.createElement('td'));
    kernel.x.forEach(x => { const th = mathElement('th', x); th.scope = 'col'; head.appendChild(th); });
    const body = table.createTBody();
    kernel.values.forEach((values, j) => {
      const row = body.insertRow(), th = mathElement('th', kernel.y[j]); th.scope = 'row'; row.appendChild(th);
      values.forEach((value, i) => {
        const td = mathElement('td', value > 0 ? '+' + value : String(value));
        td.className = value === 0 ? 'zero' : 'nonzero';
        if (kernel.x[i] === 'i' && kernel.y[j] === 'j') td.classList.add('center');
        row.appendChild(td);
      });
    });
    expression.appendChild(table); figure.appendChild(expression);
  });
})();
