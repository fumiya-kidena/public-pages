/**
 * Return the authored frame count when a case manifest declares one.
 * Runtime clip duration is deliberately not used here: one-frame GLBs can
 * contain a nominal animation clip even though there is no timeline to seek.
 */
export function authoredFrameCount(mode) {
  const timing = mode?.timing || {};
  for (const value of [timing.storedFrameCount, timing.sourceFrameCount]) {
    const count = Number(value);
    if (Number.isFinite(count) && count > 0) return count;
  }
  return null;
}

export function isStaticMode(mode) {
  const frameCount = authoredFrameCount(mode);
  return frameCount !== null && frameCount <= 1;
}

/**
 * A timeline is usable only when runtime media exists and the manifest does
 * not explicitly identify the mode as a one-frame result.
 */
export function hasPlayableTimeline(mode, runtimeTimelineAvailable) {
  return !isStaticMode(mode) && Boolean(runtimeTimelineAvailable);
}

export function playbackStatusText(mode, playing) {
  const label = mode?.label || "3D";
  return isStaticMode(mode)
    ? `${label} · 静止3D`
    : `${label} · ${playing ? "animation再生中" : "一時停止"}`;
}
