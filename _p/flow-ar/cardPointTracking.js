import { homographyFromCardPose, projectCardPoints } from "./cardPointPose.js?v=1";
import { createCardPointScale } from "./cardPointScale.js?v=1";

// This controller accepts measured coloured points only. XR8's whole-image
// callback supplies an optional search/scene-scale hint, never a display pose.
export function createCardPointTracking({
  THREE, layout, onPose, onState = () => {}, isEnabled = () => true,
  isWorldTrackingNormal = () => true, maySnap = () => false,
  now = () => performance.now(),
  workerFactory = () => new Worker(new URL("./cardPointWorker.js?v=1", import.meta.url), { type: "module" }),
  setTimer = setTimeout, clearTimer = clearTimeout
}) {
  const scaleCalibration = createCardPointScale();
  let worker = null, request = null, requestId = 0, epoch = 0, failed = false;
  let anchor = null, candidate = null, transition = null, imageHint = null;
  let lastMeasuredAt = -Infinity, lastGlobalAt = -Infinity, currentState = "searching";
  let calibration = { scale: 1, calibrated: false, source: "provisional" };
  const vector = p => new THREE.Vector3(p.x, p.y, p.z);
  const quaternion = q => new THREE.Quaternion(q.x, q.y, q.z, q.w).normalize();
  const clonePose = p => ({ ...p, position: p.position.clone(), quaternion: p.quaternion.clone() });
  const state = (name, detail = {}) => {
    currentState = name;
    onState({ name, calibrated: calibration.calibrated, ...detail });
  };
  const publish = p => {
    anchor = clonePose(p);
    onPose(clonePose(p));
  };
  function projectedPose(pose, frame) {
    if (!pose || !(pose.scale > 0)) return null;
    const inverse = quaternion(frame.cameraQuaternion).invert();
    const position = pose.position.clone().sub(vector(frame.cameraPosition)).applyQuaternion(inverse).divideScalar(pose.scale);
    const rotation = inverse.multiply(pose.quaternion);
    return homographyFromCardPose(position, rotation, frame.projectionMatrix, frame);
  }
  function residual(pose, frame, matches) {
    const points = projectCardPoints(projectedPose(pose, frame), layout);
    if (!points) return Infinity;
    const byId = new Map(points.map(p => [p.id, p]));
    return Math.sqrt(matches.reduce((sum, p) => {
      const q = byId.get(p.id);
      return sum + (q ? (p.x - q.x) ** 2 + (p.y - q.y) ** 2 : Infinity);
    }, 0) / matches.length);
  }
  function blend(a, b, alpha) {
    return {
      ...b, position: a.position.clone().lerp(b.position, alpha),
      quaternion: a.quaternion.clone().slerp(b.quaternion, alpha),
      scale: a.scale + (b.scale - a.scale) * alpha
    };
  }
  function observe(result, frame) {
    if (result.reason !== "measured") {
      candidate = null;
      tick(now());
      return;
    }
    lastMeasuredAt = frame.capturedAt;
    const hintFresh = imageHint && frame.capturedAt - imageHint.capturedAt < 750;
    calibration = scaleCalibration.observe({
      ...frame, position: result.pose.position,
      scaleHint: hintFresh && imageHint.scaleCalibrated ? imageHint.scale : undefined
    });
    const cameraQuaternion = quaternion(frame.cameraQuaternion);
    const pose = {
      position: vector(result.pose.position).multiplyScalar(calibration.scale)
        .applyQuaternion(cameraQuaternion).add(vector(frame.cameraPosition)),
      quaternion: cameraQuaternion.multiply(quaternion(result.pose.quaternion)),
      scale: calibration.scale, scaleCalibrated: calibration.calibrated,
      capturedAt: frame.capturedAt, count: result.count, rmsPixels: result.rmsPixels
    };
    const error = residual(anchor, frame, result.matches);
    const largeChange = !anchor || error > 18 || anchor.quaternion.angleTo(pose.quaternion) > Math.PI / 7;
    if (largeChange && !transition) {
      // Two independently measured observations confirm acquisition/recovery.
      // No upper distance/size gate: even a very wrong old anchor can recover.
      const confirmed = candidate && frame.capturedAt - candidate.capturedAt <= 700
        && residual(candidate, frame, result.matches) < 12
        && candidate.quaternion.angleTo(pose.quaternion) < Math.PI / 9;
      candidate = pose;
      if (!confirmed) {
        state(anchor ? "confirming-recovery" : "confirming", { count: result.count });
        return;
      }
      candidate = null;
      if (anchor && !maySnap()) {
        transition = { start: clonePose(anchor), target: pose, startedAt: now(), duration: 650 };
      } else publish(pose);
    } else if (transition) {
      // The recovery deadline does not restart with every camera observation.
      // Require the new measured pose to agree with the previous target.
      if (residual(transition.target, frame, result.matches) < 12) transition.target = pose;
      else { transition = null; candidate = pose; state("confirming-recovery", { count: result.count }); return; }
    } else {
      candidate = null;
      // Smooth noise only while the filtered pose still agrees with the current
      // measured dots. Position, rotation AND scale always move as one packet.
      let filtered = blend(anchor, pose, 0.4);
      if (residual(filtered, frame, result.matches) > Math.max(2, result.rmsPixels + 0.7)) filtered = blend(anchor, pose, 0.8);
      if (residual(filtered, frame, result.matches) > Math.max(2.5, result.rmsPixels + 1)) filtered = pose;
      publish(filtered);
    }
    lastMeasuredAt = frame.capturedAt;
    state(transition ? "correcting" : "points", { count: result.count, rmsPixels: result.rmsPixels });
  }
  function fail() {
    failed = true;
    worker?.terminate(); worker = null;
    if (request) { clearTimer(request.timer); request.resolve(); request = null; }
    state("unavailable");
  }
  function ensureWorker() {
    if (worker || failed) return worker;
    try {
      worker = workerFactory();
      worker.onmessage = ({ data }) => {
        if (!request || data.id !== request.id) return;
        const pending = request;
        request = null;
        clearTimer(pending.timer);
        try {
          if (data.error) { fail(); return; }
          if (pending.epoch === epoch && isEnabled() && pending.frame.isCurrent()
            && now() - pending.frame.capturedAt <= 600) observe(data.result, pending.frame);
        } finally { pending.resolve(); }
      };
      worker.onerror = fail;
      worker.onmessageerror = fail;
    } catch { fail(); }
    return worker;
  }
  function processFrame(frame) {
    if (failed || request || !isEnabled() || !ensureWorker()) return Promise.resolve();
    const hint = imageHint && frame.capturedAt - imageHint.capturedAt < 750 ? imageHint : null;
    // Confirm a newly acquired (possibly far-away) paper from its MEASURED
    // candidate, not the stale displayed anchor. The same applies mid-recovery.
    const freshCandidate = candidate && frame.capturedAt - candidate.capturedAt <= 700 ? candidate : null;
    const seedHomography = projectedPose(transition?.target || freshCandidate || anchor || hint, frame);
    const allowGlobal = frame.capturedAt - lastGlobalAt >= 500;
    if (allowGlobal) lastGlobalAt = frame.capturedAt;
    return new Promise(resolve => {
      const id = ++requestId;
      request = { id, frame, epoch, resolve, timer: setTimer(fail, 3500) };
      try {
        worker.postMessage({ id, caseId: layout.caseId, data: frame.data,
          width: frame.width, height: frame.height, projectionMatrix: frame.projectionMatrix,
          seedHomography, allowGlobal }, [frame.data.buffer]);
      } catch { fail(); }
    });
  }
  function tick(time = now()) {
    if (failed) return;
    if (transition) {
      if (!isEnabled() || time - lastMeasuredAt > 450) transition = null;
      else {
        const t = Math.min(1, Math.max(0, (time - transition.startedAt) / transition.duration));
        publish(blend(transition.start, transition.target, t * t * (3 - 2 * t)));
        if (t === 1) { transition = null; state("points", { count: anchor.count }); }
      }
    }
    if (time - lastMeasuredAt > 450) {
      const next = !anchor ? "searching" : isWorldTrackingNormal() && calibration.calibrated ? "held" : "held-limited";
      if (currentState !== next) state(next);
    }
  }
  function invalidate({ reset = false } = {}) {
    epoch++;
    candidate = null; transition = null; imageHint = null;
    lastMeasuredAt = -Infinity; lastGlobalAt = -Infinity;
    // Responsive scene units can change after SLAM loss/relocalization.
    scaleCalibration.reset();
    calibration = { scale: 1, calibrated: false, source: "provisional" };
    if (reset) { anchor = null; failed = false; }
    state(anchor ? "held-limited" : "searching");
  }
  return {
    processFrame, tick, invalidate,
    setImageHint: hint => { imageHint = hint ? clonePose(hint) : null; },
    fail,
    dispose: () => {
      epoch++; worker?.terminate(); worker = null;
      if (request) { clearTimer(request.timer); request.resolve(); request = null; }
      failed = true;
    }
  };
}
