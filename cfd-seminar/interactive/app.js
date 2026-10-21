'use strict';
const $ = id => document.getElementById(id);
const canvas = $('flow'), ctx = canvas.getContext('2d');
const field = document.createElement('canvas'), fctx = field.getContext('2d');
let frame = null, running = false, pending = 0, view = 'speed', worker, counter = 0;
let dtLimit = +$('dt-max').value;
const explanations = [
  '① 移流：速度の分布が、流れによって運ばれます。',
  '② 粘性：流速の違いをならし、壁と流体の間で運動を伝えます。静止壁は流れを遅くし、動く壁は流れを駆動します。',
  '③ 圧力補正：仮の速度に生じた流入・流出の不釣り合いを、圧力を使って取り除きます。'
];
const options = () => ({ case: $('case').value, advection: $('advection').checked, viscosity: $('viscosity').checked, pressure: $('pressure').checked, nu: +$('nu').value * 1e-6, dtMax: dtLimit, [$('case').value === 'channel' ? 'inflow' : 'lid']: +$('lid').value * 1e-3 });
const scientific = x => x < 1e-12 ? '≈ 0' : x.toExponential(2);
const scaleLabel = x => x === 0 ? '0' : Math.abs(x) < .01 ? x.toExponential(2) : Number(x.toPrecision(3)).toString();
function equation() {
  const expressions = { 'eq-time': '\\frac{\\partial \\mathbf{u}}{\\partial t}', 'eq-advection': '-(\\mathbf{u}\\cdot\\nabla)\\mathbf{u}', 'eq-viscosity': '+\\nu\\nabla^2\\mathbf{u}', 'eq-pressure': '-\\frac{1}{\\rho}\\nabla p', continuity: '\\nabla\\cdot\\mathbf{u}=0' };
  for (const [id, expression] of Object.entries(expressions)) {
    if (window.katex) katex.render(expression, $(id), { throwOnError: false });
    else $(id).textContent = expression;
  }
}
function controlState() {
  const o = options();
  document.querySelectorAll('.stage').forEach((el, i) => el.classList.toggle('enabled', [o.advection, o.viscosity, o.pressure][i]));
  $('nu').disabled = !o.viscosity;
  const channel = o.case === 'channel', speed = channel ? o.inflow : o.lid;
  $('nu-value').textContent = (o.nu*1e6).toFixed(1); $('lid-value').textContent = (speed*1000).toFixed(1);
  const count = +o.advection + +o.viscosity + +o.pressure;
  $('model-note').textContent = count === 3 ? '3つの作用がそろいました。非圧縮流れのフラクショナルステップ法です。' : !o.pressure ? '圧力補正なし：非圧縮条件を満たさない途中モデルです。' : '圧力補正は有効。移流・粘性の一部を省いたモデルです。';
  if (channel && o.advection && !o.viscosity && !o.pressure) $('model-note').textContent += ' 静止状態への一様流入では、前線が流入速度の半分の速さで進みます。';
  if (!channel && !o.viscosity) $('model-note').textContent += ' 粘性OFFでは、静止した内部へ上壁の運動は伝わりません。';
  $('model-note').classList.toggle('complete', count === 3);
  $('wall-label').textContent = channel ? `Poiseuille flow：流入 ${(speed*1000).toFixed(1)} mm/s →` : `Cavity flow：上壁 ${(speed*1000).toFixed(1)} mm/s →`;
  $('drive-name').textContent = channel ? '流入速度 (mm/s)' : '上壁の速度 (mm/s)';
  $('boundary-note').textContent = channel ? '左から一様に流入、右へ流出。上下の壁は静止しています。' : '上壁だけが右へ動く閉じた箱。他の3辺は静止壁です。';
  const n = +$('grid').value;
  $('grid-info').textContent = `${channel ? 2*n : n} × ${n} セル / Δx = Δy = ${scaleLabel(100/n)} mm`;
  $('reynolds').textContent = `Re = UH/ν = ${scaleLabel(speed * .1 / o.nu)} (H = 100 mm)${o.viscosity ? '' : ' / 粘性OFF'}`;
}
function pressureOutline() {
  const box = $('equation-system').getBoundingClientRect();
  const top = document.querySelector('.continuity-row').getBoundingClientRect();
  const bottom = document.querySelector('.equation-toggle.press').getBoundingClientRect();
  const left = top.left-box.left+1, right = bottom.right-box.left-1;
  const y = top.top-box.top+1, middle = top.bottom-box.top-1;
  const foot = bottom.bottom-box.top-1, inner = bottom.left-box.left+1;
  $('pressure-outline').setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  $('pressure-outline').querySelector('path').setAttribute('d', `M ${left} ${y} H ${right} V ${foot} H ${inner} V ${middle} H ${left} Z`);
}
function playState(value) {
  running = value;
  $('play-label').textContent = running ? '停止' : '再生';
  $('play-icon').hidden = running; $('pause-icon').hidden = !running;
  $('play').setAttribute('aria-label', running ? '計算を停止' : '計算を再生');
  $('run-state').textContent = running ? '計算中' : '停止中';
}
function send(type, extra = {}) { pending++; worker.postMessage({ type, request: ++counter, ...extra }); }
function schedule() {
  if (running && pending === 0 && !document.hidden) send('advance', { count: +$('rate').value });
}
function reset() {
  playState(false); $('error').hidden = true;
  send('reset', { n: +$('grid').value, options: options() });
}
function color(t, signed) {
  t = Math.max(0, Math.min(1, t));
  const stops = signed ? [[45, 107, 180], [223, 230, 234], [188, 61, 86]] : [[21, 39, 53], [23, 105, 121], [53, 180, 164], [237, 232, 174]];
  const a = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(a)), f = a - i;
  return stops[i].map((x, c) => Math.round(x * (1 - f) + stops[i + 1][c] * f));
}
function draw() {
  if (!frame) return;
  const { n, nx, u, v, p, div, options: o } = frame;
  canvas.width = 720 * nx/n; canvas.height = 720;
  canvas.classList.toggle('wide', nx !== n);
  const width = canvas.width, height = canvas.height, cell = height/n;
  field.width = nx; field.height = n;
  const pixels = fctx.createImageData(nx, n), signed = view !== 'speed';
  const referenceSpeed = o.case === 'channel' ? o.inflow : o.lid;
  let max = view === 'speed' ? referenceSpeed : view === 'pressure' ? Math.max(referenceSpeed**2, 1e-12) : Math.max(referenceSpeed/frame.ly, 1e-12);
  if (signed) for (const value of (view === 'pressure' ? p : div)) max = Math.max(max, Math.abs(value));
  for (let j = 0; j < n; j++) for (let i = 0; i < nx; i++) {
    const k = i + nx * j, pixel = (i + nx * (n - 1 - j)) * 4;
    const value = view === 'speed' ? Math.hypot(u[k], v[k]) : view === 'pressure' ? p[k] : div[k];
    const rgb = color(signed ? 0.5 + value / (2 * max) : max > 0 ? value / max : 0, signed);
    pixels.data.set([...rgb, 255], pixel);
  }
  fctx.putImageData(pixels, 0, 0); ctx.imageSmoothingEnabled = false; ctx.drawImage(field, 0, 0, width, height);
  ctx.strokeStyle = signed ? 'rgba(20,35,45,.24)' : 'rgba(230,242,248,.24)';
  ctx.lineWidth = 1; ctx.beginPath();
  for (let i = 1; i < nx; i++) { ctx.moveTo(i*cell,0); ctx.lineTo(i*cell,height); }
  for (let j = 1; j < n; j++) { ctx.moveTo(0,j*cell); ctx.lineTo(width,j*cell); }
  ctx.stroke();
  if ($('arrows').checked) {
    const spacing = Math.max(2, Math.round(n / 16));
    ctx.strokeStyle = signed ? 'rgba(20,35,45,.65)' : 'rgba(244,251,250,.72)'; ctx.lineWidth = 1.5;
    for (let j = 1; j < n; j += spacing) for (let i = 1; i < nx; i += spacing) {
      const k = i + nx * j, speed = Math.hypot(u[k], v[k]); if (speed < 1e-8) continue;
      const x = (i + .5)*cell, y = height - (j + .5)*cell, length = Math.min(cell*spacing*.8, speed / Math.max(referenceSpeed, 1e-6) * cell*spacing*.7), dx = u[k] / speed, dy = -v[k] / speed;
      if (length < .5) continue;
      const head = Math.min(4, length * .35), wing = head * .6;
      const ex = x + dx * length / 2, ey = y + dy * length / 2;
      ctx.beginPath(); ctx.moveTo(x - dx * length / 2, y - dy * length / 2); ctx.lineTo(ex, ey);
      ctx.lineTo(ex - head * dx + wing * dy, ey - head * dy - wing * dx); ctx.moveTo(ex, ey); ctx.lineTo(ex - head * dx - wing * dy, ey - head * dy + wing * dx); ctx.stroke();
    }
  }
  const names = { speed: '速さ (mm/s)', pressure: '圧力 (Pa)', divergence: '発散 (s⁻¹)' };
  const displayMax = max * (view === 'speed' ? 1000 : view === 'pressure' ? frame.rho : 1);
  $('legend-name').textContent = names[view]; $('scale-max').textContent = scaleLabel(displayMax);
  $('domain-label').textContent = `${scaleLabel(frame.lx*1000)} × ${scaleLabel(frame.ly*1000)} mm · ${nx} × ${n} セル · 格子幅 ${scaleLabel(frame.h*1000)} mm`;
  $('colorbar').previousElementSibling.textContent = signed ? scaleLabel(-displayMax) : '0';
  $('colorbar').style.background = signed ? 'linear-gradient(90deg,#2d6bb4,#dfe6ea,#bc3d56)' : '';
}
function receive({ data }) {
  pending = Math.max(0, pending - 1);
  if (data.error) { playState(false); $('error').hidden = false; $('error').textContent = data.error; return; }
  frame = data;
  $('run-state').textContent = running ? '計算中' : '停止中';
  $('play').disabled = false; $('step').disabled = false; $('stage-step').disabled = false;
  $('time').textContent = data.time.toFixed(3) + ' s' + (data.phase ? '（途中）' : '');
  $('dt').textContent = data.dt > 0 ? Number(data.dt.toPrecision(6)).toString() + ' s' : '— s';
  $('dt').title = data.dt > 0 ? `Δt = ${data.dt.toPrecision(10)} s / 安定性の指標 ${(data.cfl+data.diffusionNumber).toFixed(3)} ≤ 0.35` : '';
  $('energy').textContent = scientific(data.stats.energy); $('divergence').textContent = scientific(data.stats.divergence);
  $('projection').textContent = data.options.pressure && data.projectionCount ? `${scientific(data.before)} → ${scientific(data.after)}` : '未実行';
  document.querySelectorAll('.stage').forEach((el, i) => el.classList.toggle('current', i === (data.phase + 2) % 3 && data.dt > 0));
  if (data.dt > 0) $('stage-description').textContent = data.stage + '完了。' + explanations[(data.phase + 2) % 3];
  else $('stage-description').textContent = explanations[0];
  draw();
  // Leave time for UI and paint; there is at most one automatic batch in flight.
  if (running) setTimeout(schedule, 25);
}
equation(); controlState(); $('stage-step').disabled = true;
new ResizeObserver(pressureOutline).observe($('equation-system'));
document.fonts.ready.then(pressureOutline);
document.addEventListener('pointerdown', () => $('equation-system').classList.remove('keyboard-focus'), true);
document.addEventListener('keydown', e => { if (e.key === 'Tab' || e.key === ' ') $('equation-system').classList.add('keyboard-focus'); });
try {
  worker = new Worker('worker.js?v=20261021-advection'); worker.onmessage = receive;
  worker.onerror = () => { playState(false); $('error').hidden = false; $('error').textContent = '計算を起動できませんでした。公開URLから開き直してください。'; };
  send('snapshot');
} catch (error) { $('error').hidden = false; $('error').textContent = 'このブラウザでは計算を起動できません。公開URLを対応ブラウザで開いてください。'; }
$('play').onclick = () => { playState(!running); schedule(); };
$('reset').onclick = () => { if (worker) reset(); };
$('step').onclick = () => { playState(false); send('advance'); };
$('stage-step').onclick = () => { playState(false); send('stage'); };
for (const id of ['advection', 'viscosity', 'pressure', 'nu', 'lid']) $(id).addEventListener('input', () => {
  controlState(); if (worker) send('configure', { options: options() });
  const stage = ['advection', 'viscosity', 'pressure'].indexOf(id);
  if (stage >= 0) $('stage-description').textContent = explanations[stage];
});
$('grid').onchange = () => { controlState(); if (worker) reset(); };
$('dt-max').onchange = () => {
  if (!$('dt-max').value || !$('dt-max').reportValidity()) return;
  dtLimit = +$('dt-max').value;
  controlState(); if (worker) send('configure', { options: options() });
};
$('case').onchange = () => {
  const channel = $('case').value === 'channel';
  $('lid').min = channel ? '0.1' : '0'; $('lid').max = '10';
  $('lid').step = '0.1'; $('lid').value = '1';
  controlState(); if (worker) reset();
};
$('arrows').onchange = draw;
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => {
  view = button.dataset.view;
  document.querySelectorAll('[data-view]').forEach(el => el.setAttribute('aria-pressed', String(el === button))); draw();
});
document.querySelectorAll('[data-stage]').forEach(button => button.onclick = () => { $('stage-description').textContent = explanations[+button.dataset.stage]; });
$('fullscreen').onclick = async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('canvas-wrap').requestFullscreen(); }
  catch { $('canvas-wrap').scrollIntoView({ block: 'center' }); }
};
document.addEventListener('visibilitychange', () => { if (document.hidden) playState(false); });
window.addEventListener('pagehide', () => { if (worker) worker.terminate(); });
