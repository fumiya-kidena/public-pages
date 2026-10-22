/* MIT, Copyright (c) 2026 KIDENA-Fumiya. */
'use strict';
const FlowProfile = (() => {
  function createPlot(id, horizontal) {
    return new Chart(document.getElementById(id), {
      type: 'scatter',
      data: { datasets: [
        { label: '計算値', data: [], showLine: true, borderColor: horizontal ? '#326db4' : '#a22c4b', borderWidth: 2, pointRadius: 0, pointHitRadius: 8, pointStyle: 'line' },
        { label: '定常理論', data: [], showLine: true, borderColor: '#168274', borderWidth: 2, borderDash: [6, 4], pointRadius: 0, pointStyle: 'line' },
        { label: 'Ghia Re=100', data: [], showLine: false, borderColor: '#168274', backgroundColor: '#fff', pointBorderWidth: 1.5, pointRadius: 3, pointHitRadius: 6, pointStyle: 'circle' },
        ...[.55, .35, .2].map(alpha => ({ label: '', data: [], showLine: true, borderColor: horizontal ? `rgba(50,109,180,${alpha})` : `rgba(162,44,75,${alpha})`, borderWidth: 1.5, pointRadius: 0, pointHitRadius: 5, pointStyle: 'line', order: 2 }))
      ] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        parsing: false,
        layout: { padding: { top: 6, right: 8 } },
        scales: {
          x: { type: 'linear', title: { display: true, text: horizontal ? 'x (mm)' : 'u (mm/s)' }, ticks: { maxTicksLimit: 5 }, grid: { color: '#e6ebed' } },
          y: { type: 'linear', title: { display: true, text: horizontal ? 'v (mm/s)' : 'y (mm)' }, ticks: { maxTicksLimit: 5 }, grid: { color: '#e6ebed' } }
        },
        plugins: {
          legend: { position: 'bottom', labels: { usePointStyle: true, pointStyleWidth: 20, boxHeight: 6, font: { size: 11 }, padding: 10, filter: (item, data) => data.datasets[item.datasetIndex].data.length > 0 } },
          tooltip: { callbacks: { title: items => {
            const dataset = items[0]?.dataset;
            return dataset?.time === undefined ? '' : `t = ${dataset.time.toFixed(5)} s`;
          }, label: item => horizontal
            ? `${item.dataset.label}: x = ${item.parsed.x.toFixed(2)} mm, v = ${item.parsed.y.toFixed(3)} mm/s`
            : `${item.dataset.label}: u = ${item.parsed.x.toFixed(3)} mm/s, y = ${item.parsed.y.toFixed(2)} mm` } }
        }
      }
    });
  }
  const vertical = createPlot('profile-chart', false);
  const horizontal = createPlot('profile-v-chart', true);
  let channelMode = true;
  function resize() {
    let height = matchMedia('(min-width:1101px)').matches
      ? Math.max(channelMode ? 230 : 180, (document.getElementById('flow').getBoundingClientRect().height-50)/2) : 280;
    if (document.fullscreenElement && matchMedia('(min-width:1101px)').matches) {
      height = Math.min(height, Math.max(170, (window.innerHeight-360)/2));
    }
    for (const plot of [vertical, horizontal]) {
      const holder = plot.canvas.parentElement;
      if (Math.abs(holder.clientHeight-height)>.5) holder.style.height = `${height}px`;
    }
  }
  function update(frame) {
    const channel = frame.options.case === 'channel';
    channelMode = channel;
    const reference = GhiaReference.sample(frame);
    const pointsU = profile => Array.from(profile, (speed, j) => ({
      x: speed*1000,
      y: (j === 0 ? 0 : j === frame.n+1 ? frame.ly : (j-.5)*frame.h)*1000
    }));
    const pointsV = profile => Array.from(profile, (speed, i) => ({
      x: (i === 0 ? 0 : i === frame.nx+1 ? frame.lx : (i-.5)*frame.h)*1000,
      y: speed*1000
    }));
    const u = pointsU(frame.profileU), v = pointsV(frame.profileV);
    vertical.data.datasets[0].data = u;
    horizontal.data.datasets[0].data = v;
    for (const plot of [vertical, horizontal]) plot.data.datasets[0].time = frame.time;
    for (let i=0; i<3; i++) {
      const history = channel ? frame.profileHistory?.[i] : null;
      for (const [plot, points, key] of [[vertical, pointsU, 'profileU'], [horizontal, pointsV, 'profileV']]) {
        const dataset = plot.data.datasets[i+3];
        dataset.data = history ? points(history[key]) : [];
        dataset.label = history ? `${frame.steps-history.steps} steps前` : '';
        dataset.time = history?.time;
      }
    }
    vertical.data.datasets[1].data = channel ? Array.from({ length: 81 }, (_, i) => {
      const y = i/80;
      return { x: 6*frame.options.inflow*1000*y*(1-y), y: frame.ly*1000*y };
    }) : [];
    horizontal.data.datasets[1].data = channel ? [{ x: 0, y: 0 }, { x: frame.lx*1000, y: 0 }] : [];
    vertical.data.datasets[2].data = reference ? reference.u : [];
    horizontal.data.datasets[2].data = reference ? reference.v : [];
    const speed = (channel ? frame.options.inflow : frame.options.lid)*1000;
    const allU = vertical.data.datasets.flatMap(dataset => dataset.data.map(p => p.x));
    const allV = horizontal.data.datasets.flatMap(dataset => dataset.data.map(p => p.y));
    vertical.options.scales.x.min = Math.min(channel ? 0 : -.5*speed, ...allU);
    vertical.options.scales.x.max = Math.max((channel ? 1.6 : 1.1)*speed, ...allU);
    vertical.options.scales.y.min = 0;
    vertical.options.scales.y.max = frame.ly*1000;
    horizontal.options.scales.x.min = 0;
    horizontal.options.scales.x.max = frame.lx*1000;
    horizontal.options.scales.y.min = Math.min(-.3*speed, ...allV);
    horizontal.options.scales.y.max = Math.max(.3*speed, ...allV);
    const mm = x => Number((x*1000).toPrecision(4));
    document.getElementById('profile-section').textContent = `${channel ? '出口断面' : '中央の縦断面'} · x = ${mm(frame.profileX)} mm`;
    document.getElementById('profile-v-section').textContent = `中央の横断面 · y = ${mm(frame.profileY)} mm`;
    document.getElementById('profile-reference').textContent = channel
      ? '破線は十分に発達した流れの定常理論。計算値は現在の時刻の値です。'
      : reference ? '丸印はGhiaらの定常参照値（Re=100）。実線は現在の計算値です。'
        : `現在のRe=${Number((frame.options.lid*frame.ly/frame.options.nu).toPrecision(4))}に対応する参照値は未収録です（収録：Re=100）。`;
    document.getElementById('profile-citation').hidden = !reference;
    document.getElementById('profile-model-note').hidden = (!channel && !reference)
      || (frame.options.advection && frame.options.viscosity && frame.options.pressure);
    vertical.canvas.setAttribute('aria-label', `${channel ? '出口' : '中央の縦断面'}の高さyに対する横方向流速u。横軸mm/s、縦軸mm。${reference ? 'GhiaらのRe=100の定常参照値を丸印で表示。' : ''}`);
    horizontal.canvas.setAttribute('aria-label', `中央の横断面の位置xに対する縦方向流速v。横軸mm、縦軸mm/s。${reference ? 'GhiaらのRe=100の定常参照値を丸印で表示。' : ''}`);
    resize(); vertical.update('none'); horizontal.update('none');
  }
  return { update, resize };
})();
