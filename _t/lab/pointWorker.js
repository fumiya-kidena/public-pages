import { getCardPointLayout } from "./layout.js";
import { detectCardPoints, projectCardPoint } from "./pointDetector.js";
import { fitCardHomography, poseFromCardHomography, homographyFromCardPose,
  projectCardPoints } from "../cardPointPose.js";

// Only a recently confirmed measurement can enable partial/ROI tracking.
// No case assets, QR credentials, images or telemetry are persisted.
export function evaluateLabFrame(request) {
  const { caseId, data, width, height, projectionMatrix, seedHomography,
    allowPartial = false, allowGlobal = true } = request;
  const layout = getCardPointLayout(caseId);
  if (!layout) return { reason: "unsupported-layout", count: 0 };
  const detection = detectCardPoints({ data, width, height }, layout,
    { seedHomography, allowPartial, allowGlobal });
  const partial = detection.diagnostics.method === "local-subset";
  const minimum = partial ? 8 : 17;
  const count = detection.matches.length;
  const diagnostics = { ...detection.diagnostics, count };
  if (count < minimum) return { ...diagnostics, reason: detection.diagnostics.reason };
  const fit = fitCardHomography(detection.matches, layout, {
    minPoints: minimum, minPointsPerSide: partial ? 3 : 6, maxRmsPixels: 2,
  });
  if (!fit || fit.inlierCount < minimum) return { ...diagnostics, reason: "point-fit-rejected" };
  const pose = poseFromCardHomography(fit.homography, projectionMatrix, { width, height }, {
    maxPoseRmsPixels: 2.5,
  });
  if (!pose) return { ...diagnostics, reason: "pose-rejected" };
  const matches = detection.matches.filter(point => fit.inlierIds.includes(point.id));
  const cells = new Map(layout.points.map(point => [point.id, point]));
  for (const side of ["left", "right"]) {
    const sidePoints = matches.map(point => cells.get(point.id)).filter(point => point?.side === side);
    if (sidePoints.length < (partial ? 3 : 6) ||
        new Set(sidePoints.map(point => point.row)).size < (partial ? 2 : 3))
      return { ...diagnostics, reason: "inlier-distribution-rejected" };
  }
  const h = homographyFromCardPose(pose.position, pose.quaternion, projectionMatrix, { width, height });
  const projectedPoints = projectCardPoints(h, layout);
  if (!projectedPoints) return { ...diagnostics, reason: "metric-projection-invalid" };
  const projected = new Map(projectedPoints.map(point => [point.id, point]));
  const rmsPixels = Math.sqrt(matches.reduce((sum, point) => {
    const expected = projected.get(point.id);
    return sum + (expected ? (point.x - expected.x) ** 2 + (point.y - expected.y) ** 2 : Infinity);
  }, 0) / matches.length);
  if (!(rmsPixels <= 2.5)) return { ...diagnostics, reason: "metric-reprojection-rejected" };
  const cellPixels = Math.min(...layout.points.map(point => {
    const p = projectCardPoint(h, point);
    const x = projectCardPoint(h, { x: point.x + layout.cellSize, y: point.y });
    const y = projectCardPoint(h, { x: point.x, y: point.y + layout.cellSize });
    return Math.min(Math.hypot(x.x - p.x, x.y - p.y), Math.hypot(y.x - p.x, y.y - p.y));
  }));
  // Low reprojection error alone does not constrain the plane normal when a
  // square occupies only a few pixels. This provisional resolution gate is
  // not a guarantee of physical accuracy above five pixels.
  if (!(Number.isFinite(cellPixels) && cellPixels >= 5))
    return { ...diagnostics, reason: "pose-resolution-limited", count: matches.length,
      rmsPixels, cellPixels, fullPattern: !partial };
  return { ...diagnostics, reason: "measured", count: matches.length, pose, matches,
    homography: fit.homography, rmsPixels, cellPixels, fullPattern: !partial };
}

if (typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope) {
  globalThis.onmessage = ({ data }) => {
    const begin = performance.now();
    try {
      const result = evaluateLabFrame(data);
      globalThis.postMessage({ id: data.id, result, processingMs: performance.now() - begin });
    } catch {
      globalThis.postMessage({ id: data.id, error: "point-processing-failed" });
    }
  };
}
