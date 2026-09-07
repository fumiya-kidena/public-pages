import { getCardPointLayout } from "./cardPointLayout.js?v=1";
import { detectCardPoints } from "./cardPointDetector.js?v=1";
import { fitCardHomography, poseFromCardHomography, projectCardPoints, homographyFromCardPose } from "./cardPointPose.js?v=1";

// Pixels live only in this worker invocation. Never persist or send them out.
export function evaluateCardPointFrame({ caseId, data, width, height, projectionMatrix, seedHomography, allowGlobal = true }) {
  const layout = getCardPointLayout(caseId);
  if (!layout) return { reason: "unsupported-layout", count: 0 };
  const detection = detectCardPoints({ data, width, height }, layout, { seedHomography, allowGlobal });
  const count = detection.matches.length;
  if (count < 17) return { reason: detection.diagnostics.reason, count: 0 };
  const fitted = fitCardHomography(detection.matches, layout, { minPoints: 17, maxRmsPixels: 2 });
  if (!fitted || fitted.inlierCount < 17) return { reason: "point-fit-rejected", count };
  const pose = poseFromCardHomography(fitted.homography, projectionMatrix, { width, height }, {
    maxPoseRmsPixels: 2.5
  });
  if (!pose) return { reason: "pose-rejected", count };
  const measured = detection.matches.filter(p => fitted.inlierIds.includes(p.id));
  const metricHomography = homographyFromCardPose(pose.position, pose.quaternion, projectionMatrix, { width, height });
  const projected = projectCardPoints(metricHomography, layout);
  const byId = new Map(projected?.map(p => [p.id, p]) || []);
  const rmsPixels = Math.sqrt(measured.reduce((sum, p) => {
    const prediction = byId.get(p.id);
    return sum + (prediction ? (p.x - prediction.x) ** 2 + (p.y - prediction.y) ** 2 : Infinity);
  }, 0) / measured.length);
  if (!(rmsPixels <= 2.5)) return { reason: "metric-reprojection-rejected", count };
  return {
    reason: "measured", count: measured.length, pose, matches: measured,
    homography: fitted.homography, rmsPixels, method: detection.diagnostics.method
  };
}

if (typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope) {
  globalThis.onmessage = ({ data: request }) => {
    try {
      globalThis.postMessage({ id: request.id, result: evaluateCardPointFrame(request) });
    } catch {
      // Do not leak image data or private runtime values in diagnostics.
      globalThis.postMessage({ id: request.id, error: "point-processing-failed" });
    }
  };
}
