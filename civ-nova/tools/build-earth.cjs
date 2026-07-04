// Natural Earth 50m → 360x180 odd-r hex grid raster, with YnAEMP-style regional warp
// (Europe / SE Asia / Japan enlarged, oceans & poles compressed).
// Output: earth-data.json {cols, rows, land, lake, rivers, lonInv, latInv}
//   lonInv[k]: k in 0..720 → source longitude for normalized grid position k/720
//   latInv[k]: k in 0..360 → source latitude  for normalized grid position k/360
const fs = require('fs');

const COLS = 1080, ROWS = 540;
const land = JSON.parse(fs.readFileSync(__dirname + '/ne/ne_50m_land.geojson'));
const lakes = JSON.parse(fs.readFileSync(__dirname + '/ne/ne_50m_lakes.geojson'));
const rivers = JSON.parse(fs.readFileSync(__dirname + '/ne/ne_50m_rivers_lake_centerlines.geojson'));
const bathy200 = JSON.parse(fs.readFileSync(__dirname + '/ne/ne_10m_bathymetry_K_200.geojson'));
const bathy1000 = JSON.parse(fs.readFileSync(__dirname + '/ne/ne_10m_bathymetry_J_1000.geojson'));
const bathy3000 = JSON.parse(fs.readFileSync(__dirname + '/ne/ne_10m_bathymetry_H_3000.geojson'));
const bathy5000 = JSON.parse(fs.readFileSync(__dirname + '/ne/ne_10m_bathymetry_F_5000.geojson'));

// ---- regional density warp (higher density = region gets more hexes) ----
const bump = (x, c, w) => { const t = (x - c) / w; return Math.exp(-t * t); };
// v2 (2026-07-03): 拡大したい地域には lon/lat 対のバンプを与えて局所アスペクト比≈1を保つ。
// 片側だけのバンプは交差する陸地を縦横に歪ませる（旧: 豪州が横伸び、北米が縦伸び）
function lonDensity(lon) {
  let d = 1;
  d += 0.40 * bump(lon, 13, 13);    // Europe core
  d += 0.18 * bump(lon, -6, 7);     // UK / Iberia
  d += 0.64 * bump(lon, 108, 18);   // East & SE Asia
  d += 0.58 * bump(lon, 137, 8);    // Japan / Korea extra
  d += 0.42 * bump(lon, -96, 22);   // North America（縦伸び補正の対バンプ）
  d += 0.25 * bump(lon, 171, 6);    // New Zealand
  d -= 0.42 * bump(lon, -160, 22);  // Pacific (west half)
  d -= 0.35 * bump(lon, 179, 10);   // Pacific (east half, wrap side)
  d -= 0.28 * bump(lon, -33, 16);   // Atlantic
  return Math.max(0.35, d);
}
function latDensity(lat) {
  let d = 1;
  d += 0.60 * bump(lat, 48, 12);    // 欧州温帯ベルト（旧0.95から弱め、北米の縦伸びを緩和）
  d += 0.35 * bump(lat, 35, 11);    // 日本・地中海・米国・華南の中緯度帯
  d += 0.16 * bump(lat, -27, 8);    // オーストラリア帯（縦横比の対バンプ。大きくしすぎない）
  d -= 0.22 * bump(lat, 8, 18);     // 熱帯帯を圧縮（アフリカ縮小）
  d -= 0.62 * bump(lat, -77, 13);   // Antarctica
  d -= 0.38 * bump(lat, 67, 9);     // シベリア/北カナダ帯を圧縮（強め）
  d -= 0.60 * bump(lat, 80, 12);    // high Arctic（強め）
  return Math.max(0.30, d);
}
// cumulative integral → inverse lookup tables
function buildInverse(density, lo, hi, samples) {
  const STEP = 0.05;
  const xs = [], cum = [];
  let acc = 0;
  for (let x = lo; x <= hi + 1e-9; x += STEP) { xs.push(x); cum.push(acc); acc += density(x) * STEP; }
  const total = cum[cum.length - 1];
  const inv = [];
  let j = 0;
  for (let k = 0; k <= samples; k++) {
    const target = k / samples * total;
    while (j < cum.length - 1 && cum[j + 1] < target) j++;
    const t = (target - cum[j]) / Math.max(1e-9, (cum[j + 1] ?? total) - cum[j]);
    inv.push(+(xs[j] + STEP * Math.min(1, Math.max(0, t))).toFixed(3));
  }
  return inv;
}
const LON_SAMPLES = COLS, LAT_SAMPLES = ROWS;
const lonInv = buildInverse(lonDensity, -180, 180, LON_SAMPLES);
const latInvS2N = buildInverse(latDensity, -90, 90, LAT_SAMPLES);
const latInv = latInvS2N.slice().reverse(); // row 0 = north
const lookup = (inv, f, n) => {
  const x = Math.max(0, Math.min(n, f * n));
  const k = Math.floor(x), t = x - k;
  return inv[k] + (inv[Math.min(n, k + 1)] - inv[k]) * t;
};
// hex center (c,r) → source lon/lat
const lonOf = (c, r) => lookup(lonInv, (c + 0.5 * (r & 1) + 0.5) / COLS, LON_SAMPLES);
const latOf = r => lookup(latInv, (r + 0.5) / ROWS, LAT_SAMPLES);
// inverse: lon/lat → fractional grid coords (monotonic binary search)
function invLookup(inv, v, n, desc) {
  // ノード間を線形補間する逆引き（ステップ量子化だと交点が丸ごと1列ずれる）。
  // sim-core (Rust) の binary_invert と同一のセマンティクス
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (desc ? inv[mid] > v : inv[mid] < v) lo = mid + 1; else hi = mid;
  }
  if (lo <= 0) return 0;
  if (lo > n) return 1;
  const a = inv[lo - 1], b = inv[lo];
  const t = Math.min(1, Math.max(0, (v - a) / (b - a) || 0));
  return (lo - 1 + t) / n;
}
const colOfLon = (lon, r) => invLookup(lonInv, lon, LON_SAMPLES, false) * COLS - 0.5 * (r & 1) - 0.5;
const rowOfLat = lat => invLookup(latInv, lat, LAT_SAMPLES, true) * ROWS - 0.5;

// ---- geometry helpers ----
function collectRings(fc) {
  const polys = [];
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    const mp = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of mp) {
      let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
      for (const ring of poly) for (const [x, y] of ring) {
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
      polys.push({ poly, bbox: [minx, miny, maxx, maxy], props: f.properties });
    }
  }
  return polys;
}
function inPoly(poly, x, y) {
  let inside = false;
  for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
function raster(polys, filter) {
  const mask = new Uint8Array(COLS * ROWS);
  const use = filter ? polys.filter(filter) : polys;
  for (const p of use) {
    const [minx, miny, maxx, maxy] = p.bbox;
    const r0 = Math.max(0, Math.floor(rowOfLat(maxy)) - 1);
    const r1 = Math.min(ROWS - 1, Math.ceil(rowOfLat(miny)) + 1);
    for (let r = r0; r <= r1; r++) {
      const lat = latOf(r);
      if (lat < miny || lat > maxy) continue;
      const c0 = Math.max(0, Math.floor(colOfLon(minx, r)) - 1);
      const c1 = Math.min(COLS - 1, Math.ceil(colOfLon(maxx, r)) + 1);
      for (let c = c0; c <= c1; c++) {
        const i = r * COLS + c;
        if (mask[i]) continue;
        const lon = lonOf(c, r);
        if (lon < minx || lon > maxx) continue;
        if (inPoly(p.poly, lon, lat)) mask[i] = 1;
      }
    }
  }
  return mask;
}

// 等深線のような巨大ポリゴン向け: 行スキャンライン方式（ポリゴン単位の偶奇規則）
function rasterScanline(fc) {
  const mask = new Uint8Array(COLS * ROWS);
  const rowLats = Array.from({ length: ROWS }, (_, r) => latOf(r));
  let oddRows = 0;
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    const mp = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of mp) {
      // このポリゴン（穴含む）の行バケツ
      let latMin = 1e9, latMax = -1e9;
      for (const ring of poly) for (const [, y] of ring) { if (y < latMin) latMin = y; if (y > latMax) latMax = y; }
      const rTopAll = Math.max(0, Math.ceil(rowOfLat(latMax)));
      const rBotAll = Math.min(ROWS - 1, Math.floor(rowOfLat(latMin)));
      if (rBotAll < rTopAll) continue;
      const buckets = new Map();
      for (const ring of poly) {
        // 環の経度を連続化（反子午線ジャンプを累積オフセットで除去）。
        // ±180の飛びのまま補間すると偽の交点が地図中央に走り、シーム帯の偶奇が壊れる
        const ux = new Array(ring.length);
        let off = 0;
        ux[0] = ring[0][0];
        for (let i = 1; i < ring.length; i++) {
          let xa = ring[i][0] + off;
          const px = ux[i - 1];
          while (xa - px > 180) { off -= 360; xa -= 360; }
          while (px - xa > 180) { off += 360; xa += 360; }
          ux[i] = xa;
        }
        // 巻き数≠0（極を囲む環）は連続展開で偶奇が成立しない。既存挙動（余り交点は捨てる）に退避
        const wind = Math.round((ux[ring.length - 1] - ux[0]) / 360);
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const y1 = ring[j][1], y2 = ring[i][1];
          if (y1 === y2) continue;
          let x1 = ux[j], x2 = ux[i];
          if (wind !== 0) {
            // 極環: 各辺を単独で正規化（従来方式）
            x1 = ring[j][0]; x2 = ring[i][0];
            if (x2 - x1 > 180) x2 -= 360; else if (x1 - x2 > 180) x2 += 360;
          }
          const ylo = Math.min(y1, y2), yhi = Math.max(y1, y2);
          const rTop = Math.max(rTopAll, Math.ceil(rowOfLat(yhi)) - 1);
          const rBot = Math.min(rBotAll, Math.floor(rowOfLat(ylo)) + 1);
          for (let r = rTop; r <= rBot; r++) {
            const lat = rowLats[r];
            if (lat < ylo || lat >= yhi) continue;
            const x = x1 + (x2 - x1) * (lat - y1) / (y2 - y1);
            let b = buckets.get(r);
            if (!b) { b = []; buckets.set(r, b); }
            b.push(x);
          }
        }
      }
      // 連続経度 → 連続列（ラップ対応: 期間ごとに±COLSずれる単調写像）
      const colU = (x, r) => {
        const k = Math.floor((x + 180) / 360);
        return colOfLon(x - 360 * k, r) + k * COLS;
      };
      for (const [r, xs] of buckets) {
        xs.sort((a, b) => a - b);
        if (xs.length & 1) oddRows++;
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const c0 = Math.ceil(colU(xs[k], r));
          const c1 = Math.floor(colU(xs[k + 1], r));
          for (let c = c0; c <= c1; c++) mask[r * COLS + ((c % COLS) + COLS) % COLS] = 1;
        }
      }
    }
  }
  if (oddRows) console.error('scanline odd-crossing rows:', oddRows);
  return mask;
}

console.error('rasterizing land...');
const landPolys = collectRings(land);
const landMask = raster(landPolys);
console.error('rasterizing lakes...');
const lakePolys = collectRings(lakes);
const lakeMask = raster(lakePolys, p => (p.props.scalerank ?? 9) <= 6);

// 小さな島: セル中心サンプリングで消えた島をポリゴン重心で最寄セルにスナップ
let snapped = 0;
for (const p of landPolys) {
  const [minx, miny, maxx, maxy] = p.bbox;
  const dim = Math.max(maxx - minx, maxy - miny);
  if (dim > 3 || dim < 0.12) continue;
  const ring = p.poly[0];
  let sx = 0, sy = 0;
  for (const [x, y] of ring) { sx += x; sy += y; }
  const lon = sx / ring.length, lat = sy / ring.length;
  if (lat < -60) continue;                       // 南極周辺の岩礁は除外
  const r = Math.max(0, Math.min(ROWS - 1, Math.round(rowOfLat(lat))));
  const c = Math.max(0, Math.min(COLS - 1, Math.round(colOfLon(lon, r))));
  if (landMask[r * COLS + c]) continue;
  // 既存の陸に貼り付いて半島化するのを防ぐ: 陸隣接が2以下のセルだけ島にする
  const nbs = (r & 1) ? [[1,0],[-1,0],[1,-1],[0,-1],[1,1],[0,1]] : [[1,0],[-1,0],[0,-1],[-1,-1],[0,1],[-1,1]];
  let landNb = 0;
  for (const [dc, dr] of nbs) {
    const nc = c + dc, nr = r + dr;
    if (nc >= 0 && nc < COLS && nr >= 0 && nr < ROWS && landMask[nr * COLS + nc]) landNb++;
  }
  if (landNb <= 2) { landMask[r * COLS + c] = 1; snapped++; }
}
console.error('small islands snapped:', snapped);

// 主要海峡の開削: 粗いラスタで陸続きになりがちな水路を強制的に海へ
const STRAITS = [
  [[-5.8,35.97],[-5.2,35.95]],   // ジブラルタル
  [[1.2,51.05],[1.8,50.85]],     // ドーバー
  [[29.05,41.2]],                // ボスポラス
  [[26.2,40.3],[26.6,40.0]],     // ダーダネルス
  [[36.55,45.35]],               // ケルチ
  [[56.4,26.7]],                 // ホルムズ
  [[43.3,12.6]],                 // バブ・エル・マンデブ
  [[99.5,4.0],[103.8,1.2]],      // マラッカ
  [[105.9,-5.9]],                // スンダ
  [[120.0,24.4],[120.6,23.4]],   // 台湾海峡
  [[110.15,20.15]],              // 瓊州（海南島）
  [[129.0,34.6],[129.5,34.2]],   // 対馬/朝鮮海峡
  [[140.35,41.55]],              // 津軽
  [[141.9,45.75]],               // 宗谷
  [[-169.6,65.7]],               // ベーリング
  [[142.4,-10.1]],               // トレス
  [[146.3,-39.6]],               // バス
  [[174.4,-41.4]],               // クック
  [[15.55,38.25]],               // メッシーナ
  [[79.6,9.5]],                  // ポーク（インド-スリランカ）
  [[-70.9,-53.6],[-68.5,-52.6]], // マゼラン
  [[12.65,55.95]],               // エーレスンド
  [[11.0,55.3]],                 // グレートベルト
  [[130.95,33.95],[132.4,34.15],[133.6,34.3],[134.6,34.45]], // 関門〜瀬戸内海
  [[134.9,34.35],[135.05,33.85]],// 紀伊水道
  [[131.9,33.35],[132.15,33.05]],// 豊後水道
  [[141.3,52.3]],                // 間宮海峡（タタール）
];
let carved = 0;
for (const seg of STRAITS) {
  const pts = seg.length === 1 ? [seg[0]] : Array.from({length: 41}, (_, k) => {
    const t = k / 40;
    return [seg[0][0] + (seg[1][0] - seg[0][0]) * t, seg[0][1] + (seg[1][1] - seg[0][1]) * t];
  });
  for (const [lon, lat] of pts) {
    const r = Math.max(0, Math.min(ROWS - 1, Math.round(rowOfLat(lat))));
    const c = Math.max(0, Math.min(COLS - 1, Math.round(colOfLon(lon, r))));
    if (landMask[r * COLS + c]) { landMask[r * COLS + c] = 0; carved++; }
    lakeMask[r * COLS + c] = 0;
  }
}
console.error('strait cells carved:', carved);
// 小さな湖も同様に（陸セル上のみ）
let lsnap = 0;
for (const p of lakePolys) {
  if ((p.props.scalerank ?? 9) > 6) continue;
  const [minx, miny, maxx, maxy] = p.bbox;
  const dim = Math.max(maxx - minx, maxy - miny);
  if (dim > 3 || dim < 0.3) continue;
  const ring = p.poly[0];
  let sx = 0, sy = 0;
  for (const [x, y] of ring) { sx += x; sy += y; }
  const lon = sx / ring.length, lat = sy / ring.length;
  const r = Math.max(0, Math.min(ROWS - 1, Math.round(rowOfLat(lat))));
  const c = Math.max(0, Math.min(COLS - 1, Math.round(colOfLon(lon, r))));
  if (landMask[r * COLS + c] && !lakeMask[r * COLS + c]) { lakeMask[r * COLS + c] = 1; lsnap++; }
}
console.error('small lakes snapped:', lsnap);

console.error('rasterizing bathymetry (200m shelf)...');
const deepMask = rasterScanline(bathy200);   // 水深200m超の海域
const NB_E = [[1,0],[-1,0],[0,-1],[-1,-1],[0,1],[-1,1]], NB_O = [[1,0],[-1,0],[1,-1],[0,-1],[1,1],[0,1]];
const shallowMask = new Uint8Array(COLS * ROWS);
let shallowCount = 0;
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
  const i = r * COLS + c;
  if (landMask[i] || lakeMask[i]) continue;
  let sh = !deepMask[i];                     // 実データの大陸棚
  if (!sh) {                                 // 陸に接するセルは最低限浅海に
    for (const [dc, dr] of (r & 1) ? NB_O : NB_E) {
      const nc = c + dc, nr = r + dr;
      if (nc >= 0 && nc < COLS && nr >= 0 && nr < ROWS && landMask[nr * COLS + nc]) { sh = true; break; }
    }
  }
  if (sh) { shallowMask[i] = 1; shallowCount++; }
}
console.error('shallow sea hexes:', shallowCount);

console.error('rasterizing depth bands (1000/3000/5000m)...');
const deep1000 = rasterScanline(bathy1000);
const deep3000 = rasterScanline(bathy3000);
const deep5000 = rasterScanline(bathy5000);
// 水セル以外は0に落として包含関係を保証
for (let i = 0; i < COLS * ROWS; i++) {
  if (landMask[i] || lakeMask[i] || shallowMask[i]) { deep1000[i] = 0; deep3000[i] = 0; deep5000[i] = 0; continue; }
  if (deep5000[i]) deep3000[i] = 1;
  if (deep3000[i]) deep1000[i] = 1;
}

console.error('rivers...');
const rvs = [];
for (const f of rivers.features) {
  const sr = f.properties.scalerank ?? 9;
  if (sr > 6) continue;   // ランク6まで拾って本数を増やす（旧: 5まで/130本）
  const g = f.geometry;
  const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
  for (const line of lines) {
    const cells = [];
    for (const [lon, lat] of line) {
      const r = Math.max(0, Math.min(ROWS - 1, Math.round(rowOfLat(lat))));
      const c = Math.max(0, Math.min(COLS - 1, Math.round(colOfLon(lon, r))));
      const last = cells[cells.length - 1];
      if (!last || last[0] !== c || last[1] !== r) cells.push([c, r]);
    }
    if (cells.length >= 3) rvs.push({ sr, cells });
  }
}
rvs.sort((a, b) => a.sr - b.sr || b.cells.length - a.cells.length);
const kept = rvs.slice(0, 550);
const keep = kept.map(x => x.cells.flat());
const riverRanks = kept.map(x => x.sr);   // 0(大河)〜6(中河川)。描画の太さに使う
console.error('rivers kept:', keep.length);

function rle(mask) {
  const out = [];
  let run = 1;
  for (let i = 1; i <= mask.length; i++) {
    if (i < mask.length && mask[i] === mask[i - 1]) { run++; continue; }
    out.push(run); run = 1;
  }
  return { first: mask[0], runs: out };
}
const data = { cols: COLS, rows: ROWS, land: rle(landMask), lake: rle(lakeMask), shallow: rle(shallowMask), d1000: rle(deep1000), d3000: rle(deep3000), d5000: rle(deep5000), rivers: keep, riverRanks, lonInv, latInv };
fs.writeFileSync(__dirname + '/earth-data.json', JSON.stringify(data));
const landCount = landMask.reduce((a, b) => a + b, 0);
console.error(`done. land: ${landCount} hexes (${(landCount / (COLS * ROWS) * 100).toFixed(1)}%), json: ${JSON.stringify(data).length}B`);
