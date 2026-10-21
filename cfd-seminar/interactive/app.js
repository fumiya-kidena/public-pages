'use strict';
const $ = id => document.getElementById(id);
const canvas = $('flow'), ctx = canvas.getContext('2d');
const field = document.createElement('canvas'), fctx = field.getContext('2d');
let frame = null, running = false, pending = 0, view = 'speed', worker, counter = 0;
let axisLayoutKey = '';
let dtLimit = +$('dt-max').value;
const boundarySpeed = .001;
const domainHeight = .01;
const explanations = [
  '① 移流：速度の分布が、流れによって運ばれます。',
  '② 粘性：流速の違いをならし、壁と流体の間で運動を伝えます。静止壁は流れを遅くし、動く壁は流れを駆動します。',
  '③ 圧力補正：仮の速度に生じた流入・流出の不釣り合いを、圧力を使って取り除きます。'
];
const options = () => ({ case: $('case').value, advection: $('advection').checked, viscosity: $('viscosity').checked, pressure: $('pressure').checked, nu: +$('nu').value * 1e-6, dtMax: dtLimit, inflow: boundarySpeed, lid: boundarySpeed });
const scientific = x => x < 1e-12 ? '≈ 0' : x.toExponential(2);
const scaleLabel = x => x === 0 ? '0' : Math.abs(x) < .01 ? x.toExponential(2) : Number(x.toPrecision(3)).toString();
function equation() {
  const expressions = { 'eq-time': '\\frac{\\partial \\mathbf{u}}{\\partial t}', 'eq-advection': '+(\\mathbf{u}\\cdot\\nabla)\\mathbf{u}', 'eq-viscosity': '+\\nu\\nabla^2\\mathbf{u}', 'eq-pressure': '-\\frac{1}{\\rho}\\nabla p', continuity: '\\nabla\\cdot\\mathbf{u}=0', 'boundary-pressure': 'p=p_0' };
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
  $('nu-value').textContent = (o.nu*1e6).toFixed(1);
  const count = +o.advection + +o.viscosity + +o.pressure;
  $('model-note').textContent = count === 3 ? '3つの作用がそろいました。非圧縮流れのフラクショナルステップ法です。' : !o.pressure ? '圧力補正なし：非圧縮条件を満たさない途中モデルです。' : '圧力補正は有効。移流・粘性の一部を省いたモデルです。';
  if (channel && o.advection && !o.viscosity && !o.pressure) $('model-note').textContent += ' この差分式では、内部速度ゼロから移流だけでは流入の変化が伝わりません。';
  if (!channel && !o.viscosity) $('model-note').textContent += ' 粘性OFFでは、静止した内部へ上壁の運動は伝わりません。';
  $('model-note').classList.toggle('complete', count === 3);
  $('wall-label').textContent = channel ? 'Poiseuille flow' : 'Cavity flow';
  $('flow-domain').dataset.case = o.case;
  $('boundary-top').textContent = channel ? '静止壁  0 mm/s' : `上壁 →  ${(speed*1000).toFixed(1)} mm/s`;
  $('boundary-left-kind').textContent = channel ? '流入' : '静止壁';
  $('boundary-right-kind').textContent = channel ? '自由流出' : '静止壁';
  $('boundary-left-speed').textContent = channel ? `${(speed*1000).toFixed(1)} mm/s` : '0 mm/s';
  $('boundary-right-speed').textContent = '0 mm/s';
  $('boundary-right-speed').hidden = channel;
  $('boundary-pressure').hidden = !channel;
  $('boundary-left-arrow').hidden = !channel;
  $('boundary-right-arrow').hidden = !channel;
  $('boundary-note').textContent = channel ? '左から一様に流入、右は自由流出・圧力指定。上下の壁は静止しています。' : '上壁だけが右へ動く閉じた箱。他の3辺は静止壁です。';
  const n = +$('grid').value;
  $('grid-info').textContent = `${channel ? 2*n : n} × ${n} セル / Δx = Δy = ${scaleLabel(domainHeight*1000/n)} mm`;
  $('reynolds').textContent = `Re = UH/ν = ${scaleLabel(speed * domainHeight / o.nu)} (H = ${domainHeight*1000} mm)${o.viscosity ? '' : ' / 粘性OFF'}`;
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
  if (!value && running && worker) worker.postMessage({ type: 'stop' });
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
  const stops = signed ? [[45, 107, 180], [255, 255, 255], [188, 61, 86]] : [[255, 255, 255], [186, 223, 235], [42, 157, 164], [234, 166, 68]];
  const a = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(a)), f = a - i;
  return stops[i].map((x, c) => Math.round(x * (1 - f) + stops[i + 1][c] * f));
}
function spatialAxes() {
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return;
  const key = [frame.lx, frame.ly, Math.round(width), Math.round(height)].join('/');
  if (key === axisLayoutKey) return;
  axisLayoutKey = key;
  for (const [axis, length, pixels, spacing] of [['x', frame.lx*1000, width, 60], ['y', frame.ly*1000, height, 48]]) {
    const rough = length / Math.max(1, Math.floor(pixels / spacing));
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const step = [1, 2, 5, 10].find(value => value*magnitude >= rough) * magnitude;
    const ticks = document.createDocumentFragment();
    for (let i = 0; i <= Math.floor(length/step + 1e-8); i++) {
      const value = Number((i*step).toPrecision(8));
      const tick = document.createElement('span');
      tick.className = 'axis-tick'; tick.textContent = value;
      tick.style[axis === 'x' ? 'left' : 'bottom'] = `${value/length*100}%`;
      ticks.appendChild(tick);
    }
    $(`axis-${axis}`).querySelector('.axis-ticks').replaceChildren(ticks);
  }
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
  const speedMax = referenceSpeed * (o.case === 'channel' ? 1.5 : 1);
  let max = view === 'speed' ? speedMax : view === 'pressure' ? Math.max(referenceSpeed**2, 1e-12) : Math.max(referenceSpeed/frame.ly, 1e-12);
  if (signed) for (const value of (view === 'pressure' ? p : div)) max = Math.max(max, Math.abs(value));
  for (let j = 0; j < n; j++) for (let i = 0; i < nx; i++) {
    const k = i + nx * j, pixel = (i + nx * (n - 1 - j)) * 4;
    const value = view === 'speed' ? Math.hypot(u[k], v[k]) : view === 'pressure' ? p[k] : div[k];
    const rgb = color(signed ? 0.5 + value / (2 * max) : max > 0 ? value / max : 0, signed);
    pixels.data.set([...rgb, 255], pixel);
  }
  fctx.putImageData(pixels, 0, 0); ctx.imageSmoothingEnabled = false; ctx.drawImage(field, 0, 0, width, height);
  ctx.strokeStyle = 'rgba(32,42,48,.18)';
  ctx.lineWidth = 1; ctx.beginPath();
  for (let i = 1; i < nx; i++) { ctx.moveTo(i*cell,0); ctx.lineTo(i*cell,height); }
  for (let j = 1; j < n; j++) { ctx.moveTo(0,j*cell); ctx.lineTo(width,j*cell); }
  ctx.stroke();
  if ($('arrows').checked) {
    const screenCell = Math.max(1, canvas.getBoundingClientRect().height) / n;
    const spacing = Math.max(1, Math.round(n / 24), Math.ceil(9 / screenCell));
    const pixelScale = width / Math.max(1, canvas.getBoundingClientRect().width);
    const shafts = new Path2D(), heads = new Path2D();
    for (let j = 1; j < n; j += spacing) for (let i = 1; i < nx; i += spacing) {
      const k = i + nx * j, speed = Math.hypot(u[k], v[k]); if (speed < Math.max(1e-8, referenceSpeed*.01)) continue;
      const x = (i + .5)*cell, y = height - (j + .5)*cell, length = Math.min(cell*spacing*.8, Math.max(4*pixelScale, speed / Math.max(referenceSpeed, 1e-6) * cell*spacing*.65)), dx = u[k] / speed, dy = -v[k] / speed;
      const head = Math.min(4*pixelScale, length * .4), wing = head * .55;
      const ex = x + dx * length / 2, ey = y + dy * length / 2;
      shafts.moveTo(x - dx * length / 2, y - dy * length / 2); shafts.lineTo(ex, ey);
      heads.moveTo(ex, ey); heads.lineTo(ex - head * dx + wing * dy, ey - head * dy - wing * dx);
      heads.lineTo(ex - head * dx - wing * dy, ey - head * dy + wing * dx); heads.closePath();
    }
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 2.4*pixelScale;
    ctx.stroke(shafts); ctx.stroke(heads);
    ctx.strokeStyle = '#202a30'; ctx.fillStyle = '#202a30'; ctx.lineWidth = 1.1*pixelScale;
    ctx.stroke(shafts); ctx.fill(heads);
  }
  const names = { speed: '速さ (mm/s)', pressure: o.case === 'channel' ? '圧力差 (Pa)' : '圧力 (Pa)', divergence: '発散 (s⁻¹)' };
  const displayMax = max * (view === 'speed' ? 1000 : view === 'pressure' ? frame.rho : 1);
  $('legend-name').textContent = names[view]; $('scale-max').textContent = scaleLabel(displayMax);
  $('domain-label').textContent = `${scaleLabel(frame.lx*1000)} × ${scaleLabel(frame.ly*1000)} mm · ${nx} × ${n} セル · 格子幅 ${scaleLabel(frame.h*1000)} mm`;
  $('colorbar').previousElementSibling.textContent = signed ? scaleLabel(-displayMax) : '0';
  $('colorbar').style.background = signed ? 'linear-gradient(90deg,#2d6bb4,#fff,#bc3d56)' : '';
  $('speed-scale-note').hidden = signed || o.case !== 'channel';
  $('speed-scale-note').textContent = `定常・十分発達した流れの理論最大値 ${(speedMax*1000).toFixed(1)} mm/s`;
  spatialAxes();
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
  FlowProfile.update(data);
  // Leave time for UI and paint; there is at most one automatic batch in flight.
  if (running) setTimeout(schedule, 25);
}
equation(); controlState(); $('stage-step').disabled = true;
new ResizeObserver(pressureOutline).observe($('equation-system'));
document.fonts.ready.then(pressureOutline);
document.addEventListener('pointerdown', () => $('equation-system').classList.remove('keyboard-focus'), true);
document.addEventListener('keydown', e => { if (e.key === 'Tab' || e.key === ' ') $('equation-system').classList.add('keyboard-focus'); });
try {
  worker = new Worker('worker.js?v=20261022-white-10mm'); worker.onmessage = receive;
  worker.onerror = () => { playState(false); $('error').hidden = false; $('error').textContent = '計算を起動できませんでした。公開URLから開き直してください。'; };
  send('snapshot');
} catch (error) { $('error').hidden = false; $('error').textContent = 'このブラウザでは計算を起動できません。公開URLを対応ブラウザで開いてください。'; }
$('play').onclick = () => { playState(!running); schedule(); };
$('reset').onclick = () => { if (worker) reset(); };
$('step').onclick = () => { playState(false); send('advance'); };
$('stage-step').onclick = () => { playState(false); send('stage'); };
for (const id of ['advection', 'viscosity', 'pressure', 'nu']) $(id).addEventListener('input', () => {
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
  controlState(); if (worker) reset();
};
$('arrows').onchange = draw;
new ResizeObserver(() => { draw(); FlowProfile.resize(); }).observe(canvas);
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
