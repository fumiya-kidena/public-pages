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
  // Low-end Android image-target callbacks can be 350--500 ms apart. Keep the
  // acquisition window alive across that cadence, but discard a genuinely
  // stale detection episode.
  acquisitionMaximumSampleGapMs: 1600,
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

/**
 * Marker-to-world correction after the initial hand-off.
 *
 * The SLAM map keeps evolving while the camera moves. When the printed poster
 * re-enters view, use it as a metric reference without returning to noisy
 * frame-by-frame marker tracking. A larger innovation needs two independent
 * longer windows, and an implausible innovation is ignored entirely.
 * This profile is intentionally shared by iPhone and Android.
 */
export const worldMarkerCorrectionProfile = Object.freeze({
  sampleIntervalMs: 100,
  maximumSampleGapMs: 1600,
  trackingWarmupMs: 250,
  sampleCount: 4,
  minimumDurationMs: 300,
  extendedSampleCount: 4,
  extendedMinimumDurationMs: 300,
  stability: Object.freeze({
    positionMetres: 0.008,
    rotationRadians: 1.5 * Math.PI / 180,
    scaleFraction: 0.02
  }),
  extendedInnovation: Object.freeze({
    positionMetres: 0.03,
    rotationRadians: 3 * Math.PI / 180,
    scaleFraction: 0.04
  }),
  maximumInnovation: Object.freeze({
    positionMetres: 0.5,
    rotationRadians: 70 * Math.PI / 180,
    scaleFraction: 0.5
  }),
  // A SLAM relocalization can legitimately move the complete world frame much
  // farther than an ordinary image-target correction. It still needs two
  // independent stable windows before this wider gate is used.
  relocalizationMaximumInnovation: Object.freeze({
    positionMetres: 2,
    rotationRadians: 170 * Math.PI / 180,
    scaleFraction: 1.5
  }),
  confirmation: Object.freeze({
    // Four sparse samples and the next independent window can legitimately
    // span several seconds on a low-end tablet.
    maximumPendingAgeMs: 10000,
    positionMetres: 0.015,
    rotationRadians: 2.5 * Math.PI / 180,
    scaleFraction: 0.03
  }),
  transition: Object.freeze({
    minorDurationMs: 260,
    majorDurationMs: 800,
    maximumFrameGapMs: 1000,
    positionDeadbandMetres: 0.003,
    rotationDeadbandRadians: 0.2 * Math.PI / 180,
    scaleDeadbandFraction: 0.008
  }),
  // The complete image target already contains the asymmetric left/right
  // print. Average only its local +X direction in a dedicated channel so
  // plane-normal noise cannot leave the flow direction diagonally biased.
  // This channel never authorises a position, plane-normal or scale change.
  direction: Object.freeze({
    sampleCount: 4,
    minimumDurationMs: 300,
    stabilityRadians: 0.75 * Math.PI / 180,
    maximumNormalSpreadRadians: 2.5 * Math.PI / 180,
    maximumNormalDifferenceRadians: 5 * Math.PI / 180,
    maximumInnovationRadians: 8 * Math.PI / 180,
    maximumPositionInnovationMetres: 0.03,
    maximumScaleInnovationFraction: 0.04,
    positionSpreadMetres: 0.008,
    scaleSpreadFraction: 0.02,
    deadbandRadians: 0.2 * Math.PI / 180,
    transitionDurationMs: 220
  }),
  step: Object.freeze({
    minimumIntervalMs: 250,
    maximumElapsedMs: 600,
    position: Object.freeze({
      deadband: 0.004,
      activeRange: 0.08,
      quietTimeConstantMs: 1800,
      activeTimeConstantMs: 700,
      maximumStep: 0.003
    }),
    rotation: Object.freeze({
      deadband: 0.5 * Math.PI / 180,
      activeRange: 15 * Math.PI / 180,
      quietTimeConstantMs: 1800,
      activeTimeConstantMs: 650,
      maximumStep: 0.3 * Math.PI / 180
    }),
    scale: Object.freeze({
      deadband: 0.01,
      activeRange: 0.06,
      quietTimeConstantMs: 2200,
      activeTimeConstantMs: 900,
      maximumStep: 0.002
    })
  })
});

export const markerObservationQualityProfile = Object.freeze({
  initial: Object.freeze({
    maximumViewAngleRadians: 70 * Math.PI / 180,
    minimumProjectedSpan: 0.07
  }),
  correction: Object.freeze({
    maximumViewAngleRadians: 60 * Math.PI / 180,
    minimumProjectedSpan: 0.1
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

function rejectedMarkerCorrection() {
  return {
    accepted: false,
    positionStepMetres: 0,
    rotationStepRadians: 0,
    scaleStepFraction: 0
  };
}

function nonNegativeMetric(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function finiteQuaternion(value) {
  const quaternion = {
    x: Number(value?.x),
    y: Number(value?.y),
    z: Number(value?.z),
    w: Number(value?.w)
  };
  if (!Object.values(quaternion).every(Number.isFinite)) return null;
  const length = Math.hypot(
    quaternion.x,
    quaternion.y,
    quaternion.z,
    quaternion.w
  );
  if (!Number.isFinite(length) || length < 1e-10) return null;
  return {
    x: quaternion.x / length,
    y: quaternion.y / length,
    z: quaternion.z / length,
    w: quaternion.w / length
  };
}

function finiteVector(value) {
  const vector = {
    x: Number(value?.x),
    y: Number(value?.y),
    z: Number(value?.z)
  };
  return Object.values(vector).every(Number.isFinite) ? vector : null;
}

function vectorDot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function vectorCross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function normalisedVector(value) {
  const vector = finiteVector(value);
  if (!vector) return null;
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (!Number.isFinite(length) || length < 1e-10) return null;
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length
  };
}

function quaternionDot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

function quaternionProduct(a, b) {
  return finiteQuaternion({
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  });
}

function rotateVectorByQuaternion(vector, quaternion) {
  const q = finiteQuaternion(quaternion);
  const v = finiteVector(vector);
  if (!q || !v) return null;
  const qVector = { x: q.x, y: q.y, z: q.z };
  const twiceCross = vectorCross(qVector, v);
  twiceCross.x *= 2;
  twiceCross.y *= 2;
  twiceCross.z *= 2;
  const secondCross = vectorCross(qVector, twiceCross);
  return {
    x: v.x + q.w * twiceCross.x + secondCross.x,
    y: v.y + q.w * twiceCross.y + secondCross.y,
    z: v.z + q.w * twiceCross.z + secondCross.z
  };
}

function clampedUnit(value) {
  return Math.min(1, Math.max(-1, value));
}

function wrappedRadians(value) {
  if (!Number.isFinite(value)) return null;
  let wrapped = (value + Math.PI) % (2 * Math.PI);
  if (wrapped < 0) wrapped += 2 * Math.PI;
  return wrapped - Math.PI;
}

function axisAngleQuaternion(axis, angle) {
  const unitAxis = normalisedVector(axis);
  if (!unitAxis || !Number.isFinite(angle)) return null;
  const halfAngle = angle / 2;
  const sine = Math.sin(halfAngle);
  return finiteQuaternion({
    x: unitAxis.x * sine,
    y: unitAxis.y * sine,
    z: unitAxis.z * sine,
    w: Math.cos(halfAngle)
  });
}

/**
 * Estimate the printed card's absolute left/right direction from a stable
 * image-target window.
 *
 * Relative rotations are expressed in target-local coordinates before the
 * local-Z twist is extracted. This keeps the estimate independent of whether
 * the card is horizontal, vertical or arbitrarily tilted. Quaternion signs are
 * aligned to the first sample, then the heading is circularly averaged.
 */
export function stableMarkerDirectionEstimate(
  samples,
  profile = worldMarkerCorrectionProfile.direction
) {
  if (!Array.isArray(samples)) return null;
  const count = Math.round(Number(profile?.sampleCount));
  const minimumDurationMs = Number(profile?.minimumDurationMs);
  const stabilityRadians = nonNegativeMetric(profile?.stabilityRadians);
  const maximumNormalSpreadRadians = nonNegativeMetric(
    profile?.maximumNormalSpreadRadians
  );
  if (!Number.isFinite(count) || count < 2
    || !Number.isFinite(minimumDurationMs) || minimumDurationMs < 0
    || stabilityRadians === null || maximumNormalSpreadRadians === null) return null;
  const window = samples.slice(-count);
  if (!poseWindowReady(window, count, minimumDurationMs)) return null;

  const quaternion = window.map((sample) => finiteQuaternion(sample?.quaternion));
  if (quaternion.some((value) => !value)) return null;
  const reference = quaternion[0];
  for (let index = 1; index < quaternion.length; index += 1) {
    if (quaternionDot(reference, quaternion[index]) < 0) {
      quaternion[index] = {
        x: -quaternion[index].x,
        y: -quaternion[index].y,
        z: -quaternion[index].z,
        w: -quaternion[index].w
      };
    }
  }

  const normal = quaternion.map((value) => rotateVectorByQuaternion(
    { x: 0, y: 0, z: 1 },
    value
  ));
  const meanNormal = normalisedVector(normal.reduce((sum, value) => ({
    x: sum.x + value.x,
    y: sum.y + value.y,
    z: sum.z + value.z
  }), { x: 0, y: 0, z: 0 }));
  if (!meanNormal) return null;
  const normalSpreadRadians = Math.max(...normal.map((value) => Math.acos(
    clampedUnit(vectorDot(value, meanNormal))
  )));
  if (!Number.isFinite(normalSpreadRadians)
    || normalSpreadRadians > maximumNormalSpreadRadians) return null;

  const inverseReference = {
    x: -reference.x,
    y: -reference.y,
    z: -reference.z,
    w: reference.w
  };
  const relativeHeading = quaternion.map((value) => {
    const relative = quaternionProduct(inverseReference, value);
    if (!relative) return null;
    const twistLength = Math.hypot(relative.z, relative.w);
    if (!Number.isFinite(twistLength) || twistLength < 1e-10) return null;
    return wrappedRadians(2 * Math.atan2(
      relative.z / twistLength,
      relative.w / twistLength
    ));
  });
  if (relativeHeading.some((value) => value === null)) return null;
  const sineMean = relativeHeading.reduce((sum, value) => sum + Math.sin(value), 0);
  const cosineMean = relativeHeading.reduce((sum, value) => sum + Math.cos(value), 0);
  if (Math.hypot(sineMean, cosineMean) < 1e-8) return null;
  const meanHeadingRadians = Math.atan2(sineMean, cosineMean);
  const headingSpreadRadians = Math.max(...relativeHeading.map((value) => Math.abs(
    wrappedRadians(value - meanHeadingRadians)
  )));
  if (!Number.isFinite(headingSpreadRadians)
    || headingSpreadRadians > stabilityRadians) return null;

  const meanTwist = axisAngleQuaternion(
    { x: 0, y: 0, z: 1 },
    meanHeadingRadians
  );
  const meanQuaternion = quaternionProduct(reference, meanTwist);
  let direction = rotateVectorByQuaternion({ x: 1, y: 0, z: 0 }, meanQuaternion);
  if (!direction) return null;
  const alongNormal = vectorDot(direction, meanNormal);
  direction = normalisedVector({
    x: direction.x - alongNormal * meanNormal.x,
    y: direction.y - alongNormal * meanNormal.y,
    z: direction.z - alongNormal * meanNormal.z
  });
  if (!direction) return null;

  return {
    direction,
    normal: meanNormal,
    headingSpreadRadians,
    normalSpreadRadians,
    sampleCount: count,
    capturedAt: Number(window[window.length - 1]?.capturedAt)
  };
}

/**
 * Rotate only around the current card normal until local +X matches the
 * observed printed-card direction. Position, scale and plane normal remain
 * unchanged. The delta is pre-multiplied because its axis is world-space.
 */
export function markerDirectionCorrection({
  currentQuaternion,
  observedDirection,
  observedNormal,
  profile = worldMarkerCorrectionProfile.direction
}) {
  const current = finiteQuaternion(currentQuaternion);
  const direction = normalisedVector(observedDirection);
  const markerNormal = normalisedVector(observedNormal);
  const maximumNormalDifferenceRadians = nonNegativeMetric(
    profile?.maximumNormalDifferenceRadians
  );
  const maximumInnovationRadians = nonNegativeMetric(profile?.maximumInnovationRadians);
  const deadbandRadians = nonNegativeMetric(profile?.deadbandRadians);
  const transitionDurationMs = nonNegativeMetric(profile?.transitionDurationMs);
  if (!current || !direction || !markerNormal
    || maximumNormalDifferenceRadians === null
    || maximumInnovationRadians === null
    || deadbandRadians === null || transitionDurationMs === null) return null;

  const currentNormal = rotateVectorByQuaternion({ x: 0, y: 0, z: 1 }, current);
  const currentDirection = rotateVectorByQuaternion({ x: 1, y: 0, z: 0 }, current);
  if (!currentNormal || !currentDirection) return null;
  const normalDifferenceRadians = Math.acos(clampedUnit(
    vectorDot(currentNormal, markerNormal)
  ));
  if (!Number.isFinite(normalDifferenceRadians)
    || normalDifferenceRadians > maximumNormalDifferenceRadians) return null;

  const alongNormal = vectorDot(direction, currentNormal);
  const projectedDirection = normalisedVector({
    x: direction.x - alongNormal * currentNormal.x,
    y: direction.y - alongNormal * currentNormal.y,
    z: direction.z - alongNormal * currentNormal.z
  });
  if (!projectedDirection) return null;
  const sine = vectorDot(
    currentNormal,
    vectorCross(currentDirection, projectedDirection)
  );
  const cosine = clampedUnit(vectorDot(currentDirection, projectedDirection));
  const signedRadians = wrappedRadians(Math.atan2(sine, cosine));
  if (signedRadians === null) return null;
  const distanceRadians = Math.abs(signedRadians);
  if (distanceRadians > maximumInnovationRadians) return null;

  const worldDelta = axisAngleQuaternion(currentNormal, signedRadians);
  const quaternion = quaternionProduct(worldDelta, current);
  if (!quaternion) return null;
  return {
    quaternion,
    signedRadians,
    distanceRadians,
    normalDifferenceRadians,
    required: distanceRadians > deadbandRadians,
    durationMs: distanceRadians > deadbandRadians ? transitionDurationMs : 0
  };
}

export function markerAcquisitionSamplingDecision({
  now,
  previousSampleAt,
  profile = stablePosterPoseProfile
}) {
  const currentTime = Number(now);
  const previousTime = Number(previousSampleAt);
  const minimumIntervalMs = Number(profile?.minimumIntervalMs);
  const maximumSampleGapMs = Number(profile?.acquisitionMaximumSampleGapMs);
  if (![currentTime, minimumIntervalMs, maximumSampleGapMs].every(Number.isFinite)
    || minimumIntervalMs < 0 || maximumSampleGapMs < minimumIntervalMs) {
    return { accepted: false, resetWindow: false, reason: "invalid" };
  }
  if (!Number.isFinite(previousTime)) {
    return { accepted: true, resetWindow: false, reason: "first" };
  }
  const elapsedMs = currentTime - previousTime;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return { accepted: false, resetWindow: true, reason: "non-monotonic" };
  }
  if (elapsedMs > maximumSampleGapMs) {
    return { accepted: true, resetWindow: true, reason: "gap" };
  }
  if (elapsedMs < minimumIntervalMs) {
    return { accepted: false, resetWindow: false, reason: "cadence" };
  }
  return { accepted: true, resetWindow: false, reason: "cadence" };
}

export function markerObservationQualityDecision({
  phase = "correction",
  trackingStatus,
  viewAngleRadians,
  projectedMinimumSpan,
  profile = markerObservationQualityProfile
}) {
  if (trackingStatus !== "NORMAL") {
    return { accepted: false, reason: "tracking" };
  }
  const limit = profile?.[phase];
  const angle = nonNegativeMetric(viewAngleRadians);
  const span = nonNegativeMetric(projectedMinimumSpan);
  const maximumAngle = nonNegativeMetric(limit?.maximumViewAngleRadians);
  const minimumSpan = nonNegativeMetric(limit?.minimumProjectedSpan);
  if (angle === null || span === null || maximumAngle === null || minimumSpan === null) {
    return { accepted: false, reason: "geometry" };
  }
  if (angle > maximumAngle) return { accepted: false, reason: "oblique" };
  if (span < minimumSpan) return { accepted: false, reason: "small" };
  return { accepted: true, reason: "quality" };
}

export function markerCorrectionSamplingDecision({
  now,
  previousSampleAt,
  trackingNormalSince,
  profile = worldMarkerCorrectionProfile
}) {
  if (trackingNormalSince === null || trackingNormalSince === undefined) {
    return { accepted: false, resetWindow: false, reason: "warmup" };
  }
  const currentTime = Number(now);
  const normalSince = Number(trackingNormalSince);
  const sampleIntervalMs = Number(profile?.sampleIntervalMs);
  const maximumSampleGapMs = Number(profile?.maximumSampleGapMs);
  const trackingWarmupMs = Number(profile?.trackingWarmupMs);
  if (![currentTime, normalSince, sampleIntervalMs,
    maximumSampleGapMs, trackingWarmupMs].every(Number.isFinite)
    || sampleIntervalMs < 0 || maximumSampleGapMs < sampleIntervalMs
    || trackingWarmupMs < 0) {
    return { accepted: false, resetWindow: false, reason: "invalid" };
  }
  if (currentTime - normalSince < trackingWarmupMs) {
    return { accepted: false, resetWindow: false, reason: "warmup" };
  }

  const previousTime = Number(previousSampleAt);
  if (!Number.isFinite(previousTime)) {
    return { accepted: true, resetWindow: false, reason: "first" };
  }
  const elapsedMs = currentTime - previousTime;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return { accepted: false, resetWindow: true, reason: "non-monotonic" };
  }
  if (elapsedMs > maximumSampleGapMs) {
    return { accepted: true, resetWindow: true, reason: "gap" };
  }
  if (elapsedMs < sampleIntervalMs) {
    return { accepted: false, resetWindow: false, reason: "cadence" };
  }
  return { accepted: true, resetWindow: false, reason: "cadence" };
}

export function markerCorrectionConfirmationDecision({
  extended,
  hasReference,
  referenceAgeMs,
  positionDifferenceMetres,
  rotationDifferenceRadians,
  scaleDifferenceFraction,
  profile = worldMarkerCorrectionProfile
}) {
  if (extended !== true) return "apply";
  if (hasReference !== true) return "pending";

  const pendingAgeMs = Number(referenceAgeMs);
  const difference = {
    positionMetres: nonNegativeMetric(positionDifferenceMetres),
    rotationRadians: nonNegativeMetric(rotationDifferenceRadians),
    scaleFraction: nonNegativeMetric(scaleDifferenceFraction)
  };
  const confirmation = profile?.confirmation;
  const limit = {
    pendingAgeMs: nonNegativeMetric(confirmation?.maximumPendingAgeMs),
    positionMetres: nonNegativeMetric(confirmation?.positionMetres),
    rotationRadians: nonNegativeMetric(confirmation?.rotationRadians),
    scaleFraction: nonNegativeMetric(confirmation?.scaleFraction)
  };
  if (!Number.isFinite(pendingAgeMs) || pendingAgeMs < 0
    || Object.values(limit).some((value) => value === null)
    || pendingAgeMs > limit.pendingAgeMs
    || Object.values(difference).some((value) => value === null)
    || difference.positionMetres > limit.positionMetres
    || difference.rotationRadians > limit.rotationRadians
    || difference.scaleFraction > limit.scaleFraction) {
    return "replace";
  }
  return "apply";
}

export function markerCorrectionWindowStable({
  positionSpreadMetres,
  rotationSpreadRadians,
  scaleSpreadFraction,
  profile = worldMarkerCorrectionProfile
}) {
  const spread = {
    positionMetres: nonNegativeMetric(positionSpreadMetres),
    rotationRadians: nonNegativeMetric(rotationSpreadRadians),
    scaleFraction: nonNegativeMetric(scaleSpreadFraction)
  };
  return !Object.values(spread).some((value) => value === null)
    && spread.positionMetres <= Number(profile?.stability?.positionMetres)
    && spread.rotationRadians <= Number(profile?.stability?.rotationRadians)
    && spread.scaleFraction <= Number(profile?.stability?.scaleFraction);
}

export function markerCorrectionWindowRequirement({
  positionDistanceMetres,
  rotationDistanceRadians,
  scaleDifferenceFraction,
  forceExtended = false,
  relocalizing = false,
  profile = worldMarkerCorrectionProfile
}) {
  const innovation = {
    positionMetres: nonNegativeMetric(positionDistanceMetres),
    rotationRadians: nonNegativeMetric(rotationDistanceRadians),
    scaleFraction: nonNegativeMetric(scaleDifferenceFraction)
  };
  if (Object.values(innovation).some((value) => value === null)) return null;
  const maximumInnovation = relocalizing
    ? profile?.relocalizationMaximumInnovation
    : profile?.maximumInnovation;
  const maximum = {
    positionMetres: nonNegativeMetric(maximumInnovation?.positionMetres),
    rotationRadians: nonNegativeMetric(maximumInnovation?.rotationRadians),
    scaleFraction: nonNegativeMetric(maximumInnovation?.scaleFraction)
  };
  if (Object.values(maximum).some((value) => value === null)
    || innovation.positionMetres > maximum.positionMetres
    || innovation.rotationRadians > maximum.rotationRadians
    || innovation.scaleFraction > maximum.scaleFraction) {
    return null;
  }
  const extended = forceExtended === true
    || innovation.positionMetres > Number(profile?.extendedInnovation?.positionMetres)
    || innovation.rotationRadians > Number(profile?.extendedInnovation?.rotationRadians)
    || innovation.scaleFraction > Number(profile?.extendedInnovation?.scaleFraction);
  const sampleCount = Number(extended ? profile?.extendedSampleCount : profile?.sampleCount);
  const minimumDurationMs = Number(
    extended ? profile?.extendedMinimumDurationMs : profile?.minimumDurationMs
  );
  if (!Number.isFinite(sampleCount) || sampleCount < 1
    || !Number.isFinite(minimumDurationMs) || minimumDurationMs < 0) return null;
  return {
    sampleCount: Math.round(sampleCount),
    minimumDurationMs,
    extended
  };
}

export function markerCorrectionStep({
  elapsedMs,
  positionDistanceMetres,
  rotationDistanceRadians,
  scaleDifferenceFraction,
  positionSpreadMetres,
  rotationSpreadRadians,
  scaleSpreadFraction,
  relocalizing = false,
  profile = worldMarkerCorrectionProfile
}) {
  if (!markerCorrectionWindowStable({
    positionSpreadMetres,
    rotationSpreadRadians,
    scaleSpreadFraction,
    profile
  })) {
    return rejectedMarkerCorrection();
  }
  if (!markerCorrectionWindowRequirement({
    positionDistanceMetres,
    rotationDistanceRadians,
    scaleDifferenceFraction,
    relocalizing,
    profile
  })) {
    return rejectedMarkerCorrection();
  }
  return stablePosterPoseStep({
    elapsedMs,
    positionDistanceMetres,
    rotationDistanceRadians,
    scaleDifferenceFraction,
    profile: profile.step
  });
}

export function markerCorrectionTransitionPlan({
  positionDistanceMetres,
  rotationDistanceRadians,
  scaleDifferenceFraction,
  relocalizing = false,
  profile = worldMarkerCorrectionProfile
}) {
  const requirement = markerCorrectionWindowRequirement({
    positionDistanceMetres,
    rotationDistanceRadians,
    scaleDifferenceFraction,
    forceExtended: relocalizing,
    relocalizing,
    profile
  });
  if (!requirement) return null;

  const transition = profile?.transition;
  const deadband = {
    positionMetres: nonNegativeMetric(transition?.positionDeadbandMetres),
    rotationRadians: nonNegativeMetric(transition?.rotationDeadbandRadians),
    scaleFraction: nonNegativeMetric(transition?.scaleDeadbandFraction)
  };
  const duration = Number(
    requirement.extended ? transition?.majorDurationMs : transition?.minorDurationMs
  );
  if (Object.values(deadband).some((value) => value === null)
    || !Number.isFinite(duration) || duration < 0) return null;

  const required = Number(positionDistanceMetres) > deadband.positionMetres
    || Number(rotationDistanceRadians) > deadband.rotationRadians
    || Number(scaleDifferenceFraction) > deadband.scaleFraction;
  return {
    required,
    extended: requirement.extended,
    durationMs: required ? duration : 0
  };
}

export function markerCorrectionBlendProgress(elapsedMs, durationMs) {
  const elapsed = Number(elapsedMs);
  const duration = Number(durationMs);
  if (!Number.isFinite(elapsed) || !Number.isFinite(duration) || duration < 0) return null;
  if (duration === 0) return elapsed >= 0 ? 1 : 0;
  const linear = Math.min(1, Math.max(0, elapsed / duration));
  return linear * linear * (3 - 2 * linear);
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
