/* MIT, Copyright (c) 2026 KIDENA-Fumiya. */
'use strict';
const FlowProfile = (() => {
  const uColor = '#a22c4b', vColor = '#326db4';
  const line = (label, color, component = 'u') => ({
    label, component, data: [], showLine: true, borderColor: color, borderWidth: 2,
    pointRadius: 0, pointHitRadius: 8, pointStyle: 'line',
    xAxisID: component === 'u' ? 'x' : 'xPosition', yAxisID: component === 'u' ? 'y' : 'yVelocity'
  });
  const reference = (component, color) => ({
    ...line(component + ' · Ghia', color, component), showLine: false,
    backgroundColor: '#fff', pointBorderWidth: 1.5, pointRadius: 3, pointHitRadius: 6,
    pointStyle: component === 'u' ? 'circle' : 'rect'
  });
  const currentU = line('u', uColor), currentV = line('v', vColor, 'v');
  const theory = { ...line('定常理論', '#168274'), borderDash: [6, 4] };
  const ghiaU = reference('u', uColor), ghiaV = reference('v', vColor);
  const historyU = [.55, .35, .2].map(alpha => ({
    ...line('', 'rgba(162,44,75,' + alpha + ')'), borderWidth: 1.5, order: 2
  }));
  const axis = (position, text, color = '#627078') => ({
    type: 'linear', position, title: { display: true, text, color },
    ticks: { maxTicksLimit: 5, color }, grid: { color: '#e6ebed' }
  });
  const plot = new Chart(document.getElementById('profile-chart'), {
    type: 'scatter',
    data: { datasets: [currentU, theory, ghiaU, ...historyU, currentV, ghiaV] },
    plugins: [{
      id: 'profile-centerlines',
      beforeDatasetsDraw(chart) {
        if (!chart.options.scales.xPosition.display) return;
        const { ctx, chartArea: area, scales } = chart;
        ctx.save(); ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
        ctx.strokeStyle = uColor; ctx.beginPath();
        ctx.moveTo(scales.x.getPixelForValue(0), area.top);
        ctx.lineTo(scales.x.getPixelForValue(0), area.bottom); ctx.stroke();
        ctx.strokeStyle = vColor; ctx.beginPath();
        ctx.moveTo(area.left, scales.yVelocity.getPixelForValue(0));
        ctx.lineTo(area.right, scales.yVelocity.getPixelForValue(0)); ctx.stroke();
        ctx.restore();
      }
    }],
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
      layout: { padding: { top: 6, right: 8 } },
      scales: {
        x: axis('bottom', 'u (mm/s)', uColor),
        y: axis('left', 'y (mm)'),
        xPosition: { ...axis('bottom', 'x (mm)'), display: false },
        yVelocity: { ...axis('right', 'v (mm/s)', vColor), display: false, grid: { drawOnChartArea: false } }
      },
      plugins: {
        legend: { position: 'bottom', labels: {
          usePointStyle: true, pointStyleWidth: 20, boxHeight: 6, font: { size: 11 }, padding: 10,
          filter: (item, data) => data.datasets[item.datasetIndex].data.length > 0
        } },
        tooltip: { callbacks: {
          title: items => items[0]?.dataset.time === undefined ? '' : 't = ' + items[0].dataset.time.toFixed(5) + ' s',
          label: item => item.dataset.component === 'v'
            ? item.dataset.label + ': x = ' + item.parsed.x.toFixed(2) + ' mm, v = ' + item.parsed.y.toFixed(3) + ' mm/s'
            : item.dataset.label + ': u = ' + item.parsed.x.toFixed(3) + ' mm/s, y = ' + item.parsed.y.toFixed(2) + ' mm'
        } }
      }
    }
  });
  let channelMode = true;
  function resize() {
    const holder = plot.canvas.parentElement;
    let height = channelMode ? 320 : Math.max(320, Math.min(460, holder.clientWidth + 35));
    if (document.fullscreenElement && matchMedia('(min-width:1101px)').matches) {
      height = Math.min(height, Math.max(240, window.innerHeight - 260));
    }
    if (Math.abs(holder.clientHeight - height) > .5) holder.style.height = height + 'px';
  }
  function update(frame) {
    const channel = frame.options.case === 'channel';
    channelMode = channel;
    const ref = GhiaReference.sample(frame);
    const pointsU = profile => Array.from(profile, (speed, j) => ({
      x: speed * 1000,
      y: (j === 0 ? 0 : j === frame.n + 1 ? frame.ly : (j - .5) * frame.h) * 1000
    }));
    currentU.data = pointsU(frame.profileU);
    currentV.data = channel ? [] : Array.from(frame.profileV, (speed, i) => ({
      x: (i === 0 ? 0 : i === frame.nx + 1 ? frame.lx : (i - .5) * frame.h) * 1000,
      y: speed * 1000
    }));
    currentU.time = currentV.time = frame.time;
    historyU.forEach((dataset, i) => {
      const history = channel ? frame.profileHistory?.[i] : null;
      dataset.data = history ? pointsU(history.profileU) : [];
      dataset.label = history ? (frame.steps - history.steps) + ' steps前' : '';
      dataset.time = history?.time;
    });
    theory.data = channel ? Array.from({ length: 81 }, (_, i) => ({
      x: 6 * frame.options.inflow * 1000 * (i / 80) * (1 - i / 80), y: frame.ly * 1000 * i / 80
    })) : [];
    ghiaU.data = ref ? ref.u : [];
    ghiaV.data = ref ? ref.v : [];
    const speed = (channel ? frame.options.inflow : frame.options.lid) * 1000;
    const allU = [currentU, theory, ghiaU, ...historyU].flatMap(dataset => dataset.data.map(p => p.x));
    const allV = [currentV, ghiaV].flatMap(dataset => dataset.data.map(p => p.y));
    const extent = Math.max(.001, speed, ...allU.map(Math.abs), ...allV.map(Math.abs));
    const scales = plot.options.scales;
    scales.x.position = channel ? 'bottom' : 'top';
    scales.x.grid.drawOnChartArea = channel;
    scales.x.min = channel ? Math.min(0, ...allU) : -extent;
    scales.x.max = channel ? Math.max(1.6 * speed, ...allU) : extent;
    scales.y.min = 0; scales.y.max = frame.ly * 1000;
    scales.xPosition.display = scales.yVelocity.display = !channel;
    scales.xPosition.min = 0; scales.xPosition.max = frame.lx * 1000;
    scales.yVelocity.min = -extent; scales.yVelocity.max = extent;
    const mm = x => Number((x * 1000).toPrecision(4));
    document.getElementById('profile-title').textContent = channel ? 'u · 下流断面' : 'u・v · 中央断面';
    document.getElementById('profile-section').textContent = channel
      ? 'x = ' + mm(frame.profileX) + ' mm' : 'x = ' + mm(frame.profileX) + ' mm / y = ' + mm(frame.profileY) + ' mm';
    document.getElementById('profile-reference-row').hidden = channel;
    document.getElementById('profile-reference').textContent = ref ? 'Ghia · Re=100（定常）'
      : 'Re=' + Number((frame.options.lid * frame.ly / frame.options.nu).toPrecision(4)) + '：参照値なし';
    document.getElementById('profile-citation').hidden = !ref;
    document.getElementById('profile-model-note').hidden = (!channel && !ref)
      || (frame.options.advection && frame.options.viscosity && frame.options.pressure);
    plot.canvas.setAttribute('aria-label', channel
      ? '出口の2 mm手前のu分布。横軸u (mm/s)、縦軸y (mm)。定常理論と60・120・180ステップ前の履歴。'
      : '中央断面のuとvの速度分布。上軸u (mm/s)、左軸y (mm)、下軸x (mm)、右軸v (mm/s)。破線は速度ゼロ。Ghia参照値はuが丸印、vが四角印。');
    resize(); plot.update('none');
  }
  return { update, resize };
})();
