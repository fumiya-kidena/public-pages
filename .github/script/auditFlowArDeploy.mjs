import assert from "node:assert/strict";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const privateRoot = path.join(root, "_p", "flow-ar");
const legacyRoot = path.join(root, "flow-ar");
const entryName = ["index", "marker", "markerAr", "imageMarkerAr", "qr"];
const forbiddenExtension = new Set([
  ".glb", ".gltf", ".usdz", ".mp4", ".webm", ".mind", ".png", ".jpg",
  ".jpeg", ".webp", ".json", ".obj", ".stl", ".vtk", ".vti", ".vtr",
  ".vtu", ".vtp", ".pvd", ".csv", ".bin"
]);
const localPathPattern = /(?:[A-Za-z]:\\|GoogleDrive|マイドライブ|Research[\\/]Misc)/;
const conflictPattern = /^(?:<<<<<<<|=======|>>>>>>>)$/m;

async function exists(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function walk(directory) {
  const output = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name);
    if (item.isDirectory()) output.push(...await walk(absolute));
    if (item.isFile()) output.push(absolute);
  }
  return output;
}

assert.equal(await exists(path.join(root, ".nojekyll")), true, ".nojekyll is required");

for (const name of entryName) {
  const html = await readFile(path.join(privateRoot, `${name}.html`), "utf8");
  assert.match(html, /StatiCrypt/i, `${name}.html is not a StatiCrypt wrapper`);
  assert.match(html, /noindex,nofollow,noarchive/i, `${name}.html is missing noindex`);
  assert.doesNotMatch(html, localPathPattern, `${name}.html exposes a local path`);
  assert.doesNotMatch(html, conflictPattern, `${name}.html contains a conflict marker`);

  const redirect = await readFile(path.join(legacyRoot, `${name}.html`), "utf8");
  assert.match(redirect, /noindex,nofollow,noarchive/i, `legacy ${name}.html is missing noindex`);
  assert.match(redirect, /target\.search\s*=\s*window\.location\.search/,
    `legacy ${name}.html does not preserve the query`);
  assert.match(redirect, /target\.hash\s*=\s*window\.location\.hash/,
    `legacy ${name}.html does not preserve the hash`);
  assert.match(redirect, /window\.location\.replace\(target\.href\)/,
    `legacy ${name}.html is not a replace redirect`);
}

const assetRoot = path.join(privateRoot, "assetPack");
const encryptedAsset = await readdir(assetRoot, { withFileTypes: true });
assert.ok(encryptedAsset.length > 0, "assetPack is empty");
for (const item of encryptedAsset) {
  assert.equal(item.isFile(), true, `assetPack contains a directory: ${item.name}`);
  assert.match(item.name, /^[0-9a-f]{32}\.enc$/, `invalid asset name: ${item.name}`);
  const handle = await open(path.join(assetRoot, item.name), "r");
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    assert.equal(bytesRead, 4, `encrypted asset is too short: ${item.name}`);
    assert.equal(header.toString("ascii"), "FAR1", `invalid FAR1 header: ${item.name}`);
  } finally {
    await handle.close();
  }
}

for (const file of await walk(privateRoot)) {
  if (file.startsWith(`${assetRoot}${path.sep}`)) continue;
  const extension = path.extname(file).toLowerCase();
  assert.equal(forbiddenExtension.has(extension), false,
    `plaintext data extension in private deployment: ${path.relative(root, file)}`);
  if (file.startsWith(`${path.join(privateRoot, "vendor")}${path.sep}`)) continue;
  if (![".html", ".js", ".txt", ".svg"].includes(extension)) continue;
  const content = await readFile(file, "utf8");
  assert.equal(content.includes("\r"), false, `CRLF detected: ${path.relative(root, file)}`);
  assert.doesNotMatch(content, localPathPattern, `local path detected: ${path.relative(root, file)}`);
  assert.doesNotMatch(content, conflictPattern, `conflict marker detected: ${path.relative(root, file)}`);
}

for (const file of (await readdir(privateRoot)).filter((name) => name.endsWith(".js"))) {
  const result = spawnSync(process.execPath, ["--check", path.join(privateRoot, file)], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, `${file} failed node --check\n${result.stderr}`);
}

const rootIndex = await readFile(path.join(root, "index.html"), "utf8");
assert.match(rootIndex, /name\.charAt\(0\)!==['"]_['"]/, "root index does not hide underscore paths");
assert.match(rootIndex, /HIDDEN\s*=\s*\[[^\]]*['"]flow-ar['"]/,
  "root index does not hide the legacy FLOW AR path");

console.log(`FLOW AR deployment audit passed: ${encryptedAsset.length} encrypted assets`);
