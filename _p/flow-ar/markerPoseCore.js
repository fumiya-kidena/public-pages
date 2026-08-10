const finitePositive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

/**
 * Recover the physical dimensions of the cropped planar target.
 *
 * buildWorldTarget.py records dimensions before its aspect-preserving resize.
 * For the rotated FLOW AR poster, originalHeight is the printed poster width,
 * whose physical value is anchor.physicalWidthCm. The runtime rotates that
 * target back into poster orientation, so its event width/height are swapped.
 */
export function targetPhysicalSize(properties, posterPhysicalWidthCm) {
  if (!properties || typeof properties !== "object") return null;
  const posterWidthMetres = finitePositive(posterPhysicalWidthCm);
  const targetWidthPixel = finitePositive(properties.width);
  const targetHeightPixel = finitePositive(properties.height);
  const originalWidthPixel = finitePositive(properties.originalWidth);
  const originalHeightPixel = finitePositive(properties.originalHeight);
  if (!posterWidthMetres || !targetWidthPixel || !targetHeightPixel
    || !originalWidthPixel || !originalHeightPixel) return null;

  const posterWidthPixel = properties.isRotated === true
    ? originalHeightPixel
    : originalWidthPixel;
  const metrePerPixel = (posterWidthMetres / 100) / posterWidthPixel;
  const widthMetres = (properties.isRotated === true
    ? targetHeightPixel
    : targetWidthPixel) * metrePerPixel;
  const heightMetres = (properties.isRotated === true
    ? targetWidthPixel
    : targetHeightPixel) * metrePerPixel;
  if (![widthMetres, heightMetres].every(Number.isFinite)
    || widthMetres <= 0 || heightMetres <= 0) return null;
  return { widthMetres, heightMetres };
}

/**
 * Convert the image-target-local scale into the SI world scale used by the
 * model. Official image-target events define physical target extent as
 * scaledWidth/scaledHeight multiplied by scale. Dividing that observed extent
 * by the printed target extent keeps metre-authored content at metre scale.
 */
export function calibratedWorldScale(detail, targetSize) {
  if (!targetSize) return null;
  const markerScale = finitePositive(detail?.scale);
  const scaledWidth = finitePositive(detail?.scaledWidth);
  const scaledHeight = finitePositive(detail?.scaledHeight);
  const targetLongAxis = Math.max(
    finitePositive(targetSize.widthMetres) || 0,
    finitePositive(targetSize.heightMetres) || 0
  );
  if (!markerScale || !targetLongAxis) return null;

  // XR8 defines detail.scale as the detected target's longest extent. This
  // orientation-independent ratio remains valid when an Android runtime omits
  // scaledWidth/scaledHeight or reports them in the opposite screen rotation.
  const longAxisRatio = markerScale / targetLongAxis;
  if (!scaledWidth || !scaledHeight) return longAxisRatio;

  const widthRatio = markerScale * scaledWidth / targetSize.widthMetres;
  const heightRatio = markerScale * scaledHeight / targetSize.heightMetres;
  if (![widthRatio, heightRatio].every(Number.isFinite)
    || widthRatio <= 0 || heightRatio <= 0) return null;

  // Prefer both axes when they agree. Some Android/browser combinations swap
  // them after orientation changes; falling back to the documented long-axis
  // scale is safer than rejecting every marker pose and hiding the model.
  const axisDisagreement = Math.abs(Math.log(widthRatio / heightRatio));
  if (axisDisagreement > 0.08) return longAxisRatio;
  const result = Math.sqrt(widthRatio * heightRatio);

  // In responsive world tracking this is intentionally not expected to be
  // near one: it is the conversion from SI-authored metres to scene units.
  return Number.isFinite(result) && result > 0 ? result : null;
}

export function stableMeanScale(samples, maximumRelativeSpread) {
  if (!Array.isArray(samples) || !samples.length) return null;
  const spreadLimit = finitePositive(maximumRelativeSpread);
  if (!spreadLimit) return null;
  const calibrationState = samples[0]?.scaleCalibrated === true;
  if (samples.some((sample) => (sample?.scaleCalibrated === true) !== calibrationState)) {
    return null;
  }
  const values = samples.map((sample) => finitePositive(sample?.scale));
  if (values.some((value) => value === null)) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const spread = Math.max(...values.map((value) => Math.abs(value - mean) / mean));
  return spread <= spreadLimit ? mean : null;
}

export function maySampleInitialPose(trackingStatus, poseLocked, landscapeBlocked) {
  return trackingStatus === "NORMAL" && !poseLocked && !landscapeBlocked;
}

export function sceneDistanceMetres(sceneDistance, worldUnitsPerMetre) {
  const distance = Number(sceneDistance);
  const scale = finitePositive(worldUnitsPerMetre);
  if (!Number.isFinite(distance) || distance < 0 || !scale) return null;
  return distance / scale;
}

/**
 * Stability-first poster tracking for low-end devices.
 *
 * Image-target events can arrive faster than a low-end tablet can render and
 * their small pose innovations are mostly detector noise. Limit pose work to
 * about 10 Hz, hold innovations inside a perceptual deadband, then shorten the
 * EMA time constant only when the camera is moving deliberately. A hard step
 * cap prevents a single bad detection from throwing the model across the
 * screen.
 */
export const stablePosterPoseProfile = Object.freeze({
  minimumIntervalMs: 100,
  maximumElapsedMs: 300,
  acquisitionSampleCount: 3,
  acquisitionDurationMs: 180,
  position: Object.freeze({
    deadband: 0.0015,
    activeRange: 0.03,
    quietTimeConstantMs: 1100,
    activeTimeConstantMs: 400,
    maximumStep: 0.005
  }),
  rotation: Object.freeze({
    deadband: 0.2 * Math.PI / 180,
    activeRange: 8 * Math.PI / 180,
    quietTimeConstantMs: 1000,
    activeTimeConstantMs: 350,
    maximumStep: 0.25 * Math.PI / 180
  }),
  scale: Object.freeze({
    deadband: 0.005,
    activeRange: 0.05,
    quietTimeConstantMs: 1400,
    activeTimeConstantMs: 500,
    maximumStep: 0.004
  })
});

function adaptiveInnovationStep(distance, elapsedMs, axis) {
  if (!Number.isFinite(distance) || distance < 0) return null;
  const deadband = Number(axis?.deadband);
  const activeRange = Number(axis?.activeRange);
  const quietTau = Number(axis?.quietTimeConstantMs);
  const activeTau = Number(axis?.activeTimeConstantMs);
  const maximumStep = Number(axis?.maximumStep);
  if (![deadband, activeRange, quietTau, activeTau, maximumStep].every(Number.isFinite)
    || deadband < 0 || activeRange <= deadband || quietTau <= 0
    || activeTau <= 0 || maximumStep <= 0) return null;
  if (distance <= deadband) return 0;

  const activity = Math.min(1, Math.max(
    0,
    (distance - deadband) / (activeRange - deadband)
  ));
  // Geometric interpolation avoids an abrupt response change near the
  // deadband while still reaching the active time constant for real motion.
  const timeConstantMs = quietTau * ((activeTau / quietTau) ** activity);
  const alpha = 1 - Math.exp(-elapsedMs / timeConstantMs);
  return Math.min(maximumStep, (distance - deadband) * alpha);
}

export function stablePosterPoseStep({
  elapsedMs,
  positionDistanceMetres,
  rotationDistanceRadians,
  scaleDifferenceFraction,
  profile = stablePosterPoseProfile
}) {
  const elapsed = Number(elapsedMs);
  const minimumIntervalMs = Number(profile?.minimumIntervalMs);
  const maximumElapsedMs = Number(profile?.maximumElapsedMs);
  if (![elapsed, minimumIntervalMs, maximumElapsedMs].every(Number.isFinite)
    || elapsed < minimumIntervalMs || minimumIntervalMs < 0
    || maximumElapsedMs < minimumIntervalMs) {
    return {
      accepted: false,
      positionStepMetres: 0,
      rotationStepRadians: 0,
      scaleStepFraction: 0
    };
  }

  const boundedElapsed = Math.min(elapsed, maximumElapsedMs);
  const positionStepMetres = adaptiveInnovationStep(
    Number(positionDistanceMetres),
    boundedElapsed,
    profile.position
  );
  const rotationStepRadians = adaptiveInnovationStep(
    Number(rotationDistanceRadians),
    boundedElapsed,
    profile.rotation
  );
  const scaleStepFraction = adaptiveInnovationStep(
    Number(scaleDifferenceFraction),
    boundedElapsed,
    profile.scale
  );
  if ([positionStepMetres, rotationStepRadians, scaleStepFraction]
    .some((value) => value === null)) {
    return {
      accepted: false,
      positionStepMetres: 0,
      rotationStepRadians: 0,
      scaleStepFraction: 0
    };
  }
  return {
    accepted: true,
    positionStepMetres,
    rotationStepRadians,
    scaleStepFraction
  };
}

export function mayAcceptTimedPoseSample({
  now,
  previousSampleAt,
  trackingNormalSince,
  minimumSampleIntervalMs,
  trackingWarmupMs
}) {
  if (trackingNormalSince === null || trackingNormalSince === undefined) return false;
  const currentTime = Number(now);
  const previousTime = Number(previousSampleAt);
  const normalSince = Number(trackingNormalSince);
  const sampleInterval = Number(minimumSampleIntervalMs);
  const warmup = Number(trackingWarmupMs);
  if (![currentTime, normalSince, sampleInterval, warmup].every(Number.isFinite)
    || sampleInterval < 0 || warmup < 0) return false;
  if (currentTime - normalSince < warmup) return false;
  return !Number.isFinite(previousTime) || currentTime - previousTime >= sampleInterval;
}

export function poseWindowReady(samples, minimumCount, minimumDurationMs) {
  if (!Array.isArray(samples)) return false;
  const count = Math.max(1, Math.round(Number(minimumCount)));
  const duration = Number(minimumDurationMs);
  if (!Number.isFinite(count) || !Number.isFinite(duration) || duration < 0) return false;
  if (samples.length < count) return false;
  const first = Number(samples[samples.length - count]?.capturedAt);
  const last = Number(samples[samples.length - 1]?.capturedAt);
  return Number.isFinite(first) && Number.isFinite(last)
    && last >= first && last - first >= duration;
}
