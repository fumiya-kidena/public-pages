/* Direct coloured-cell measurement for the printed FLOW AR card.
 * No camera pose, model or private asset is consumed here. A seed is only a
 * correspondence-search hint: every returned image point is a measured blob
 * centroid. Coordinates in H map card metres (x right, y up) to image pixels.
 */

const COLOUR = {accent: 1, ink: 2, orange: 3};
const NAME = ['', 'accent', 'ink', 'orange'];
const MAX_DIMENSION = 640;
const MAX_COMPONENTS = 140;
const MAX_HYPOTHESES = 1800;

function hue(r, g, b) {
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b), d = hi - lo;
  if (d < 1) return {h: 0, s: 0, v: hi};
  let h = hi === r ? (g - b) / d : hi === g ? 2 + (b - r) / d : 4 + (r - g) / d;
  h = (h * 60 + 360) % 360;
  return {h, s: d / Math.max(1, hi), v: hi};
}

function hueDistance(a, b) {
  const d = Math.abs(a - b);
  return Math.min(d, 360 - d);
}

function classify(r, g, b, targetHue) {
  const c = hue(r, g, b);
  if (c.v < 25 || c.v > 248 && c.s < 0.16) return 0;
  if (c.s > 0.24 && c.v >= 52) {
    const da = hueDistance(c.h, targetHue.accent);
    const dor = hueDistance(c.h, targetHue.orange);
    const di = hueDistance(c.h, targetHue.ink);
    if (Math.min(da, dor) < 22 && Math.min(da, dor) < di + 2) return da < dor ? 1 : 3;
  }
  // Neutral/dark-blue ink, including shadows and camera colour desaturation.
  if (c.v < 128 && (c.s < 0.40 || hueDistance(c.h, targetHue.ink) < 35)) return 2;
  return 0;
}

function components(image, layout) {
  const step = Math.max(1, Math.ceil(Math.max(image.width, image.height) / MAX_DIMENSION));
  const width = Math.ceil(image.width / step), height = Math.ceil(image.height / step);
  const count = width * height, label = new Uint8Array(count), queue = new Int32Array(count);
  const targetHue = Object.fromEntries(Object.entries(layout.palette).map(([k, rgb]) => [k, hue(...rgb).h]));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (Math.min(image.height - 1, y * step) * image.width + Math.min(image.width - 1, x * step)) * 4;
    if (image.data[i + 3] >= 128) label[y * width + x] = classify(image.data[i], image.data[i + 1], image.data[i + 2], targetHue);
  }
  const result = [];
  for (let start = 0; start < count; start++) {
    const colour = label[start];
    if (!colour) continue;
    let head = 0, tail = 1, sx = 0, sy = 0, xx = 0, yy = 0, xy = 0;
    let minX = width, maxX = 0, minY = height, maxY = 0;
    queue[0] = start; label[start] = 0;
    while (head < tail) {
      const at = queue[head++], x = at % width, y = Math.floor(at / width);
      sx += x; sy += y; xx += x * x; yy += y * y; xy += x * y;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      if (x > 0 && label[at - 1] === colour) {label[at - 1] = 0; queue[tail++] = at - 1;}
      if (x + 1 < width && label[at + 1] === colour) {label[at + 1] = 0; queue[tail++] = at + 1;}
      if (y > 0 && label[at - width] === colour) {label[at - width] = 0; queue[tail++] = at - width;}
      if (y + 1 < height && label[at + width] === colour) {label[at + width] = 0; queue[tail++] = at + width;}
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    // A frame-clipped square's visible centroid is not its actual centre.
    if (minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1) continue;
    if (tail < 5 || tail > count * 0.022 || bw < 2 || bh < 2 || tail / (bw * bh) < 0.35) continue;
    const cx = sx / tail, cy = sy / tail;
    const vx = xx / tail - cx * cx + 1 / 12, vy = yy / tail - cy * cy + 1 / 12, cov = xy / tail - cx * cy;
    const trace = vx + vy, discr = Math.sqrt((vx - vy) ** 2 + 4 * cov * cov);
    if ((trace + discr) / Math.max(0.1, trace - discr) > 22) continue;
    result.push({x: cx * step + 0.5, y: cy * step + 0.5, area: tail * step * step,
      colour: NAME[colour], index: result.length, vx: vx * step * step,
      vy: vy * step * step, cov: cov * step * step});
  }
  // Bounding the candidate set also bounds adversarial/random-image work.
  result.sort((a, b) => (a.colour === 'ink') - (b.colour === 'ink') || b.area - a.area);
  return {blob: result.slice(0, MAX_COMPONENTS), step, componentCount: result.length};
}

export function projectCardPoint(h, point) {
  const d = h[6] * point.x + h[7] * point.y + h[8];
  if (!Number.isFinite(d) || Math.abs(d) < 1e-9) return null;
  const x = (h[0] * point.x + h[1] * point.y + h[2]) / d;
  const y = (h[3] * point.x + h[4] * point.y + h[5]) / d;
  return Number.isFinite(x + y) ? {x, y} : null;
}

function solve(a, b) {
  const n = b.length, m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
    if (Math.abs(m[pivot][c]) < 1e-10) return null;
    [m[pivot], m[c]] = [m[c], m[pivot]];
    const scale = m[c][c];
    for (let k = c; k <= n; k++) m[c][k] /= scale;
    for (let r = 0; r < n; r++) if (r !== c) {
      const factor = m[r][c];
      for (let k = c; k <= n; k++) m[r][k] -= factor * m[c][k];
    }
  }
  return m.map(row => row[n]);
}

function fit(source, observed) {
  if (source.length < 4) return null;
  const a = Array.from({length: 8}, () => Array(8).fill(0)), b = Array(8).fill(0);
  const coordScale = 0.05, pixelScale = 1000;
  for (let i = 0; i < source.length; i++) {
    const x = source[i].x / coordScale, y = source[i].y / coordScale;
    const u = observed[i].x / pixelScale, v = observed[i].y / pixelScale;
    const row = [[x, y, 1, 0, 0, 0, -u * x, -u * y], [0, 0, 0, x, y, 1, -v * x, -v * y]];
    for (let r = 0; r < 2; r++) for (let j = 0; j < 8; j++) {
      b[j] += row[r][j] * (r === 0 ? u : v);
      for (let k = 0; k < 8; k++) a[j][k] += row[r][j] * row[r][k];
    }
  }
  const h = solve(a, b);
  return h && [h[0] * pixelScale / coordScale, h[1] * pixelScale / coordScale, h[2] * pixelScale,
    h[3] * pixelScale / coordScale, h[4] * pixelScale / coordScale, h[5] * pixelScale,
    h[6] / coordScale, h[7] / coordScale, 1];
}

function footprint(h, point, cellSize) {
  const p = projectCardPoint(h, point), x = projectCardPoint(h, {x: point.x + cellSize, y: point.y});
  const y = projectCardPoint(h, {x: point.x, y: point.y + cellSize});
  if (!p || !x || !y) return null;
  const dx = {x: x.x - p.x, y: x.y - p.y}, dy = {x: y.x - p.x, y: y.y - p.y};
  const area = Math.abs(dx.x * dy.y - dx.y * dy.x);
  const length = Math.min(Math.hypot(dx.x, dx.y), Math.hypot(dy.x, dy.y));
  return {p, area, length};
}

function validCard(h, layout, image) {
  if (!h || h.length !== 9 || !h.every(Number.isFinite)) return false;
  const corner = [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([x, y]) => projectCardPoint(h,
    {x: x * layout.width / 2, y: y * layout.height / 2}));
  if (corner.some(p => !p || Math.abs(p.x) > image.width * 6 || Math.abs(p.y) > image.height * 6)) return false;
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = corner[i], b = corner[(i + 1) % 4], c = corner[(i + 2) % 4];
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) <= 0) return false;
    area += a.x * b.y - a.y * b.x;
  }
  return area > 1800 && area < image.width * image.height * 8;
}

function correspond(h, blob, layout, image, loose = false) {
  if (!validCard(h, layout, image)) return null;
  const pair = [];
  for (const point of layout.points) {
    const f = footprint(h, point, layout.cellSize);
    if (!f || f.area < 3 || f.length < 1.4) continue;
    const radius = Math.max(3, f.length * (loose ? 1.55 : 0.85));
    let best = null, bestScore = Infinity;
    for (const candidate of blob) {
      if (candidate.colour !== point.color || candidate.area / f.area < 0.28 || candidate.area / f.area > 2.7) continue;
      const distance = Math.hypot(candidate.x - f.p.x, candidate.y - f.p.y);
      if (distance > radius) continue;
      const score = distance / radius + 0.12 * Math.abs(Math.log(candidate.area / f.area));
      if (score < bestScore) {best = candidate; bestScore = score;}
    }
    if (best) pair.push({point, blob: best, residual: Math.hypot(best.x - f.p.x, best.y - f.p.y), score: bestScore, cell: f.length});
  }
  pair.sort((a, b) => a.score - b.score);
  const used = new Set(), unique = pair.filter(p => !used.has(p.blob.index) && used.add(p.blob.index));
  return unique;
}

function qualify(h, pair, blob, layout, image) {
  if (!pair || pair.length < 17 || !validCard(h, layout, image)) return null;
  const count = {left: 0, right: 0, accent: 0, ink: 0, orange: 0};
  const row = {left: new Set(), right: new Set()};
  for (const p of pair) {count[p.point.side]++; count[p.point.color]++; row[p.point.side].add(p.point.row);}
  if (count.left < 6 || count.right < 6 || row.left.size < 3 || row.right.size < 3 ||
      count.accent < 3 || count.orange < 2 || count.ink < 2) return null;
  let emptyConflict = 0;
  for (const point of layout.missingCells || []) {
    const f = footprint(h, point, layout.cellSize);
    if (!f) continue;
    if (blob.some(p => Math.hypot(p.x - f.p.x, p.y - f.p.y) < Math.max(2, f.length * 0.6) && p.area / f.area > 0.3 && p.area / f.area < 2.7)) emptyConflict++;
  }
  if (emptyConflict) return null;
  // Positive matches alone permit a wrong row/column alignment to explain a
  // subset of another pattern. Explicit contradictory colours veto it.
  let colourConflict = 0;
  for (const point of layout.points) {
    const f = footprint(h, point, layout.cellSize);
    if (!f) continue;
    if (blob.some(p => p.colour !== point.color && Math.hypot(p.x - f.p.x, p.y - f.p.y) < Math.max(2, f.length * 0.6) &&
        p.area / f.area > 0.3 && p.area / f.area < 2.7)) colourConflict++;
  }
  if (colourConflict > 1) return null;
  const rms = Math.sqrt(pair.reduce((sum, p) => sum + p.residual ** 2, 0) / pair.length);
  const relativeRms = Math.sqrt(pair.reduce((sum, p) => sum + (p.residual / p.cell) ** 2, 0) / pair.length);
  if (relativeRms > 0.3) return null;
  return {h, pair, rms, relativeRms, score: pair.length - relativeRms * 3, count};
}

function refine(seed, blob, layout, image) {
  let h = seed, pair = correspond(h, blob, layout, image, true);
  if (!pair || pair.length < 7) return null;
  for (let i = 0; i < 3; i++) {
    h = fit(pair.map(p => p.point), pair.map(p => p.blob));
    if (!h) return null;
    pair = correspond(h, blob, layout, image, i === 0);
    if (!pair || pair.length < 7) return null;
  }
  return qualify(h, pair, blob, layout, image);
}

function sourceQuad(layout) {
  const byCell = new Map(layout.points.map(p => [`${p.side}:${p.row}:${p.column}`, p]));
  const result = [];
  for (const p of layout.points) {
    const b = byCell.get(`${p.side}:${p.row}:${p.column + 1}`);
    const c = byCell.get(`${p.side}:${p.row + 1}:${p.column}`);
    const d = byCell.get(`${p.side}:${p.row + 1}:${p.column + 1}`);
    if (b && c && d) result.push([p, b, c, d]);
  }
  return result;
}

function globalAcquire(blob, layout, image) {
  const quads = sourceQuad(layout), keyed = new Map();
  for (const q of quads) {
    const key = q.map(p => p.color).join(',');
    if (!keyed.has(key)) keyed.set(key, []);
    keyed.get(key).push(q);
  }
  let best = null, hypotheses = 0;
  // A local filled 2 x 2 grid supplies four measured correspondences. Its
  // projective transform is then checked against BOTH grids and their holes.
  for (const a of blob) {
    const near = blob.filter(p => p !== a && p.area / a.area > 0.32 && p.area / a.area < 3.1 &&
      Math.hypot(p.x - a.x, p.y - a.y) < Math.sqrt(a.area) * 7 &&
      Math.hypot(p.x - a.x, p.y - a.y) > Math.sqrt(a.area) * 1.25)
      .sort((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y)).slice(0, 10);
    for (const b of near) for (const c of near) {
      if (b === c) continue;
      const bx = b.x - a.x, by = b.y - a.y, cx = c.x - a.x, cy = c.y - a.y;
      const product = Math.hypot(bx, by) * Math.hypot(cx, cy);
      if (bx * cy - by * cx < product * 0.23) continue;
      const tx = b.x + c.x - a.x, ty = b.y + c.y - a.y;
      const tolerance = Math.min(Math.hypot(bx, by), Math.hypot(cx, cy)) * 0.5;
      const possible = blob.filter(d => d !== a && d !== b && d !== c && d.area / a.area > 0.22 && d.area / a.area < 4 &&
        Math.hypot(d.x - tx, d.y - ty) < tolerance).sort((p, q) => Math.hypot(p.x - tx, p.y - ty) - Math.hypot(q.x - tx, q.y - ty)).slice(0, 2);
      for (const d of possible) {
        const source = keyed.get([a, b, c, d].map(p => p.colour).join(','));
        if (!source) continue;
        for (const q of source) {
          const candidate = refine(fit(q, [a, b, c, d]), blob, layout, image);
          hypotheses++;
          if (candidate && (!best || candidate.score > best.score)) best = candidate;
          if (best && best.pair.length >= layout.points.length - 1 && best.relativeRms < 0.1 || hypotheses >= MAX_HYPOTHESES) return {best, hypotheses};
        }
      }
    }
  }
  return {best, hypotheses};
}

function validInput(image, layout) {
  return image && Number.isInteger(image.width) && Number.isInteger(image.height) && image.width >= 8 && image.height >= 8 &&
    image.width <= 8192 && image.height <= 8192 && image.width * image.height <= 16777216 &&
    image.data && image.data.length >= image.width * image.height * 4 && layout && Number.isFinite(layout.width) &&
    Number.isFinite(layout.height) && layout.width > 0 && layout.height > 0 && Number.isFinite(layout.cellSize) && layout.cellSize > 0 &&
    Array.isArray(layout.points) && layout.points.length >= 12 && layout.points.length <= 40 && layout.points.every(p => p &&
      typeof p.id === 'string' && Number.isFinite(p.x) && Number.isFinite(p.y) && COLOUR[p.color] && ['left', 'right'].includes(p.side) &&
      Number.isInteger(p.row) && Number.isInteger(p.column)) && new Set(layout.points.map(p => p.id)).size === layout.points.length &&
    (!layout.missingCells || Array.isArray(layout.missingCells) && layout.missingCells.length <= 20 &&
      layout.missingCells.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))) &&
    layout.palette && ['accent', 'ink', 'orange'].every(k => Array.isArray(layout.palette[k]) && layout.palette[k].length === 3 && layout.palette[k].every(Number.isFinite));
}

export function detectCardPoints(image, layout, options = {}) {
  if (!validInput(image, layout)) return {matches: [], diagnostics: {reason: 'invalid-input'}};
  options = options && typeof options === 'object' ? options : {};
  const {blob, step, componentCount} = components(image, layout);
  const diagnostics = {componentCount, candidateCount: blob.length, sampleStep: step, hypotheses: 0, method: 'none'};
  if (blob.length < 12) return {matches: [], diagnostics: {...diagnostics, reason: 'insufficient-components'}};
  let result = null;
  if (options.seedHomography) result = refine(Array.from(options.seedHomography), blob, layout, image);
  if (result) diagnostics.method = 'seed-refined';
  else if (options.allowGlobal !== false) {
    const global = globalAcquire(blob, layout, image);
    result = global.best; diagnostics.hypotheses = global.hypotheses;
    if (result) diagnostics.method = 'global-grid';
  }
  if (!result) return {matches: [], diagnostics: {...diagnostics, reason: 'pattern-not-confirmed'}};
  return {matches: result.pair.map(p => ({id: p.point.id, x: p.blob.x, y: p.blob.y,
    confidence: Math.max(0, Math.min(1, 1 - p.residual / Math.max(1, p.cell)))})), homography: result.h,
    diagnostics: {...diagnostics, reason: 'measured', rms: result.rms, relativeRms: result.relativeRms,
      colourCount: {accent: result.count.accent, ink: result.count.ink, orange: result.count.orange}}};
}
