// Display-only enlargement. Keep physical marker dimensions, pose calibration,
// model geometry and the encrypted case configuration unchanged.
export function arModelDisplayMultiplier(caseId) {
  return caseId === "medullaryCavity" ? 2.5 : 1;
}
