'use strict';
const $ = id => document.getElementById(id);
const canvas = $('flow'), ctx = canvas.getContext('2d');
const field = document.createElement('canvas'), fctx = field.getContext('2d');
let frame = null, running = false, pending = 0, view = 'speed', worker, counter = 0;
let axisLayoutKey = '';
let cflEditing = false;
const inflowSpeed = .01, lidSpeed = .04;
const caseGrid = { channel: 32, cavity: 32, pool: 32 };
const stageNames = ['移流', '粘性', '重力', '圧力補正'];
const explanations = [
  '① 移流：速度を運ぶ',
  '② 粘性：速度差をならす',
  '③ 重力：下向きに加速する',
  '④ 圧力補正：流入・流出を釣り合わせる'
];
const options = () => ({ case: $('case').value, advection: $('advection').checked, advectionScheme: $('scheme-godunov').checked ? 'godunov' : 'upwind', viscosity: $('viscosity').checked, gravity: $('gravity').checked, pressure: $('pressure').checked, nu: 1e-6, inflow: inflowSpeed, lid: lidSpeed, cfl: +$('cfl-target').value });
const scientific = x => x < 1e-12 ? '≈ 0' : x.toExponential(2);
const scaleLabel = x => x === 0 ? '0' : Math.abs(x) < .01 ? x.toExponential(2) : Number(x.toPrecision(3)).toString();
function equation() {
  const expressions = { 'eq-time': '\\frac{\\partial \\mathbf{u}}{\\partial t}', 'eq-advection': '+(\\mathbf{u}\\cdot\\nabla)\\mathbf{u}', 'eq-viscosity': '+\\nu\\nabla^2\\mathbf{u}', 'eq-pressure': '-\\frac{1}{\\rho}\\nabla p', 'eq-gravity': '+\\mathbf{g}', continuity: '\\nabla\\cdot\\mathbf{u}=0', 'boundary-pressure': 'p=p_0' };
  for (const [id, expression] of Object.entries(expressions)) {
    if (window.katex) katex.render(expression, $(id), { throwOnError: false });
    else $(id).textContent = expression;
  }
}
function controlState() {
  const o = options();
  document.querySelectorAll('.stage').forEach((el, i) => el.classList.toggle('enabled', [o.advection, o.viscosity, o.gravity, o.pressure][i]));
  $('advection-schemes').disabled = !o.advection;
  document.querySelectorAll('[data-advection-scheme]').forEach(el => { el.hidden = el.dataset.advectionScheme !== o.advectionScheme; });
  $('advection-method').textContent = o.advectionScheme === 'godunov' ? '1次Godunov' : '1次風上差分';
  const channel = o.case === 'channel', pool = o.case === 'pool', speed = channel ? o.inflow : o.lid;
  const domainHeight = channel ? .004 : .01;
  const count = +o.advection + +o.viscosity + +o.pressure;
  $('model-note').textContent = count === 3 ? '全項ON' : !o.pressure ? '圧力補正OFF · 非圧縮条件なし' : '一部の項がOFF';
  if (!o.gravity && ((channel && o.advection && o.advectionScheme === 'upwind' && !o.viscosity && !o.pressure) || (!channel && !o.viscosity))) $('model-note').textContent += ' / ゼロ初期場では内部静止';
  if (pool) $('model-note').textContent = '水面固定 · ' + (!o.pressure ? '圧力補正OFF' : !o.gravity ? '重力OFF' : '静水圧');
  $('model-note').classList.toggle('complete', pool ? o.gravity && o.pressure : count === 3);
  $('wall-label').textContent = channel ? 'Poiseuille flow' : pool ? 'Hydrostatic pool' : 'Cavity flow';
  $('flow-domain').dataset.case = o.case;
  $('boundary-top').textContent = channel ? '静止壁  0 mm/s' : pool ? '水面（固定） ' : `上壁 →  ${(speed*1000).toFixed(1)} mm/s`;
  $('surface-pressure').hidden = !pool;
  $('boundary-bottom').textContent = pool ? '壁面：滑りなし' + (o.gravity ? ' / g ↓' : '') : '静止壁 0 mm/s';
  $('gravity-value').hidden = !pool && !o.gravity;
  $('boundary-left-kind').textContent = channel ? '流入' : '静止壁';
  $('boundary-right-kind').textContent = channel ? '自由流出' : '静止壁';
  $('boundary-left-speed').textContent = channel ? `${(speed*1000).toFixed(1)} mm/s` : '0 mm/s';
  $('boundary-right-speed').textContent = '0 mm/s';
  $('boundary-right-speed').hidden = channel;
  $('boundary-pressure').hidden = !channel;
  $('boundary-left-arrow').hidden = !channel;
  $('boundary-right-arrow').hidden = !channel;
  const n = +$('grid').value;
  for (const item of $('grid').options) item.textContent = `${item.value}分割 · ${+item.value === 32 ? '標準' : (+item.value / 32) + '倍'}`;
  $('grid-info').textContent = `${(channel ? 5 : pool ? 2 : 1)*n} × ${n} セル / Δx = Δy = ${scaleLabel(domainHeight*1000/n)} mm`;
  $('reynolds').textContent = pool ? '最大水深 10 mm' : `Re = UH/ν = ${scaleLabel(speed * domainHeight / o.nu)} (H = ${domainHeight*1000} mm)${o.viscosity ? '' : ' / 粘性OFF'}`;
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
  $('axis-y').style.height = height + 'px';
  document.querySelector('.profile-sections').style.height = height + 'px';
  const key = [frame.lx, frame.ly, Math.round(width), Math.round(height)].join('/');
  if (key === axisLayoutKey) return;
  axisLayoutKey = key;
  for (const [axis, length, pixels, spacing] of [['x', frame.lx*1000, width, 60], ['y', frame.ly*1000, height, 48]]) {
    const rough = length / Math.max(1, Math.floor(pixels / spacing));
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const step = Math.min(length, [1, 2, 5, 10].find(value => value*magnitude >= rough) * magnitude);
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
  const { n, nx, u, v, p, div, fluid, options: o } = frame;
  const pool = o.case === 'pool';
  canvas.width = 720 * nx/n; canvas.height = 720;
  canvas.classList.toggle('wide', nx !== n);
  canvas.style.aspectRatio = String(nx/n);
  $('section-u').style.left = `${100*(pool ? frame.pressureProfiles[0].x : frame.profileX)/frame.lx}%`;
  $('section-u').querySelector('span').textContent = pool ? 'p A' : 'u';
  $('section-p').hidden = !pool;
  for (const [index, id] of [[0,'section-u'],[1,'section-p']]) {
    const section = $(id), segments = [];
    section.classList.toggle('pool-section', pool);
    if (pool) {
      const profile = frame.pressureProfiles[index];
      section.style.left = `${100*profile.x/frame.lx}%`;
      for (let j = 1; j <= n; j++) {
        if (!Number.isFinite(profile.values[j])) continue;
        const first = j;
        while (j < n && Number.isFinite(profile.values[j+1])) j++;
        const segment = document.createElement('i');
        segment.className = 'section-segment';
        segment.style.bottom = `${100*(first-1)/n}%`;
        segment.style.height = `${100*(j-first+1)/n}%`;
        segments.push(segment);
      }
    }
    section.replaceChildren(section.querySelector('span'), ...segments);
  }
  $('section-v').style.top = `${100*(1-frame.profileY/frame.ly)}%`;
  $('section-v').hidden = o.case !== 'cavity';
  const width = canvas.width, height = canvas.height, cell = height/n;
  field.width = nx; field.height = n;
  const pixels = fctx.createImageData(nx, n), signed = view === 'divergence' || (view === 'pressure' && !pool);
  const referenceSpeed = o.case === 'channel' ? o.inflow : pool ? .01 : o.lid;
  const speedMax = referenceSpeed * (o.case === 'channel' ? 1.5 : 1);
  let max = view === 'speed' ? speedMax : view === 'pressure' ? (pool ? frame.gravityAcceleration*frame.ly : Math.max(referenceSpeed**2, 1e-12)) : Math.max(referenceSpeed/frame.ly, 1e-12);
  if (signed) for (const value of (view === 'pressure' ? p : div)) max = Math.max(max, Math.abs(value));
  for (let j = 0; j < n; j++) for (let i = 0; i < nx; i++) {
    const k = i + nx * j, pixel = (i + nx * (n - 1 - j)) * 4;
    const value = view === 'speed' ? Math.hypot(u[k], v[k]) : view === 'pressure' ? p[k] : div[k];
    const rgb = fluid[k] ? color(signed ? 0.5 + value / (2 * max) : max > 0 ? value / max : 0, signed) : [216,222,226];
    pixels.data.set([...rgb, 255], pixel);
  }
  fctx.putImageData(pixels, 0, 0); ctx.imageSmoothingEnabled = false; ctx.drawImage(field, 0, 0, width, height);
  ctx.strokeStyle = 'rgba(32,42,48,.18)';
  ctx.lineWidth = 1; ctx.beginPath();
  if (pool) {
    for (let j = 0; j < n; j++) for (let i = 0; i < nx; i++) if (fluid[i+nx*j]) {
      const x = i*cell, y = height-(j+1)*cell;
      ctx.rect(x,y,cell,cell);
    }
  } else {
    for (let i = 1; i < nx; i++) { ctx.moveTo(i*cell,0); ctx.lineTo(i*cell,height); }
    for (let j = 1; j < n; j++) { ctx.moveTo(0,j*cell); ctx.lineTo(width,j*cell); }
  }
  ctx.stroke();
  if (pool) {
    ctx.strokeStyle = '#56666e'; ctx.lineWidth = 2*width/Math.max(1,canvas.getBoundingClientRect().width); ctx.beginPath();
    for (let j = 0; j < n; j++) for (let i = 0; i < nx; i++) if (fluid[i+nx*j]) {
      const k=i+nx*j, x=i*cell, y=height-(j+1)*cell;
      if (i===0 || !fluid[k-1]) { ctx.moveTo(x,y); ctx.lineTo(x,y+cell); }
      if (i===nx-1 || !fluid[k+1]) { ctx.moveTo(x+cell,y); ctx.lineTo(x+cell,y+cell); }
      if (j===0 || !fluid[k-nx]) { ctx.moveTo(x,y+cell); ctx.lineTo(x+cell,y+cell); }
      if (j<n-1 && !fluid[k+nx]) { ctx.moveTo(x,y); ctx.lineTo(x+cell,y); }
    }
    ctx.stroke(); ctx.strokeStyle='#326db4'; ctx.beginPath();
    for (let i = 0; i < nx; i++) if (fluid[i+nx*(n-1)]) {
      ctx.moveTo(i*cell,1); ctx.lineTo((i+1)*cell,1);
    }
    ctx.stroke();
  }
  if ($('arrows').checked) {
    const screenCell = Math.max(1, canvas.getBoundingClientRect().height) / n;
    const spacing = Math.max(1, Math.round(n / 24), Math.ceil(9 / screenCell));
    const pixelScale = width / Math.max(1, canvas.getBoundingClientRect().width);
    const shafts = new Path2D(), heads = new Path2D();
    for (let j = 1; j < n; j += spacing) for (let i = 1; i < nx; i += spacing) {
      const k = i + nx * j, speed = Math.hypot(u[k], v[k]); if (!fluid[k] || speed < Math.max(1e-8, referenceSpeed*.01)) continue;
      const x = (i + .5)*cell, y = height - (j + .5)*cell, length = Math.min(cell*spacing*1.05, Math.max(5*pixelScale, speed / Math.max(referenceSpeed, 1e-6) * cell*spacing*.9)), dx = u[k] / speed, dy = -v[k] / speed;
      const head = Math.min(4.5*pixelScale, length * .4), wing = head * .55;
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
  const names = { speed: '速さ (mm/s)', pressure: o.case !== 'cavity' ? '圧力差 (Pa)' : '圧力 (Pa)', divergence: '発散 (s⁻¹)' };
  const displayMax = max * (view === 'speed' ? 1000 : view === 'pressure' ? frame.rho : 1);
  $('legend-name').textContent = names[view]; $('scale-max').textContent = scaleLabel(displayMax);
  $('domain-label').textContent = `${scaleLabel(frame.lx*1000)} × ${scaleLabel(frame.ly*1000)} mm · ${nx} × ${n} セル · 格子幅 ${scaleLabel(frame.h*1000)} mm`;
  $('colorbar').previousElementSibling.textContent = signed ? scaleLabel(-displayMax) : '0';
  $('colorbar').style.background = signed ? 'linear-gradient(90deg,#2d6bb4,#fff,#bc3d56)' : '';
  $('speed-scale-note').hidden = signed || o.case !== 'channel';
  $('speed-scale-note').textContent = `理論最大 ${(speedMax*1000).toFixed(1)} mm/s`;
  spatialAxes();
}
function receive({ data }) {
  pending = Math.max(0, pending - 1);
  if (data.error) { playState(false); $('error').hidden = false; $('error').textContent = data.error; return; }
  frame = data;
  $('run-state').textContent = running ? '計算中' : '停止中';
  $('play').disabled = false; $('step').disabled = false; $('stage-step').disabled = false;
  const timeDigits = Math.max(3, 1 - Math.floor(Math.log10(data.fixedDt)));
  $('time').textContent = data.time.toFixed(timeDigits) + ' s' + (data.phase ? '（途中）' : '');
  $('dt').textContent = Number(data.fixedDt.toPrecision(6)) + ' s';
  $('dt').title = `Δt = ${data.fixedDt} s。CFLと格子幅から設定。移流・粘性の両方で制限`;
  if (pending === 0 && !cflEditing) {
    $('cfl-target').disabled = false;
    $('cfl-target').max = data.cflLimit;
    $('cfl-target').value = data.options.cfl;
    $('cfl-value').textContent = data.options.cfl.toFixed(3);
    $('cfl-max').textContent = `上限 ${data.cflLimit.toFixed(3)}`;
  }
  const pool = data.options.case === 'pool';
  const speed = data.referenceSpeed;
  $('cfl').textContent = `CFL（${pool ? '基準速度' : '境界速度'}）= ${(speed * data.fixedDt / data.h).toFixed(4)}`;
  $('cfl').title = pool ? '時間刻み用の基準速度 sqrt(gH) によるCFL。静水中の実流速ではありません。' : '境界速度Uを用いた UΔt/Δx。内部の安定判定では2方向の移流と粘性を別途考慮します。';
  $('energy').textContent = scientific(data.stats.energy); $('divergence').textContent = scientific(data.stats.divergence);
  $('projection').textContent = data.options.pressure && data.projectionCount ? `${scientific(data.before)} → ${scientific(data.after)}` : '未実行';
  const completed = stageNames.findIndex(name => data.stage === name || data.stage === name + 'をスキップ');
  document.querySelectorAll('.stage').forEach((el, i) => el.classList.toggle('current', i === completed));
  $('stage-description').textContent = completed < 0
    ? (data.stage === '設定変更' ? '条件変更' : explanations[0])
    : data.stage.endsWith('をスキップ')
      ? `${['①', '②', '③', '④'][completed]} ${stageNames[completed]} OFF`
      : `${['①', '②', '③', '④'][completed]} ${stageNames[completed]} 完了`;
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
  worker = new Worker('worker.js?v=20261026-pool-steps'); worker.onmessage = receive;
  worker.onerror = () => { playState(false); $('error').hidden = false; $('error').textContent = '計算を起動できませんでした。公開URLから開き直してください。'; };
  send('reset', { n: +$('grid').value, options: options() });
} catch (error) { $('error').hidden = false; $('error').textContent = 'このブラウザでは計算を起動できません。公開URLを対応ブラウザで開いてください。'; }
$('play').onclick = () => { playState(!running); schedule(); };
$('reset').onclick = () => { if (worker) reset(); };
$('step').onclick = () => { playState(false); send('advance'); };
$('stage-step').onclick = () => { playState(false); send('stage'); };
$('cfl-target').oninput = () => {
  cflEditing = true; playState(false);
  $('cfl-value').textContent = (+$('cfl-target').value).toFixed(3);
};
$('cfl-target').onchange = () => {
  cflEditing = false;
  if (worker) send('configure', { options: options() });
};
for (const id of ['advection', 'viscosity', 'gravity', 'pressure', 'scheme-upwind', 'scheme-godunov']) $(id).addEventListener('input', () => {
  controlState(); if (worker) send('configure', { options: options() });
  const stage = ['advection', 'viscosity', 'gravity', 'pressure'].indexOf(id);
  if (stage >= 0) $('stage-description').textContent = explanations[stage];
});
$('grid').onchange = () => {
  caseGrid[$('case').value] = +$('grid').value;
  controlState(); if (worker) reset();
};
$('case').onchange = () => {
  $('grid').value = caseGrid[$('case').value];
  const pool = $('case').value === 'pool';
  $('gravity').checked = pool;
  if (pool) $('pressure').checked = true;
  setView(pool ? 'pressure' : 'speed');
  controlState(); if (worker) reset();
};
$('arrows').onchange = draw;
new ResizeObserver(() => { draw(); FlowProfile.resize(); }).observe(canvas);
function setView(value) {
  view = value;
  document.querySelectorAll('[data-view]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.view === view)));
  canvas.setAttribute('aria-label', `計算した${{speed: '速度', pressure: '圧力', divergence: '発散'}[view]}場。横軸x・縦軸yはmm単位、原点は左下。周囲に境界条件を表示。`);
  draw();
}
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => setView(button.dataset.view));
document.querySelectorAll('[data-stage]').forEach(button => button.onclick = () => { $('stage-description').textContent = explanations[+button.dataset.stage]; });
$('fullscreen').onclick = async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('simulation-view').requestFullscreen(); }
  catch { $('simulation-view').scrollIntoView({ block: 'start' }); }
};
document.addEventListener('fullscreenchange', () => {
  const active = document.fullscreenElement === $('simulation-view');
  const label = active ? '全画面を終了' : '全画面表示';
  $('fullscreen').title = label; $('fullscreen').setAttribute('aria-label', label);
  $('fullscreen').setAttribute('aria-pressed', String(active));
  $('fullscreen').querySelector('img').src = `icons/${active ? 'minimize' : 'maximize'}.svg`;
  FlowProfile.resize();
  if (!active) $('fullscreen').focus({ preventScroll: true });
});
document.addEventListener('visibilitychange', () => { if (document.hidden) playState(false); });
window.addEventListener('pagehide', () => { if (worker) worker.terminate(); });
