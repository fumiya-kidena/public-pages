import { createCardPointScale } from '../cardPointScale.js';

// Geometry convention: the card centre is the origin, +X is its long edge,
// +Y points up the print, and +Z points out of its face. The camera looks -Z.
// These are CANONICAL authoring metres, not a claim that a print is 91 mm wide.
// Uniform enlargement to A4 changes the paper/engine unit bridge, never the
// box/card ratio. This module has no renderer, worker, or private asset access.
export const CANONICAL_CARD_METRES = Object.freeze({ width: 0.091, height: 0.055 });
export const TRACKING_LAB_MODES = Object.freeze(['paper', 'hybrid', 'slam']);

const finiteVector = value => value && [value.x, value.y, value.z].every(Number.isFinite);
const cloneVector = value => ({ x: value.x, y: value.y, z: value.z });
const cloneQuaternion = value => ({ x: value.x, y: value.y, z: value.z, w: value.w });
const clonePose = value => value && ({ position: cloneVector(value.position),
  quaternion: cloneQuaternion(value.quaternion), scale: value.scale });

export function normalizeQuaternion(value) {
  if (!value || ![value.x, value.y, value.z, value.w].every(Number.isFinite)) return null;
  const length = Math.hypot(value.x, value.y, value.z, value.w);
  if (length < 1e-12) return null;
  return { x: value.x / length, y: value.y / length, z: value.z / length, w: value.w / length };
}

export function vectorDistance(a, b) {
  return finiteVector(a) && finiteVector(b) ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : Infinity;
}

export function quaternionAngle(a, b) {
  const first = normalizeQuaternion(a), second = normalizeQuaternion(b);
  if (!first || !second) return Infinity;
  const dot = Math.abs(first.x * second.x + first.y * second.y + first.z * second.z + first.w * second.w);
  return 2 * Math.acos(Math.min(1, dot));
}

export function multiplyQuaternions(a, b) {
  const first = normalizeQuaternion(a), second = normalizeQuaternion(b);
  if (!first || !second) return null;
  return normalizeQuaternion({
    x: first.w * second.x + first.x * second.w + first.y * second.z - first.z * second.y,
    y: first.w * second.y - first.x * second.z + first.y * second.w + first.z * second.x,
    z: first.w * second.z + first.x * second.y - first.y * second.x + first.z * second.w,
    w: first.w * second.w - first.x * second.x - first.y * second.y - first.z * second.z
  });
}

export function rotateVector(value, quaternion) {
  const q = normalizeQuaternion(quaternion);
  if (!finiteVector(value) || !q) return null;
  const tx = 2 * (q.y * value.z - q.z * value.y);
  const ty = 2 * (q.z * value.x - q.x * value.z);
  const tz = 2 * (q.x * value.y - q.y * value.x);
  return { x: value.x + q.w * tx + q.y * tz - q.z * ty,
    y: value.y + q.w * ty + q.z * tx - q.x * tz,
    z: value.z + q.w * tz + q.x * ty - q.y * tx };
}

/** One consistent bridge scales BOTH translation and local model dimensions. */
export function cameraPoseToWorld(pose, cameraPosition, cameraQuaternion, sceneUnitsPerCanonicalMetre) {
  if (!finiteVector(pose?.position) || !finiteVector(cameraPosition) ||
      !(Number.isFinite(sceneUnitsPerCanonicalMetre) && sceneUnitsPerCanonicalMetre > 0)) return null;
  const translated = rotateVector(pose.position, cameraQuaternion);
  const quaternion = multiplyQuaternions(cameraQuaternion, pose.quaternion);
  if (!translated || !quaternion) return null;
  return { position: { x: cameraPosition.x + translated.x * sceneUnitsPerCanonicalMetre,
    y: cameraPosition.y + translated.y * sceneUnitsPerCanonicalMetre,
    z: cameraPosition.z + translated.z * sceneUnitsPerCanonicalMetre },
    quaternion, scale: sceneUnitsPerCanonicalMetre };
}

/** Undo the same bridge using the CURRENT camera, not the capture-time camera. */
export function worldPoseToCamera(pose, cameraPosition, cameraQuaternion) {
  const q = normalizeQuaternion(cameraQuaternion);
  if (!finiteVector(pose?.position) || !finiteVector(cameraPosition) || !q ||
      !(Number.isFinite(pose.scale) && pose.scale > 0)) return null;
  const inverse = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
  const position = rotateVector({ x: (pose.position.x - cameraPosition.x) / pose.scale,
    y: (pose.position.y - cameraPosition.y) / pose.scale,
    z: (pose.position.z - cameraPosition.z) / pose.scale }, inverse);
  const quaternion = multiplyQuaternions(inverse, pose.quaternion);
  return position && quaternion ? { position, quaternion, scale: 1 } : null;
}

function blendWorldPoses(a, b, alpha) {
  if (!a || alpha >= 1) return clonePose(b);
  // This blends world-anchor correction ONLY. Current camera motion is never
  // blended: the renderer consumes the engine's current camera each frame.
  const qa = a.quaternion, qb = b.quaternion;
  const sign = qa.x * qb.x + qa.y * qb.y + qa.z * qb.z + qa.w * qb.w < 0 ? -1 : 1;
  const quaternion = normalizeQuaternion({ x: qa.x * (1 - alpha) + qb.x * sign * alpha,
    y: qa.y * (1 - alpha) + qb.y * sign * alpha,
    z: qa.z * (1 - alpha) + qb.z * sign * alpha,
    w: qa.w * (1 - alpha) + qb.w * sign * alpha });
  return { position: { x: a.position.x + (b.position.x - a.position.x) * alpha,
    y: a.position.y + (b.position.y - a.position.y) * alpha,
    z: a.position.z + (b.position.z - a.position.z) * alpha },
    quaternion, scale: a.scale + (b.scale - a.scale) * alpha };
}

/**
 * Pure tracking state for the public, synthetic box comparison.
 *
 * createTrackingLabCore({mode:'paper'|'hybrid'|'slam', now, ...options})
 * updateCamera({generation,capturedAt,cameraPosition,cameraQuaternion,worldTrackingNormal})
 * observe({...same capture packet, pose:{position,quaternion},
 *          quality:{valid:true,count,rmsPixels}})
 * sample(time=now()) / snapshot() -> an independent serializable snapshot.
 * reset({generation?,reason?}) / setMode(mode) -> reset snapshot.
 * needsPaperObservation() -> boolean; generation is a read-only getter.
 *
 * Capture timestamps are monotonic milliseconds. Caller generations identify
 * camera/session/viewport/origin changes and must be attached before work is
 * posted. Do not retag an old worker result with the current generation.
 *
 * paper: latest camera-space measurement, no SLAM prediction or world hold.
 * hybrid: camera-space until scale is motion-verified; then marker-corrected
 * world anchor plus SLAM between measurements/outside the card view.
 * slam: motion-calibrate and place once using the same card, then stop all
 * point observations. It cannot start world tracking on an unverified scale.
 *
 * Bridge calibration assumes the PAPER IS STATIONARY while the camera moves.
 * Pure rotation has no scale information; coordinated paper/camera motion is
 * monocularly ambiguous. An image-size hint is never treated as calibration.
 */
export function createTrackingLabCore(options = {}) {
  let mode = options.mode ?? 'paper';
  if (!TRACKING_LAB_MODES.includes(mode)) throw new TypeError('Unknown TrackingLab mode');
  const now = options.now ?? (() => performance.now());
  const settings = {
    // Never call a 500 ms old point pose a current measurement, even if a
    // caller asks for a longer timeout. SLAM prediction is separately labelled.
    maxObservationAgeMs: Math.min(500, Math.max(1, options.maxObservationAgeMs ?? 450)),
    maxCameraAgeMs: Math.min(500, Math.max(1, options.maxCameraAgeMs ?? 250)),
    futureToleranceMs: Math.max(0, options.futureToleranceMs ?? 20),
    minPoints: Math.max(4, options.minPoints ?? 6),
    maxRmsPixels: Math.max(0.1, options.maxRmsPixels ?? 4),
    minCalibrationConfidence: Math.max(0, Math.min(1, options.minCalibrationConfidence ?? 0.5)),
    correctionAlpha: Math.max(0.01, Math.min(1, options.correctionAlpha ?? 1))
  };
  if (!Object.values(settings).every(Number.isFinite)) throw new TypeError('TrackingLab settings must be finite');
  const calibrationService = createCardPointScale();
  let generation = 0, camera = null, observation = null, worldAnchor = null;
  let calibration = calibrationService.reset(), placed = false;
  let worldBrokenAt = -Infinity, lastObservedAt = -Infinity, lastReason = 'initial';
  let acceptedObservations = 0, rejectedObservations = 0, rejectedCameras = 0;

  const isFresh = (capturedAt, time, limit) => Number.isFinite(capturedAt) && Number.isFinite(time) &&
    time - capturedAt >= -settings.futureToleranceMs && time - capturedAt < limit;
  const calibrated = () => calibration.calibrated && calibration.source === 'motion' &&
    calibration.calibrationConfidence >= settings.minCalibrationConfidence &&
    calibration.sampleCount >= 4 && calibration.pairCount >= 3 &&
    Number.isFinite(calibration.scale) && calibration.scale > 0;
  const needsPaperObservation = () => mode !== 'slam' || !placed;

  function invalidateWorld(at, reason) {
    calibration = calibrationService.reset();
    worldAnchor = null; placed = false; worldBrokenAt = at; lastReason = reason;
  }

  function sample(time = now()) {
    const observationAge = observation ? Math.max(0, time - observation.capturedAt) : null;
    const cameraAge = camera ? Math.max(0, time - camera.capturedAt) : null;
    const observationFresh = observation && isFresh(observation.capturedAt, time, settings.maxObservationAgeMs);
    const cameraFresh = camera && isFresh(camera.capturedAt, time, settings.maxCameraAgeMs);
    const bridgeVerified = calibrated();
    const worldUsable = worldAnchor && bridgeVerified && cameraFresh && camera.worldTrackingNormal;
    let pose = null, cameraPose = null, poseSpace = null, status = 'searching';
    if (mode !== 'paper' && worldUsable) {
      pose = clonePose(worldAnchor); poseSpace = 'world';
      cameraPose = worldPoseToCamera(pose, camera.cameraPosition, camera.cameraQuaternion);
      status = mode === 'slam' ? 'engine-only' : observationFresh && observation.worldApplied ?
        'marker-corrected' : 'world-predicted';
    } else if (mode !== 'slam' && observationFresh) {
      pose = clonePose(observation.pose); cameraPose = clonePose(pose); poseSpace = 'camera';
      status = mode === 'paper' ? 'paper-measured' : cameraFresh && camera.worldTrackingNormal ?
        'paper-unscaled' : 'paper-limited';
    } else if (observation) {
      status = mode === 'paper' ? 'paper-lost' : cameraFresh && camera.worldTrackingNormal ?
        'calibrating' : 'engine-limited';
    }
    return { generation, mode, status, visible: Boolean(pose), poseSpace, pose, cameraPose,
      observationFresh: Boolean(observationFresh), observationAgeMs: observationAge,
      cameraFresh: Boolean(cameraFresh), cameraAgeMs: cameraAge,
      worldTrackingNormal: Boolean(cameraFresh && camera.worldTrackingNormal),
      calibration: { ...calibration, calibrated: Boolean(bridgeVerified),
        sceneUnitsPerCanonicalMetre: bridgeVerified ? calibration.scale : null },
      canonicalCardMetres: { ...CANONICAL_CARD_METRES },
      unitBasis: 'canonical-card-metres-not-physical-print-metres',
      needsPaperObservation: needsPaperObservation(),
      quality: observation ? { ...observation.quality } : null,
      diagnostic: { lastReason, acceptedObservations, rejectedObservations, rejectedCameras } };
  }

  function reject(kind, reason) {
    lastReason = reason;
    if (kind === 'camera') rejectedCameras++; else rejectedObservations++;
    return { accepted: false, reason, snapshot: sample() };
  }

  function validateCamera(frame) {
    if (frame?.generation !== generation) return 'stale-generation';
    if (!Number.isFinite(frame.capturedAt)) return 'invalid-timestamp';
    if (!finiteVector(frame.cameraPosition) || !normalizeQuaternion(frame.cameraQuaternion)) return 'invalid-camera';
    return null;
  }

  function updateCamera(frame) {
    const invalid = validateCamera(frame);
    if (invalid) return reject('camera', invalid);
    if (!isFresh(frame.capturedAt, now(), settings.maxCameraAgeMs)) return reject('camera', 'stale-camera');
    if (camera && frame.capturedAt < camera.capturedAt) return reject('camera', 'out-of-order-camera');
    const healthy = frame.worldTrackingNormal === true;
    // No old world pose or scale bridge is revived by a later NORMAL status.
    // The caller should also reset the generation for known origin changes.
    if (camera?.worldTrackingNormal && !healthy) invalidateWorld(frame.capturedAt, 'world-continuity-lost');
    camera = { cameraPosition: cloneVector(frame.cameraPosition),
      cameraQuaternion: normalizeQuaternion(frame.cameraQuaternion),
      capturedAt: frame.capturedAt, worldTrackingNormal: healthy };
    return { accepted: true, reason: 'camera-updated', snapshot: sample() };
  }

  function observe(frame) {
    const invalid = validateCamera(frame);
    if (invalid) return reject('observation', invalid);
    if (!needsPaperObservation()) return reject('observation', 'engine-only-observations-stopped');
    if (!isFresh(frame.capturedAt, now(), settings.maxObservationAgeMs)) return reject('observation', 'stale-observation');
    if (frame.capturedAt <= lastObservedAt) return reject('observation', 'out-of-order-observation');
    if (frame.capturedAt < worldBrokenAt) return reject('observation', 'world-continuity-lost');
    const q = normalizeQuaternion(frame.pose?.quaternion), quality = frame.quality;
    if (!finiteVector(frame.pose?.position) || frame.pose.position.z >= -1e-8 || !q) return reject('observation', 'invalid-paper-pose');
    if (quality?.valid !== true || !Number.isFinite(quality.count) || quality.count < settings.minPoints ||
        !Number.isFinite(quality.rmsPixels) || quality.rmsPixels < 0 || quality.rmsPixels > settings.maxRmsPixels)
      return reject('observation', 'poor-observation-quality');
    lastObservedAt = frame.capturedAt;
    observation = { capturedAt: frame.capturedAt,
      pose: { position: cloneVector(frame.pose.position), quaternion: q, scale: 1 },
      quality: { count: quality.count, rmsPixels: quality.rmsPixels }, worldApplied: false };
    acceptedObservations++;
    // Do not replace a more recent live camera with this worker's capture pose.
    if (!camera || frame.capturedAt >= camera.capturedAt) updateCamera(frame);
    if (mode !== 'paper' && frame.worldTrackingNormal === true &&
        camera?.worldTrackingNormal && frame.capturedAt >= worldBrokenAt) {
      // Deliberately never pass scaleHint: source must be translation verified.
      calibration = calibrationService.observe({ capturedAt: frame.capturedAt,
        cameraPosition: frame.cameraPosition, cameraQuaternion: frame.cameraQuaternion,
        position: frame.pose.position });
      if (calibrated()) {
        const measured = cameraPoseToWorld(observation.pose, frame.cameraPosition,
          frame.cameraQuaternion, calibration.scale);
        worldAnchor = blendWorldPoses(worldAnchor, measured, settings.correctionAlpha);
        observation.worldApplied = true;
        if (mode === 'slam') placed = true;
      }
    }
    lastReason = 'measured';
    return { accepted: true, reason: 'measured', snapshot: sample() };
  }

  function reset({ generation: nextGeneration = generation + 1, reason = 'reset' } = {}) {
    if (!Number.isSafeInteger(nextGeneration) || nextGeneration <= generation)
      throw new TypeError('A reset must advance the TrackingLab generation');
    generation = nextGeneration; camera = null; observation = null; worldAnchor = null;
    calibration = calibrationService.reset(); placed = false;
    worldBrokenAt = -Infinity; lastObservedAt = -Infinity; lastReason = String(reason);
    acceptedObservations = 0; rejectedObservations = 0; rejectedCameras = 0;
    return sample();
  }

  function setMode(nextMode) {
    if (!TRACKING_LAB_MODES.includes(nextMode)) throw new TypeError('Unknown TrackingLab mode');
    if (nextMode === mode) return sample();
    mode = nextMode;
    return reset({ reason: 'mode-changed' });
  }

  return { observe, updateCamera, sample, snapshot: () => sample(), reset, setMode,
    needsPaperObservation, get generation() { return generation; } };
}
