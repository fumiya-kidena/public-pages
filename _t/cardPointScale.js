// Online scene-unit calibration for a canonical-size planar point pose.
// Static paper: C1 + s * R1*t1 = C2 + s * R2*t2. C/R are the camera world pose;
// t is the point solver's camera-local translation, in canonical card metres.
// A print-size label (business card/A4) is neither needed nor inferred here.
// The caller submits only quality-gated point poses and resets on scene-origin
// changes. Position, rotation and camera pixels MUST belong to the same frame.
// Monocular limitation: deliberately coordinated paper/camera motion can mimic
// a static paper at another scale. Residual checks cannot remove that ambiguity.

const finite3 = v => v && [v.x, v.y, v.z].every(Number.isFinite);
const subtract = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((v, n, i) => v + n * b[i], 0);
const norm = a => Math.hypot(...a);
const median = a => { const b = [...a].sort((x, y) => x - y); return b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2; };

function rotate(v, q) {
  if (!q || ![q.x, q.y, q.z, q.w].every(Number.isFinite)) return null;
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  if (length < 1e-9) return null;
  const x = q.x / length, y = q.y / length, z = q.z / length, w = q.w / length;
  const tx = 2 * (y * v.z - z * v.y), ty = 2 * (z * v.x - x * v.z), tz = 2 * (x * v.y - y * v.x);
  return [v.x + w * tx + y * tz - z * ty, v.y + w * ty + z * tx - x * tz, v.z + w * tz + x * ty - y * tx];
}

/**
 * createCardPointScale(options?) -> {observe, reset}
 * observe({cameraPosition,cameraQuaternion,position,capturedAt,scaleHint?})
 * capturedAt is monotonic milliseconds, not Unix seconds. All poses are one
 * camera frame. A finite positive hint seeds scene units, never marker pose.
 */
export function createCardPointScale(options = {}) {
  const settings = {
    minScale: 0.02, maxScale: 50, minSamples: 4, minPairs: 3,
    minCameraBaseline: 0.012, relativeCameraBaseline: 0.025,
    minSampleIntervalMs: 80, minPairIntervalMs: 160, maxAgeMs: 2400,
    maxSamples: 14, maxResidual: 0.003, relativeResidual: 0.12,
    minInlierRatio: 0.75, candidateTolerance: 0.08,
    confirmationCount: 3, largeChangeRatio: 0.22, largeChangeConfirmationCount: 6,
    smoothing: 0.18, maxRelativeStep: 0.04,
    ...options,
  };
  const validScale = value => Number.isFinite(value) && value >= settings.minScale && value <= settings.maxScale;
  let currentScale, source, history, candidate, motionEstablished, lastAcceptedAt, lastObservedAt, diagnostic;

  function reset() {
    currentScale = 1; source = 'provisional'; history = []; candidate = null;
    motionEstablished = false; lastAcceptedAt = -Infinity; lastObservedAt = -Infinity;
    diagnostic = { calibrationConfidence: 0, sampleCount: 0, pairCount: 0, residual: null };
    return snapshot();
  }

  function snapshot() {
    return { scale: currentScale, calibrated: source !== 'provisional', source, ...diagnostic };
  }

  function estimate() {
    if (history.length < settings.minSamples) return null;
    const sceneDepth = median(history.map(sample => sample.depth)) * currentScale;
    const minimumBaseline = Math.max(settings.minCameraBaseline, sceneDepth * settings.relativeCameraBaseline);
    const pairs = [];
    for (let i = 0; i < history.length; i++) for (let j = i + 1; j < history.length; j++) {
      const first = history[i], second = history[j];
      if (second.at - first.at < settings.minPairIntervalMs) continue;
      const dc = subtract(second.camera, first.camera), dr = subtract(second.ray, first.ray);
      const baseline = norm(dc), denominator = dot(dr, dr);
      if (baseline < minimumBaseline) continue;
      const scale = denominator > 1e-12 ? -dot(dc, dr) / denominator : NaN;
      // Keep invalid baseline pairs in the consensus denominator: moving paper
      // must not look trustworthy just because its conflicting pairs vanished.
      pairs.push({ i, j, dc, dr, denominator, baseline, scale,
        tolerance: Math.max(settings.maxResidual, baseline * settings.relativeResidual) });
    }
    if (pairs.length < settings.minPairs) return null;
    const usable = pairs.filter(pair => validScale(pair.scale));
    if (usable.length < settings.minPairs) return null;
    const initial = median(usable.map(pair => pair.scale));
    const error = (pair, scale) => norm(pair.dc.map((v, axis) => v + scale * pair.dr[axis]));
    let inliers = usable.filter(pair => error(pair, initial) <= pair.tolerance);
    if (inliers.length < settings.minPairs || inliers.length / pairs.length < settings.minInlierRatio) return null;
    // Least squares after robust median/consensus. Larger baselines carry more
    // information, but no single pair can exceed a four-fold weight advantage.
    const typicalDenominator = median(inliers.map(pair => pair.denominator));
    let numerator = 0, denominator = 0;
    for (const pair of inliers) {
      const weight = Math.min(1, 4 * typicalDenominator / pair.denominator);
      numerator -= weight * dot(pair.dc, pair.dr);
      denominator += weight * pair.denominator;
    }
    const scale = numerator / denominator;
    if (!validScale(scale)) return null;
    inliers = usable.filter(pair => error(pair, scale) <= pair.tolerance);
    const distinct = new Set(inliers.flatMap(pair => [pair.i, pair.j]));
    if (inliers.length < settings.minPairs || inliers.length / pairs.length < settings.minInlierRatio || distinct.size < settings.minSamples) return null;
    // Pairwise fits alone are correlated. Require their reconstructed paper
    // centres to agree too, rather than accepting several copies of one pair.
    const anchors = [...distinct].map(i => history[i].camera.map((v, axis) => v + scale * history[i].ray[axis]));
    const center = [0, 1, 2].map(axis => median(anchors.map(point => point[axis])));
    const errors = anchors.map(point => norm(subtract(point, center)));
    const anchorTolerance = Math.max(settings.maxResidual * 2, median(inliers.map(pair => pair.baseline)) * settings.relativeResidual);
    if (errors.filter(value => value <= anchorTolerance).length / anchors.length < settings.minInlierRatio) return null;
    const rms = Math.sqrt(inliers.reduce((sum, pair) => sum + error(pair, scale) ** 2, 0) / inliers.length);
    return { scale, rms, pairCount: inliers.length, sampleCount: distinct.size,
      confidence: (inliers.length / pairs.length) / (1 + rms / settings.maxResidual) };
  }

  function observe(observation) {
    if (!observation || !finite3(observation.cameraPosition) || !finite3(observation.position) ||
        observation.position.z >= -1e-8 || !Number.isFinite(observation.capturedAt)) return snapshot();
    const ray = rotate(observation.position, observation.cameraQuaternion);
    if (!ray || !ray.every(Number.isFinite) || observation.capturedAt <= lastObservedAt) return snapshot();
    lastObservedAt = observation.capturedAt;
    // One initial image hint is useful for scale, but repeated drifting whole-
    // image estimates cannot keep overriding motion-consistent point evidence.
    if (source === 'provisional' && validScale(observation.scaleHint)) {
      currentScale = observation.scaleHint; source = 'image-hint';
      diagnostic.calibrationConfidence = 0.45;
    }
    if (observation.capturedAt - lastAcceptedAt < settings.minSampleIntervalMs) return snapshot();
    lastAcceptedAt = observation.capturedAt;
    history = history.filter(sample => observation.capturedAt - sample.at <= settings.maxAgeMs);
    history.push({ at: observation.capturedAt, camera: [observation.cameraPosition.x, observation.cameraPosition.y, observation.cameraPosition.z],
      ray, depth: norm(ray) });
    if (history.length > settings.maxSamples) history.shift();
    diagnostic.sampleCount = history.length;
    const estimateValue = estimate();
    if (!estimateValue) {
      candidate = null;
      return snapshot();
    }
    if (!candidate || Math.abs(Math.log(estimateValue.scale / candidate.scale)) > settings.candidateTolerance) {
      candidate = { scale: estimateValue.scale, count: 1 };
    } else {
      candidate.scale = 0.5 * candidate.scale + 0.5 * estimateValue.scale;
      candidate.count++;
    }
    const changeRatio = Math.abs(Math.log(candidate.scale / currentScale));
    const confirmationCount = motionEstablished && changeRatio > settings.largeChangeRatio ?
      settings.largeChangeConfirmationCount : settings.confirmationCount;
    if (candidate.count < confirmationCount) return snapshot();
    if (!motionEstablished) {
      // Initial calibration changes both translation and scale together. Thus
      // the projected paper alignment is unchanged while SLAM units become valid.
      currentScale = candidate.scale;
    } else {
      const logStep = Math.max(-settings.maxRelativeStep, Math.min(settings.maxRelativeStep,
        Math.log(candidate.scale / currentScale) * settings.smoothing));
      currentScale *= Math.exp(logStep);
    }
    motionEstablished = true; source = 'motion';
    diagnostic = { calibrationConfidence: estimateValue.confidence, sampleCount: estimateValue.sampleCount,
      pairCount: estimateValue.pairCount, residual: estimateValue.rms };
    return snapshot();
  }

  reset();
  return { observe, reset };
}
