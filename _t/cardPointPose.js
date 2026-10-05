// Planar point geometry, independent of the renderer and of private case data.
// Card: metres, centre origin, +X right, +Y up, +Z out of the printed face.
// Image: pixels, +X right, +Y down. Camera: Three/OpenGL, looking along -Z.
// H is row-major; projectionElements is Three's column-major Matrix4.elements.
// The recovered distance uses the CANONICAL card size, not measured print size.
// Callers must apply one consistent world-unit calibration to translation/scale.
// Theory: https://docs.opencv.org/4.13.0/d9/dab/tutorial_homography.html
// Conventions: https://threejs.org/docs/pages/Camera.html

const EPS = 1e-12;
const finite = values => values.every(Number.isFinite);
const dot = (a, b) => a.reduce((v, x, i) => v + x * b[i], 0);
const norm = a => Math.hypot(...a);
const scale = (a, s) => a.map(v => v * s);
const add = (a, b) => a.map((v, i) => v + b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => norm(a) > EPS ? scale(a, 1 / norm(a)) : null;

function multiply3(a, b) {
  const c = Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) c[r * 3 + j] += a[r * 3 + k] * b[k * 3 + j];
  return c;
}

function inverse3(a) {
  const b = [a[4] * a[8] - a[5] * a[7], a[2] * a[7] - a[1] * a[8], a[1] * a[5] - a[2] * a[4],
    a[5] * a[6] - a[3] * a[8], a[0] * a[8] - a[2] * a[6], a[2] * a[3] - a[0] * a[5],
    a[3] * a[7] - a[4] * a[6], a[1] * a[6] - a[0] * a[7], a[0] * a[4] - a[1] * a[3]];
  const d = a[0] * b[0] + a[1] * b[3] + a[2] * b[6];
  return Number.isFinite(d) && Math.abs(d) > EPS ? scale(b, 1 / d) : null;
}

function solve(a, b) {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  const largest = Math.max(...a.flat().map(Math.abs));
  if (!Number.isFinite(largest) || largest < EPS) return null;
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(m[i][k]) > Math.abs(m[p][k])) p = i;
    if (Math.abs(m[p][k]) < largest * 1e-11) return null;
    [m[p], m[k]] = [m[k], m[p]];
    const divisor = m[k][k];
    for (let j = k; j <= n; j++) m[k][j] /= divisor;
    for (let i = 0; i < n; i++) if (i !== k) {
      const f = m[i][k];
      for (let j = k; j <= n; j++) m[i][j] -= f * m[k][j];
    }
  }
  const result = m.map(row => row[n]);
  return finite(result) ? result : null;
}

function projectionBasis(elements, viewport) {
  const p = elements?.elements || elements;
  const w = viewport?.width, h = viewport?.height;
  if (!p || p.length !== 16 || !finite(Array.from(p)) || !(w > 0 && h > 0) || !finite([w, h])) return null;
  // Perspective only. Off-axis principal points and XY skew are supported.
  if (Math.abs(p[3]) > 1e-7 || Math.abs(p[7]) > 1e-7 || Math.abs(p[11] + 1) > 1e-7 ||
      Math.abs(p[12]) > 1e-7 || Math.abs(p[13]) > 1e-7 || Math.abs(p[15]) > 1e-7) return null;
  const ndc = [p[0], p[4], p[8], p[1], p[5], p[9], 0, 0, -1];
  if (!inverse3(ndc)) return null;
  return multiply3([w / 2, 0, w / 2, 0, -h / 2, h / 2, 0, 0, 1], ndc);
}

function project(h, point) {
  const d = h[6] * point.x + h[7] * point.y + h[8];
  if (!Number.isFinite(d) || Math.abs(d) < EPS) return null;
  const x = (h[0] * point.x + h[1] * point.y + h[2]) / d;
  const y = (h[3] * point.x + h[4] * point.y + h[5]) / d;
  return finite([x, y]) ? { x, y } : null;
}

/** Project canonical card points to image pixels; returns null on an invalid H. */
export function projectCardPoints(homography, layoutOrPoints) {
  const points = Array.isArray(layoutOrPoints) ? layoutOrPoints : layoutOrPoints?.points;
  if (!homography || homography.length !== 9 || !finite(Array.from(homography)) || !Array.isArray(points)) return null;
  const output = [];
  for (const point of points) {
    const projected = project(homography, point);
    if (!projected) return null;
    output.push({ ...point, ...projected });
  }
  return output;
}

function pointNormalization(points) {
  const x = points.reduce((v, p) => v + p.x, 0) / points.length;
  const y = points.reduce((v, p) => v + p.y, 0) / points.length;
  const distance = points.reduce((v, p) => v + Math.hypot(p.x - x, p.y - y), 0) / points.length;
  if (!(distance > EPS)) return null;
  const s = Math.SQRT2 / distance;
  return { matrix: [s, 0, -s * x, 0, s, -s * y, 0, 0, 1], points: points.map(p => ({ x: (p.x - x) * s, y: (p.y - y) * s })) };
}

function spread2d(points) {
  const mx = points.reduce((a, p) => a + p.x, 0) / points.length;
  const my = points.reduce((a, p) => a + p.y, 0) / points.length;
  let xx = 0, yy = 0, xy = 0;
  for (const p of points) { xx += (p.x - mx) ** 2; yy += (p.y - my) ** 2; xy += (p.x - mx) * (p.y - my); }
  return (xx * yy - xy * xy) / Math.max(EPS, (xx + yy) ** 2);
}

function leastSquaresHomography(pairs) {
  if (pairs.length < 4 || spread2d(pairs.map(p => p.card)) < 1e-5 || spread2d(pairs) < 1e-5) return null;
  const src = pointNormalization(pairs.map(p => p.card)), dst = pointNormalization(pairs);
  if (!src || !dst) return null;
  const ata = Array.from({ length: 8 }, () => Array(8).fill(0)), atb = Array(8).fill(0);
  for (let i = 0; i < pairs.length; i++) {
    const { x, y } = src.points[i], u = dst.points[i].x, v = dst.points[i].y;
    const weight = pairs[i].confidence;
    const rows = [[x, y, 1, 0, 0, 0, -u * x, -u * y], [0, 0, 0, x, y, 1, -v * x, -v * y]];
    for (let row = 0; row < 2; row++) for (let j = 0; j < 8; j++) {
      atb[j] += weight * rows[row][j] * (row === 0 ? u : v);
      for (let k = 0; k < 8; k++) ata[j][k] += weight * rows[row][j] * rows[row][k];
    }
  }
  const values = solve(ata, atb);
  if (!values) return null;
  const h = multiply3(multiply3(inverse3(dst.matrix), [...values, 1]), src.matrix);
  if (!finite(h) || Math.abs(h[8]) < EPS) return null;
  return scale(h, 1 / h[8]);
}

function cardCorners(width, height) {
  return [{ x: -width / 2, y: -height / 2 }, { x: width / 2, y: -height / 2 },
    { x: width / 2, y: height / 2 }, { x: -width / 2, y: height / 2 }];
}

function validCardProjection(h, width, height, options) {
  const corners = cardCorners(width, height), projected = projectCardPoints(h, corners);
  if (!projected) return false;
  const depth = corners.map(p => h[6] * p.x + h[7] * p.y + h[8]);
  if (depth.some(d => d <= EPS) || Math.max(...depth) / Math.min(...depth) > (options.maxPerspectiveRatio ?? 12)) return false;
  let signedArea = 0;
  for (let i = 0; i < 4; i++) {
    const a = projected[i], b = projected[(i + 1) % 4], c = projected[(i + 2) % 4];
    // A front-facing card has negative screen winding because image Y points down.
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) >= -EPS) return false;
    signedArea += a.x * b.y - a.y * b.x;
  }
  return -signedArea / 2 >= (options.minAreaPixels ?? 144);
}

function coverage(pairs, layout, options) {
  if (pairs.length < (options.minPoints ?? 6)) return false;
  const points = pairs.map(p => p.card);
  if (spread2d(points) < 1e-4 || spread2d(pairs) < 1e-4) return false;
  const spanX = Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x));
  const spanY = Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y));
  if (spanX < layout.width * (options.minWidthCoverage ?? 0.55) || spanY < layout.height * (options.minHeightCoverage ?? 0.35)) return false;
  if (options.requireBothSides !== false) {
    const required = options.minPointsPerSide ?? 2;
    if (points.filter(p => p.side === 'left').length < required || points.filter(p => p.side === 'right').length < required) return false;
  }
  return true;
}

/** Robust identified-point fit. Unknown/duplicate IDs are ignored/rejected, not inferred. */
export function fitCardHomography(matches, layout, options = {}) {
  if (!Array.isArray(matches) || !Array.isArray(layout?.points) || !(layout.width > 0 && layout.height > 0)) return null;
  const byId = new Map(layout.points.map(p => [p.id, p]));
  if (byId.size !== layout.points.length) return null;
  const seen = new Set(), pairs = [];
  for (const match of matches) {
    if (!match || !finite([match.x, match.y]) || !byId.has(match.id)) continue;
    if (seen.has(match.id)) return null;
    seen.add(match.id);
    const card = byId.get(match.id);
    if (!finite([card.x, card.y])) return null;
    const confidence = match.confidence ?? 1;
    if (!Number.isFinite(confidence) || confidence <= 0) continue;
    pairs.push({ ...match, card, confidence: Math.min(1, Math.max(0.05, confidence)) });
  }
  if (!coverage(pairs, layout, options)) return null;
  const threshold = options.inlierThresholdPixels ?? 3;
  if (!(threshold > 0 && Number.isFinite(threshold))) return null;
  let best = null;
  const consider = h => {
    if (!h || !validCardProjection(h, layout.width, layout.height, options)) return;
    const inliers = [], errors = [];
    for (const pair of pairs) {
      const projected = project(h, pair.card);
      const error = projected ? Math.hypot(projected.x - pair.x, projected.y - pair.y) : Infinity;
      if (error <= threshold) { inliers.push(pair); errors.push(error); }
    }
    const cost = errors.reduce((a, v) => a + v * v, 0);
    if (!best || inliers.length > best.inliers.length || (inliers.length === best.inliers.length && cost < best.cost)) best = { h, inliers, cost };
  };
  consider(leastSquaresHomography(pairs));
  // Fixed seed: bounded, reproducible work and no frame-dependent random jitter.
  let randomState = 0x4c504f53;
  const random = () => { randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5; return (randomState >>> 0) / 4294967296; };
  const iterationCount = Math.min(256, Math.max(0, Math.floor(options.maxIterations ?? 96)));
  for (let iteration = 0; iteration < iterationCount && best?.inliers.length !== pairs.length; iteration++) {
    const ids = new Set();
    while (ids.size < 4) ids.add(Math.floor(random() * pairs.length));
    consider(leastSquaresHomography([...ids].map(i => pairs[i])));
  }
  if (!best || best.inliers.length < pairs.length * (options.minInlierRatio ?? 0.6) || !coverage(best.inliers, layout, options)) return null;
  // Refit only consensus; no outlier can move the final metric frame.
  const refitted = leastSquaresHomography(best.inliers);
  if (!refitted || !validCardProjection(refitted, layout.width, layout.height, options)) return null;
  const errors = best.inliers.map(p => { const q = project(refitted, p.card); return q ? Math.hypot(q.x - p.x, q.y - p.y) : Infinity; });
  const rmsPixels = Math.sqrt(errors.reduce((a, v) => a + v * v, 0) / errors.length);
  if (Math.max(...errors) > threshold || rmsPixels > (options.maxRmsPixels ?? 2.5)) return null;
  return { homography: refitted, rmsPixels, maxErrorPixels: Math.max(...errors), inlierIds: best.inliers.map(p => p.id),
    inlierCount: best.inliers.length, matchCount: pairs.length, confidence: (best.inliers.length / pairs.length) / (1 + rmsPixels) };
}

function quaternionFromBasis(a, b, c) {
  const m00 = a[0], m01 = b[0], m02 = c[0], m10 = a[1], m11 = b[1], m12 = c[1], m20 = a[2], m21 = b[2], m22 = c[2];
  const trace = m00 + m11 + m22;
  let x, y, z, w, s;
  if (trace > 0) { s = 2 * Math.sqrt(trace + 1); w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s; }
  else if (m00 > m11 && m00 > m22) { s = 2 * Math.sqrt(1 + m00 - m11 - m22); w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s; }
  else if (m11 > m22) { s = 2 * Math.sqrt(1 + m11 - m00 - m22); w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s; }
  else { s = 2 * Math.sqrt(1 + m22 - m00 - m11); w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4; }
  const length = Math.hypot(x, y, z, w), sign = w < 0 ? -1 : 1;
  return { x: sign * x / length, y: sign * y / length, z: sign * z / length, w: sign * w / length };
}

function basisFromQuaternion(q) {
  if (!q || !finite([q.x, q.y, q.z, q.w])) return null;
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  if (n < EPS) return null;
  const x = q.x / n, y = q.y / n, z = q.z / n, w = q.w / n;
  return [[1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
    [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
    [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)]];
}

function homographyFromBasis(basis, translation, projection) {
  const a = basis[0], b = basis[1], t = translation;
  return multiply3(projection, [a[0], b[0], t[0], a[1], b[1], t[1], a[2], b[2], t[2]]);
}

/** Build a seed H from a camera-local rigid card pose; scale translation first. */
export function homographyFromCardPose(position, quaternion, projectionElements, viewport) {
  const projection = projectionBasis(projectionElements, viewport), basis = basisFromQuaternion(quaternion);
  if (!projection || !basis || !position || !finite([position.x, position.y, position.z]) || position.z >= -EPS) return null;
  const h = homographyFromBasis(basis, [position.x, position.y, position.z], projection);
  return Math.abs(h[8]) > EPS ? scale(h, 1 / h[8]) : null;
}

function smallRotation(vector, delta) {
  const angle = norm(delta);
  if (angle < EPS) return vector.slice();
  const axis = scale(delta, 1 / angle), cos = Math.cos(angle), sin = Math.sin(angle);
  return add(add(scale(vector, cos), scale(cross(axis, vector), sin)), scale(axis, dot(axis, vector) * (1 - cos)));
}

function refinePose(basis, translation, projection, points, target, iterations) {
  const residual = (r, t) => {
    const values = projectCardPoints(homographyFromBasis(r, t, projection), points);
    return values ? values.flatMap((p, i) => [p.x - target[i].x, p.y - target[i].y]) : null;
  };
  let error = residual(basis, translation);
  if (!error) return null;
  let cost = dot(error, error), damping = 1e-4;
  for (let iteration = 0; iteration < iterations && cost > 1e-12; iteration++) {
    const jacobian = [];
    for (let axis = 0; axis < 6; axis++) {
      const epsilon = axis < 3 ? 1e-5 : Math.max(1e-7, norm(translation) * 1e-6);
      const delta = [0, 0, 0]; delta[axis % 3] = epsilon;
      const shifted = axis < 3 ? residual(basis.map(v => smallRotation(v, delta)), translation) : residual(basis, add(translation, delta));
      if (!shifted) return null;
      jacobian.push(shifted.map((v, i) => (v - error[i]) / epsilon));
    }
    const ata = Array.from({ length: 6 }, (_, r) => Array.from({ length: 6 }, (_, c) => dot(jacobian[r], jacobian[c])));
    const atb = jacobian.map(row => -dot(row, error));
    for (let i = 0; i < 6; i++) ata[i][i] += damping * Math.max(1, ata[i][i]);
    const step = solve(ata, atb);
    if (!step || norm(step.slice(0, 3)) > 0.5 || norm(step.slice(3)) > norm(translation) * 0.4) break;
    const nextBasis = basis.map(v => smallRotation(v, step.slice(0, 3))), nextTranslation = add(translation, step.slice(3));
    const nextError = residual(nextBasis, nextTranslation), nextCost = nextError ? dot(nextError, nextError) : Infinity;
    if (nextCost < cost) { basis = nextBasis; translation = nextTranslation; error = nextError; cost = nextCost; damping *= 0.3; }
    else damping *= 10;
  }
  return { basis, translation, rmsPixels: Math.sqrt(cost / points.length) };
}

/** Recover metric camera-local pose, then refine reprojection on a bounded grid. */
export function poseFromCardHomography(homography, projectionElements, viewport, options = {}) {
  if (!homography || homography.length !== 9 || !finite(Array.from(homography)) || Math.abs(homography[8]) < EPS) return null;
  const h = scale(Array.from(homography), 1 / homography[8]);
  const width = options.cardWidth ?? 0.091, height = options.cardHeight ?? 0.055;
  if (!(width > 0 && height > 0) || !validCardProjection(h, width, height, options)) return null;
  const projection = projectionBasis(projectionElements, viewport);
  if (!projection) return null;
  const calibrated = multiply3(inverse3(projection), h);
  let a = [calibrated[0], calibrated[3], calibrated[6]], b = [calibrated[1], calibrated[4], calibrated[7]];
  const t = [calibrated[2], calibrated[5], calibrated[8]];
  const na = norm(a), nb = norm(b);
  if (!(na > EPS && nb > EPS) || Math.max(na, nb) / Math.min(na, nb) > (options.maxAxisScaleRatio ?? 1.5)) return null;
  const sign = t[2] < 0 ? 1 : -1;
  a = scale(a, sign / na); b = scale(b, sign / nb);
  if (Math.abs(dot(a, b)) > (options.maxAxisSkew ?? 0.3)) return null;
  // Symmetric orthogonalization avoids privileging the horizontal marker axis.
  const sum = unit(add(a, b)), difference = unit(add(a, scale(b, -1)));
  if (!sum || !difference) return null;
  a = scale(add(sum, difference), Math.SQRT1_2); b = scale(add(sum, scale(difference, -1)), Math.SQRT1_2);
  let basis = [a, b, cross(a, b)], translation = scale(t, sign * 2 / (na + nb));
  const points = cardCorners(width, height);
  points.push({ x: 0, y: 0 }, { x: -width / 2, y: 0 }, { x: width / 2, y: 0 }, { x: 0, y: -height / 2 }, { x: 0, y: height / 2 });
  const target = projectCardPoints(h, points);
  const refined = refinePose(basis, translation, projection, points, target, Math.min(12, Math.max(0, options.refineIterations ?? 8)));
  if (!refined || refined.rmsPixels > (options.maxPoseRmsPixels ?? 4)) return null;
  ({ basis, translation } = refined);
  if (!finite(translation) || points.some(p => basis[0][2] * p.x + basis[1][2] * p.y + translation[2] >= -EPS)) return null;
  const normalViewCosine = -dot(basis[2], translation) / norm(translation);
  if (normalViewCosine < (options.minNormalViewCosine ?? 0.12)) return null;
  const quaternion = quaternionFromBasis(...basis);
  if (!finite(Object.values(quaternion))) return null;
  return { position: { x: translation[0], y: translation[1], z: translation[2] }, quaternion,
    normal: { x: basis[2][0], y: basis[2][1], z: basis[2][2] }, rmsPixels: refined.rmsPixels,
    normalViewCosine, canonicalWidth: width, canonicalHeight: height };
}
