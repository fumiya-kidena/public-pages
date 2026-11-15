const androidTabletProfile = Object.freeze({
  cameraFrameRate: Object.freeze({ ideal: 20, max: 24 }),
  timelineIntervalMs: 1000 / 12,
  maximumTimelineDeltaSeconds: 0.5,
  disableWorldTracking: false,
  glContextConfig: Object.freeze({
    antialias: false,
    powerPreference: "high-performance"
  })
});

const defaultProfile = Object.freeze({
  cameraFrameRate: null,
  timelineIntervalMs: 0,
  maximumTimelineDeltaSeconds: 0.1,
  disableWorldTracking: false,
  glContextConfig: null
});

export function arPerformanceProfileForDevice(profile) {
  return profile?.isAndroid && profile?.isTablet
    ? androidTabletProfile
    : defaultProfile;
}

export function timedWorkDue(now, previousAt, intervalMs) {
  if (![now, previousAt, intervalMs].every(Number.isFinite)) return true;
  return intervalMs <= 0 || now - previousAt >= intervalMs;
}

export function timelineDeltaSeconds(now, previousAt, maximumSeconds = 0.5) {
  if (![now, previousAt, maximumSeconds].every(Number.isFinite)
    || maximumSeconds <= 0) return 0;
  return Math.min(Math.max((now - previousAt) / 1000, 0), maximumSeconds);
}

function safeTrackObject(getter) {
  if (typeof getter !== "function") return {};
  try {
    const value = getter();
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function supportsContinuous(capabilities, property) {
  const values = capabilities?.[property];
  return Array.isArray(values) && values.includes("continuous");
}

function mergedCameraConstraints(track, frameRate, includeContinuousModes) {
  // applyConstraints() replaces the complete custom constraint set. Retain the
  // XR engine's camera selection and resolution instead of accidentally
  // returning an inexpensive Android camera to its low-resolution defaults.
  const current = safeTrackObject(
    typeof track.getConstraints === "function" ? () => track.getConstraints() : null
  );
  const settings = safeTrackObject(
    typeof track.getSettings === "function" ? () => track.getSettings() : null
  );
  const capabilities = safeTrackObject(
    typeof track.getCapabilities === "function" ? () => track.getCapabilities() : null
  );
  const constraints = { ...current };

  const width = finitePositive(settings.width);
  const height = finitePositive(settings.height);
  if (constraints.width == null && width != null) constraints.width = { ideal: width };
  if (constraints.height == null && height != null) constraints.height = { ideal: height };
  if (constraints.facingMode == null && typeof settings.facingMode === "string") {
    constraints.facingMode = { ideal: settings.facingMode };
  }
  constraints.frameRate = { ideal: frameRate.ideal, max: frameRate.max };

  const continuousMode = {};
  if (includeContinuousModes) {
    for (const property of ["focusMode", "exposureMode", "whiteBalanceMode"]) {
      if (!supportsContinuous(capabilities, property)) continue;
      constraints[property] = "continuous";
      continuousMode[property] = "continuous";
    }
  }
  return { constraints, continuousMode };
}

function cameraSettings(track) {
  const rawSettings = safeTrackObject(
    typeof track.getSettings === "function" ? () => track.getSettings() : null
  );
  return {
    width: finitePositive(rawSettings.width),
    height: finitePositive(rawSettings.height),
    frameRate: finitePositive(rawSettings.frameRate),
    focusMode: typeof rawSettings.focusMode === "string" ? rawSettings.focusMode : null,
    exposureMode: typeof rawSettings.exposureMode === "string" ? rawSettings.exposureMode : null,
    whiteBalanceMode: typeof rawSettings.whiteBalanceMode === "string"
      ? rawSettings.whiteBalanceMode
      : null
  };
}

export async function constrainCameraFrameRate(stream, performanceProfile) {
  const frameRate = performanceProfile?.cameraFrameRate;
  if (!frameRate) return { attempted: false, applied: false, reason: "disabled" };

  const track = stream?.getVideoTracks?.()[0];
  if (!track || typeof track.applyConstraints !== "function") {
    return { attempted: false, applied: false, reason: "video-track-unavailable" };
  }

  const preferred = mergedCameraConstraints(track, frameRate, true);
  const hasContinuousMode = Object.keys(preferred.continuousMode).length > 0;
  try {
    await track.applyConstraints(preferred.constraints);
    return {
      attempted: true,
      applied: true,
      track,
      settings: cameraSettings(track),
      continuousMode: preferred.continuousMode
    };
  } catch (preferredError) {
    // Some Android camera HAL/browser combinations advertise 3A capabilities
    // that still fail as a combined constraint. Keep the FPS/resolution tuning
    // useful by retrying without optional continuous modes.
    if (hasContinuousMode) {
      const fallback = mergedCameraConstraints(track, frameRate, false);
      try {
        await track.applyConstraints(fallback.constraints);
        return {
          attempted: true,
          applied: true,
          track,
          settings: cameraSettings(track),
          continuousMode: {},
          optionalModeReason: preferredError?.name || "constraint-failed"
        };
      } catch (fallbackError) {
        return {
          attempted: true,
          applied: false,
          track,
          reason: fallbackError?.name || "constraint-failed",
          optionalModeReason: preferredError?.name || "constraint-failed"
        };
      }
    }
    return {
      attempted: true,
      applied: false,
      track,
      reason: preferredError?.name || "constraint-failed"
    };
  }
}
