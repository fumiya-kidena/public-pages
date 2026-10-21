/* MIT, Copyright (c) 2026 KIDENA-Fumiya. */
'use strict';
const FlowProfile = (() => {
  const canvas = document.getElementById('profile-chart');
  const plot = new Chart(canvas, {
    type: 'scatter',
    data: { datasets: [
      { label: '計算値', data: [], showLine: true, borderColor: '#a22c4b', borderWidth: 2, pointRadius: 0, pointHitRadius: 8 },
      { label: '定常理論', data: [], showLine: true, borderColor: '#168274', borderWidth: 2, borderDash: [6, 4], pointRadius: 0 }
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      parsing: false,
      layout: { padding: { top: 8, right: 12 } },
      scales: {
        x: { type: 'linear', min: 0, max: 1.6, title: { display: true, text: 'u (mm/s)' }, ticks: { maxTicksLimit: 5 }, grid: { color: '#e6ebed' } },
        y: { type: 'linear', min: 0, max: 10, title: { display: true, text: 'y (mm)' }, ticks: { maxTicksLimit: 6 }, grid: { color: '#e6ebed' } }
      },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 22, boxHeight: 2, font: { size: 11 }, padding: 14, filter: (item, data) => data.datasets[item.datasetIndex].data.length > 0 } },
        tooltip: { callbacks: { label: item => `${item.dataset.label}: u = ${item.parsed.x.toFixed(3)} mm/s, y = ${item.parsed.y.toFixed(2)} mm` } }
      }
    }
  });
  function resize() {
    const holder = canvas.parentElement;
    const height = matchMedia('(min-width:1101px)').matches
      ? Math.max(300, document.getElementById('flow').getBoundingClientRect().height+90) : 300;
    if (Math.abs(holder.clientHeight-height)>.5) holder.style.height = `${height}px`;
  }
  function update(frame) {
    const channel = frame.options.case === 'channel';
    const values = Array.from(frame.profileU, (speed, j) => ({
      x: speed*1000,
      y: (j === 0 ? 0 : j === frame.n+1 ? frame.ly : (j-.5)*frame.h)*1000
    }));
    plot.data.datasets[0].data = values;
    plot.data.datasets[1].data = channel ? Array.from({ length: 81 }, (_, i) => {
      const y = i/80;
      return { x: 6*frame.options.inflow*1000*y*(1-y), y: frame.ly*1000*y };
    }) : [];
    plot.data.datasets[1].hidden = !channel;
    const speed = (channel ? frame.options.inflow : frame.options.lid)*1000;
    plot.options.scales.x.min = Math.min(channel ? 0 : -.5*speed, ...values.map(p => p.x));
    plot.options.scales.x.max = Math.max((channel ? 1.6 : 1.1)*speed, ...values.map(p => p.x));
    plot.options.scales.y.max = frame.ly*1000;
    document.getElementById('profile-section').textContent = `${channel ? '出口断面' : '中央の縦断面'} · x = ${Number((frame.profileX*1000).toPrecision(4))} mm`;
    document.getElementById('profile-reference').hidden = !channel;
    canvas.setAttribute('aria-label', `${channel ? '出口' : '中央の縦断面'}の高さyに対する横方向流速u。横軸mm/s、縦軸mm。`);
    resize(); plot.update('none');
  }
  return { update, resize };
})();
