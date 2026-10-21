'use strict';
const $ = id => document.getElementById(id);
const canvas = $('flow'), ctx = canvas.getContext('2d');
const field = document.createElement('canvas'), fctx = field.getContext('2d');
let frame = null, running = false, pending = 0, view = 'speed', worker, counter = 0;
const explanations = [
  '移流：速度の分布が、流れによって運ばれます。一様な流れや静止状態では、この項だけでは変化しません。',
  '粘性：流速の違いをならし、壁と流体の間で運動を伝えます。静止壁は流れを遅くし、動く壁は流れを駆動します。',
  '圧力補正：仮の速度に生じた流入・流出の不釣り合いを、圧力を使って取り除きます。'
];
const options = () => ({ case: $('case').value, advection: $('advection').checked, viscosity: $('viscosity').checked, pressure: $('pressure').checked, nu: +$('nu').value, [$('case').value === 'channel' ? 'inflow' : 'lid']: +$('lid').value });
const scientific = x => x < 1e-12 ? '≈ 0' : x.toExponential(2);
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
  $('nu-value').textContent = o.nu.toFixed(3); $('lid-value').textContent = speed.toFixed(2);
  const count = +o.advection + +o.viscosity + +o.pressure;
  $('model-note').textContent = count === 3 ? '3つの作用がそろいました。非圧縮流れのフラクショナルステップ法です。' : !o.pressure ? '圧力補正なし：非圧縮条件を満たさない途中モデルです。' : '圧力補正は有効。移流・粘性の一部を省いたモデルです。';
  $('model-note').classList.toggle('complete', count === 3);
  $('wall-label').textContent = channel ? `ポワズイユ流：左から右へ ${speed.toFixed(2)} →` : `キャビティ流：上壁 ${speed.toFixed(2)} →`;
  $('drive-name').textContent = channel ? '流入速度' : '上壁の速度';
  $('boundary-note').textContent = channel ? '左から一様に流入、右へ流出。上下の壁は静止しています。' : '上壁だけが右へ動く閉じた箱。他の3辺は静止壁です。';
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
  const { n, u, v, p, div } = frame, size = canvas.width;
  field.width = field.height = n;
  const pixels = fctx.createImageData(n, n), signed = view !== 'speed', max = view === 'speed' ? 0.5 : view === 'pressure' ? 0.2 : 0.5;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = i + n * j, pixel = (i + n * (n - 1 - j)) * 4;
    const value = view === 'speed' ? Math.hypot(u[k], v[k]) : view === 'pressure' ? p[k] : div[k];
    const rgb = color(signed ? 0.5 + value / (2 * max) : value / max, signed);
    pixels.data.set([...rgb, 255], pixel);
  }
  fctx.putImageData(pixels, 0, 0); ctx.imageSmoothingEnabled = true; ctx.drawImage(field, 0, 0, size, size);
  if ($('arrows').checked) {
    const spacing = Math.max(2, Math.round(n / 16));
    ctx.strokeStyle = signed ? 'rgba(20,35,45,.65)' : 'rgba(244,251,250,.72)'; ctx.lineWidth = 1.5;
    for (let j = 1; j < n; j += spacing) for (let i = 1; i < n; i += spacing) {
      const k = i + n * j, speed = Math.hypot(u[k], v[k]); if (speed < 0.003) continue;
      const x = (i + .5) / n * size, y = size - (j + .5) / n * size, length = Math.min(size * .035, speed * size * .10), dx = u[k] / speed, dy = -v[k] / speed;
      const ex = x + dx * length / 2, ey = y + dy * length / 2;
      ctx.beginPath(); ctx.moveTo(x - dx * length / 2, y - dy * length / 2); ctx.lineTo(ex, ey);
      ctx.lineTo(ex - 4 * dx + 3 * dy, ey - 4 * dy - 3 * dx); ctx.moveTo(ex, ey); ctx.lineTo(ex - 4 * dx - 3 * dy, ey - 4 * dy + 3 * dx); ctx.stroke();
    }
  }
  const names = { speed: '速さ', pressure: '圧力 / 密度', divergence: '発散' };
  $('legend-name').textContent = names[view]; $('scale-max').textContent = max.toFixed(2);
  $('colorbar').previousElementSibling.textContent = signed ? (-max).toFixed(2) : '0';
  $('colorbar').style.background = signed ? 'linear-gradient(90deg,#2d6bb4,#dfe6ea,#bc3d56)' : '';
}
function receive({ data }) {
  pending = Math.max(0, pending - 1);
  if (data.error) { playState(false); $('error').hidden = false; $('error').textContent = data.error; return; }
  frame = data;
  $('run-state').textContent = running ? '計算中' : '停止中';
  $('play').disabled = false; $('step').disabled = false; $('stage-step').disabled = false;
  $('time').textContent = data.time.toFixed(3) + (data.phase ? '（途中）' : '');
  $('energy').textContent = data.stats.energy.toFixed(5); $('divergence').textContent = scientific(data.stats.divergence);
  $('projection').textContent = data.options.pressure && data.iterations ? `${scientific(data.before)} → ${scientific(data.after)}` : '未実行';
  document.querySelectorAll('.stage').forEach((el, i) => el.classList.toggle('current', i === (data.phase + 2) % 3 && data.dt > 0));
  if (data.dt > 0) $('stage-description').textContent = data.stage + '完了。' + explanations[(data.phase + 2) % 3];
  else $('stage-description').textContent = explanations[0];
  draw();
  // Leave time for UI and paint; there is at most one automatic batch in flight.
  if (running) setTimeout(schedule, 25);
}
equation(); controlState(); $('stage-step').disabled = true;
try {
  worker = new Worker('worker.js'); worker.onmessage = receive;
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
$('grid').onchange = () => { if (worker) reset(); };
$('case').onchange = () => {
  const channel = $('case').value === 'channel';
  $('lid').min = channel ? '0.05' : '0'; $('lid').max = channel ? '0.5' : '1';
  $('lid').step = channel ? '0.05' : '0.1'; $('lid').value = channel ? '0.1' : '1';
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
