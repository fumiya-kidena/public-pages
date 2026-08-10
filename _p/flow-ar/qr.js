import {
  assetObjectUrl,
  carryUnlockFragment,
  fetchAssetJson
} from "./secureAsset.js?v=1";
import {
  caseAnchorAlt,
  caseDisplayLabel,
  collectCaseReferences,
  resolveCaseManifestUrl,
  validatedCaseRecord
} from "./qrGalleryCore.js?v=1";

const gallery = document.getElementById("qr-gallery");
const status = document.getElementById("status");
const homeLink = document.getElementById("home-link");
const printButton = document.getElementById("print-all");

homeLink.href = carryUnlockFragment(new URL("./", document.baseURI)).href;
printButton.addEventListener("click", () => window.print());

function unlockedUrl(relativePath, caseId) {
  const url = new URL(relativePath, document.baseURI);
  if (caseId) url.searchParams.set("case", caseId);
  return carryUnlockFragment(url).href;
}

async function createCard(loadedCase, assetVersion) {
  const { definition, reference, physicalWidthCm, manifestUrl } = loadedCase;
  const displayLabel = caseDisplayLabel({
    definition,
    referenceLabel: reference.label
  });
  const imageUrl = new URL(
    definition.anchor.image,
    new URL(definition.assetRoot, manifestUrl)
  );
  if (assetVersion) imageUrl.searchParams.set("v", assetVersion);

  const card = document.createElement("article");
  card.className = "qr-card";
  card.dataset.caseId = definition.id;

  const heading = document.createElement("header");
  heading.className = "card-heading";
  const category = document.createElement("p");
  category.className = "category";
  category.textContent = reference.categoryLabel;
  const title = document.createElement("h2");
  title.textContent = displayLabel;
  heading.append(category, title);

  const poster = document.createElement("img");
  poster.className = "poster";
  poster.alt = caseAnchorAlt(definition.anchor, displayLabel, definition.id);
  poster.src = await assetObjectUrl(imageUrl, "image/png");
  poster.style.setProperty("--poster-print-width", `${physicalWidthCm}cm`);

  const printMeta = document.createElement("p");
  printMeta.className = "print-meta";
  printMeta.textContent = `印刷幅 ${physicalWidthCm} cm · A4 / 100%`;

  const action = document.createElement("nav");
  action.className = "card-action no-print";
  action.setAttribute("aria-label", `${displayLabel}の操作`);

  const open = document.createElement("a");
  open.href = unlockedUrl("./", definition.id);
  open.textContent = "FLOW ARで開く";

  const print = document.createElement("a");
  print.href = unlockedUrl("./marker.html", definition.id);
  print.textContent = "1枚だけ印刷";
  action.append(open, print);

  const instruction = document.createElement("p");
  instruction.className = "instruction";
  instruction.textContent = definition.anchor.webTracking?.target
    ? "QRを標準cameraで読むとcamera ARへ直接進みます。初期位置決定時はposter全体を数秒映してください。"
    : "QRを標準cameraで読み、画面の案内に従ってARを開始してください。";

  card.append(heading, poster, printMeta, action, instruction);
  return card;
}

async function loadCase(reference, catalogUrl) {
  const manifestUrl = resolveCaseManifestUrl(reference, catalogUrl);
  const definition = await fetchAssetJson(manifestUrl);
  return {
    ...validatedCaseRecord(definition, reference),
    manifestUrl
  };
}

async function initialize() {
  if (window.location.protocol === "file:") {
    throw new Error("file://では読み込めません。startServer.cmdを実行し、HTTP serverから開いてください。");
  }
  const catalogUrl = new URL("./case/catalog.json", document.baseURI);
  const catalog = await fetchAssetJson(catalogUrl);
  if (catalog.schemaVersion !== 1) throw new Error("Unsupported case catalog");

  const references = collectCaseReferences(catalog);
  if (!references.length) throw new Error("catalogに表示できるcaseがありません。");

  const settled = await Promise.allSettled(
    references.map((reference) => loadCase(reference, catalogUrl))
  );
  const loaded = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") loaded.push(result.value);
    else console.warn(`Skipped case ${references[index].id}:`, result.reason);
  });
  if (!loaded.length) throw new Error("印刷可能なQR posterがありません。");

  gallery.replaceChildren(...await Promise.all(
    loaded.map((item) => createCard(item, catalog.assetVersion))
  ));
  status.textContent = `${loaded.length} caseを表示中。印刷時はA4・倍率100%を指定してください。`;
  printButton.disabled = false;
}

initialize().catch((error) => {
  console.error(error);
  status.textContent = error.message;
  printButton.disabled = true;
});
