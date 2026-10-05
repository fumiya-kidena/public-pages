// Bounded numeric diagnostics only. No camera frames, QR text, key or UA string.
export function createLabMetrics({ now = () => performance.now() } = {}) {
  let startedAt = now();
  let renders = [], cameras = [], captures = [], poses = [], samples = [];
  let counters = {};
  const windowMs = 2000, sampleLimit = 1800;
  function mark(kind, values = {}, time = now()) {
    if (!Number.isFinite(time)) return;
    const list = { render: renders, camera: cameras, capture: captures, pose: poses }[kind];
    if (list) {
      list.push(time);
      while (list.length && list[0] < time - windowMs) list.shift();
      if (list.length > 2000) list.shift();
    }
    counters[kind] = (counters[kind] || 0) + 1;
    if (kind !== "render" && kind !== "camera") {
      const numbers = Object.fromEntries(Object.entries(values).filter(([, value]) =>
        typeof value === "number" && Number.isFinite(value)));
      samples.push({ atMs: time - startedAt, kind, ...numbers });
      if (samples.length > sampleLimit) samples.shift();
    }
  }
  function snapshot(time = now()) {
    const elapsed = time - startedAt;
    const duration = Math.min(windowMs, elapsed) / 1000;
    const rate = list => duration >= 0.5
      ? list.filter(t => t > time - windowMs && t <= time).length / duration : null;
    const recent = samples.filter(s => s.atMs > elapsed - windowMs);
    const p95 = key => {
      const values = recent.map(s => s[key]).filter(Number.isFinite).sort((a, b) => a - b);
      return values.length ? values[Math.ceil(values.length * 0.95) - 1] : null;
    };
    return { elapsedMs: elapsed, renderFps: rate(renders), cameraFps: rate(cameras),
      captureHz: rate(captures), poseHz: rate(poses), readbackP95Ms: p95("readbackMs"),
      workerP95Ms: p95("workerMs"), latencyP95Ms: p95("latencyMs"),
      counters: { ...counters } };
  }
  return { mark, snapshot,
    reset() { startedAt = now(); renders = []; cameras = []; captures = []; poses = [];
      samples = []; counters = {}; },
    report(metadata = {}) { return { schema: "flowar-tracking-lab-1", metadata,
      summary: snapshot(), samples: samples.map(s => ({ ...s })),
      note: "Numeric timing only; alignment and motion quality require physical-device observation." }; },
  };
}
