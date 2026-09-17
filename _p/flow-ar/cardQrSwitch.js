const routes = {b: ['bagBreakup', 'bagFixed'], d: ['oscillatingDroplet', 'glass'],
  w: ['windWave', 'surface'], m: ['medullaryCavity', null]};

// Never navigate to scanned text or forward scanned credentials. Only use a
// known case selector on this deployment; the already-open page owns unlocking.
export function parseCardQr(text, base, allowed) {
  let url;
  try { url = new URL(text); } catch { return null; }
  const page = new URL(base);
  if (url.origin !== page.origin || url.username || url.password) return null;
  let route;
  if (url.pathname === new URL('../../f/', page).pathname) {
    const match = /^#([bdwm])(\d{78})$/.exec(url.hash);
    if (!match || BigInt(match[2]) >= (1n << 256n)) return null;
    route = routes[match[1]];
  } else {
    const root = new URL('./', page).pathname;
    if (![root, ...['index.html', 'marker.html', 'markerAr.html', 'imageMarkerAr.html'].map(p => root + p)].includes(url.pathname)) return null;
    route = [url.searchParams.get('case'), url.searchParams.get('mode')];
  }
  return allowed.includes(route[0]) ? {caseId: route[0], mode: route[1]} : null;
}

export function createCardQrSwitch({base, allowed, currentCase, onSwitch, onError = () => {},
  now = () => performance.now(),
  workerFactory = () => new Worker(new URL('./cardQrWorker.js?v=1', import.meta.url)),
  setTimer = setTimeout, clearTimer = clearTimeout}) {
  let worker, pending, timer, last = -Infinity, candidate, stopped = false, id = 0;
  function stop() {
    stopped = true; clearTimer(timer); worker?.terminate(); pending = null;
  }
  function fail() { stop(); onError(); }
  return {
    processFrame(frame) {
      if (stopped || pending || now() - last < 800) return;
      last = now();
      try {
        if (!worker) {
          worker = workerFactory();
          worker.onerror = fail;
          worker.onmessageerror = fail;
          worker.onmessage = ({data}) => {
            if (!pending || data.id !== pending.id) return;
            const request = pending; pending = null; clearTimer(timer);
            if (data.error) { fail(); return; }
            if (!request.frame.isCurrent() || now() - request.at > 1800) { candidate = null; return; }
            const route = parseCardQr(data.text, base, allowed);
            if (!route || route.caseId === currentCase()) { candidate = null; return; }
            if (candidate?.caseId === route.caseId && now() - candidate.at < 2500) {
              stop(); onSwitch(route); return;
            }
            candidate = {...route, at: now()};
          };
        }
        // Copy before point tracking transfers the original buffer. At most one
        // QR request in flight; never delay or queue the tracking worker.
        const pixels = frame.data.slice();
        pending = {id: ++id, frame, at: now()};
        timer = setTimer(fail, 4000);
        worker.postMessage({id, data: pixels, width: frame.width, height: frame.height}, [pixels.buffer]);
      } catch { fail(); }
    },
    dispose: stop
  };
}
