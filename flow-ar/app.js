import { deviceProfile, setupTabletLandscapeGate } from "./deviceSupport.js?v=1";

const viewer = document.getElementById("droplet-viewer");
const nativeArButton = document.getElementById("native-ar-button");
const markerArButton = document.getElementById("marker-ar-button");
const stageVideo = document.getElementById("stage-video");
const gestureHint = document.getElementById("gesture-hint");
const modePicker = document.getElementById("mode-picker");
const modeTitle = document.getElementById("mode-title");
const modeDescription = document.getElementById("mode-description");
const modeScale = document.getElementById("mode-scale");
const modeMagnification = document.getElementById("mode-magnification");
const colourLegend = document.getElementById("colour-legend");
const playButton = document.getElementById("play-button");
const arMessage = document.getElementById("ar-message");
const modeSource = document.getElementById("mode-source");
const modeSourcePrefix = document.getElementById("mode-source-prefix");
const modeSourceLink = document.getElementById("mode-source-link");
const reference = document.getElementById("reference");
const referenceVideo = document.getElementById("reference-video");
const referenceSource = document.getElementById("reference-source");
const referenceNote = document.getElementById("reference-note");
const loadState = document.getElementById("load-state");
const orientationGate = document.getElementById("orientation-gate");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isAppleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

let manifest;
let selectedMode;
let isPlaying = !reduceMotion;
let resumeAfterVisibility = false;
let resumeAfterLandscape = false;
let landscapeBlocked = false;
const modeIndex = new Map();
const caseIndex = new Map();

function modeKey(caseId, modeId) {
  return `${caseId}:${modeId}`;
}

function findModeKey(modeId, caseId = null) {
  if (caseId) {
    return caseIndex.get(caseId)?.modeIds.has(modeId)
      ? modeKey(caseId, modeId)
      : null;
  }
  for (const [key, mode] of modeIndex) {
    if (mode.id === modeId) return key;
  }
  return null;
}

function appendVersion(path, version) {
  const url = new URL(path, document.baseURI);
  if (version) url.searchParams.set("v", version);
  return url.href;
}

function assetUrl(mode, path) {
  const root = new URL(mode.assetRoot, mode.manifestUrl);
  return appendVersion(new URL(path, root).href, manifest.assetVersion);
}

function registerCase(caseDefinition, group, showCaseLabel = false) {
  if (caseIndex.has(caseDefinition.id)) {
    throw new Error(`Duplicate case id: ${caseDefinition.id}`);
  }
  const modeIds = caseDefinition.modes.map((mode) => mode.id);
  const defaultMode = caseDefinition.defaultMode || modeIds[0];
  if (!modeIds.includes(defaultMode)) {
    throw new Error(`Unknown defaultMode for ${caseDefinition.id}`);
  }
  caseIndex.set(caseDefinition.id, { defaultMode, modeIds: new Set(modeIds) });

  for (const definition of caseDefinition.modes) {
    const key = modeKey(caseDefinition.id, definition.id);
    if (modeIndex.has(key)) {
      throw new Error(`Duplicate mode id in ${caseDefinition.id}: ${definition.id}`);
    }
    if (!definition.kind || !["model", "video"].includes(definition.kind)) {
      throw new Error(`Unsupported kind for ${definition.id}`);
    }
    const mode = {
      ...definition,
      anchor: caseDefinition.anchor,
      assetRoot: caseDefinition.assetRoot,
      caseId: caseDefinition.id,
      key,
      manifestUrl: caseDefinition.manifestUrl
    };
    modeIndex.set(key, mode);

    const option = document.createElement("option");
    option.value = key;
    option.textContent = showCaseLabel
      ? `${caseDefinition.label} · ${mode.label}`
      : mode.label;
    group.append(option);
  }
}

function buildModePicker() {
  modePicker.replaceChildren();
  for (const category of manifest.categories) {
    const group = document.createElement("optgroup");
    group.label = category.label;
    const showCaseLabel = category.loadedCase.length > 1;
    for (const caseDefinition of category.loadedCase) {
      registerCase(caseDefinition, group, showCaseLabel);
    }
    modePicker.append(group);
  }

  for (const caseDefinition of manifest.loadedAuxiliary || []) {
    const group = document.createElement("optgroup");
    group.label = caseDefinition.groupLabel;
    registerCase(caseDefinition, group);
    modePicker.append(group);
  }
  modePicker.disabled = false;
}

async function loadManifest() {
  const catalogUrl = new URL("./case/catalog.json", document.baseURI);
  const response = await fetch(catalogUrl, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
  manifest = await response.json();
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.categories)) {
    throw new Error("Unsupported case catalog");
  }

  async function loadCase(reference) {
    const caseUrl = new URL(reference.manifest, catalogUrl);
    const caseResponse = await fetch(caseUrl, { cache: "no-cache" });
    if (!caseResponse.ok) throw new Error(`Case ${reference.id} HTTP ${caseResponse.status}`);
    const caseDefinition = await caseResponse.json();
    if (
      caseDefinition.schemaVersion !== 1 ||
      caseDefinition.id !== reference.id ||
      !Array.isArray(caseDefinition.modes)
    ) {
      throw new Error(`Invalid case manifest: ${reference.id}`);
    }
    caseDefinition.manifestUrl = caseUrl.href;
    return caseDefinition;
  }

  async function loadAvailableCase(referenceList, auxiliary = false) {
    const settled = await Promise.allSettled(referenceList.map(loadCase));
    const loaded = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        if (auxiliary) result.value.groupLabel = referenceList[index].label;
        loaded.push(result.value);
      } else {
        console.warn(`Skipped case ${referenceList[index].id}:`, result.reason);
      }
    });
    return loaded;
  }

  await Promise.all(manifest.categories.map(async (category) => {
    category.loadedCase = await loadAvailableCase(category.case || []);
  }));
  manifest.categories = manifest.categories.filter((category) => category.loadedCase.length);
  manifest.loadedAuxiliary = await loadAvailableCase(manifest.auxiliary || [], true);
  if (!manifest.categories.length && !manifest.loadedAuxiliary.length) {
    throw new Error("No valid case manifest is available");
  }
  buildModePicker();
}

function updateModeUrl(mode) {
  const url = new URL(window.location.href);
  url.searchParams.set("case", mode.caseId);
  url.searchParams.set("mode", mode.id);
  window.history.replaceState(null, "", url);
}

function setLoading(isLoading, message = "3Dを読み込み中…") {
  viewer.setAttribute("aria-busy", String(isLoading));
  loadState.hidden = !isLoading;
  loadState.textContent = message;
  playButton.disabled = isLoading;
}

function updatePlayButton() {
  playButton.textContent = isPlaying ? "一時停止" : "再生";
  const mediaName = selectedMode?.kind === "video" ? "動画" : "3D animation";
  playButton.setAttribute("aria-label", isPlaying ? `${mediaName}を一時停止` : `${mediaName}を再生`);
}

function updateArAvailability() {
  if (!selectedMode) return;
  if (selectedMode.kind === "video") {
    markerArButton.hidden = true;
    nativeArButton.hidden = true;
    nativeArButton.classList.remove("secondary-ar-button");
    arMessage.textContent = "このmodeは動画表示です。AR対応3Dがあるcaseはselectorから切り替えられます。";
    return;
  }
  const webTracking = selectedMode.anchor?.webTracking;
  if (webTracking?.target) {
    const markerUrl = new URL(webTracking.page || "./markerAr.html", document.baseURI);
    markerUrl.searchParams.set("case", selectedMode.caseId);
    markerUrl.searchParams.set("mode", selectedMode.id);
    markerArButton.href = markerUrl.href;
    markerArButton.textContent = selectedMode.anchor?.worldTracking?.target
      ? "camera ARで再生"
      : "QR marker ARで再生";
    markerArButton.hidden = false;
    const showAndroidNativeFallback = deviceProfile.isAndroid && viewer.canActivateAR;
    nativeArButton.hidden = !showAndroidNativeFallback;
    nativeArButton.classList.toggle("secondary-ar-button", showAndroidNativeFallback);
    nativeArButton.textContent = showAndroidNativeFallback ? "標準AR（簡易）" : "ARで見る";
    arMessage.textContent = deviceProfile.isAndroid
      ? "camera ARが本命です。Chrome／Firefox／Samsung Internet／Edgeで開始し、最初だけ色付きQR posterへ位置を合わせます。非対応なら標準AR（簡易）を使えます。"
      : "印刷した色付きQR posterを机に置き、「camera ARで再生」からcameraを開始してください。";
    return;
  }
  markerArButton.hidden = true;
  nativeArButton.hidden = false;
  nativeArButton.classList.remove("secondary-ar-button");
  nativeArButton.textContent = "ARで見る";
  if (selectedMode.iosAnchorSrc && isAppleMobile && viewer.canActivateAR) {
    arMessage.textContent = "「ARで見る」を押し、印刷したQR posterをcameraに入れると、その位置へ固定されます。";
    return;
  }
  if (deviceProfile.isAndroid && viewer.canActivateAR) {
    arMessage.textContent = "「ARで見る」を押すと、WebXRまたはGoogle Scene Viewerで平らな面へ配置できます。";
    return;
  }
  arMessage.textContent = viewer.canActivateAR
    ? "「ARで見る」を押し、平らな面へ配置してください。iPhoneでは対応posterへ固定できます。"
    : "この環境ではARを起動できないため、3D表示を使用できます。";
}

function updateReference(mode) {
  reference.hidden = !mode.reference;
  if (!mode.reference) {
    reference.open = false;
    referenceVideo.pause();
    return;
  }
  referenceSource.src = assetUrl(mode, mode.reference.video);
  referenceVideo.load();
  referenceNote.textContent = mode.reference.note;
}

function updateSource(mode) {
  modeSource.hidden = !mode.source;
  if (!mode.source) return;
  modeSourcePrefix.textContent = mode.source.prefix || "Source:";
  modeSourceLink.href = mode.source.url;
  modeSourceLink.textContent = mode.source.label;
}

function selectMode(key, syncUrl = true) {
  const mode = modeIndex.get(key);
  if (!mode) return;
  selectedMode = mode;
  modePicker.value = key;
  modeTitle.textContent = mode.title;
  modeDescription.textContent = mode.description;
  modeScale.textContent = mode.scale;
  modeMagnification.textContent = mode.magnification;
  colourLegend.hidden = !mode.legend;
  updateReference(mode);
  updateSource(mode);
  // Scientific result playback is primary content, not decorative motion.
  // Keep the explicit pause control available, but start the selected result.
  isPlaying = true;

  if (mode.kind === "video") {
    viewer.pause();
    viewer.hidden = true;
    gestureHint.hidden = true;
    stageVideo.hidden = false;
    stageVideo.poster = assetUrl(mode, mode.poster);
    const videoSrc = assetUrl(mode, mode.videoSrc);
    if (stageVideo.src !== videoSrc) {
      stageVideo.src = videoSrc;
      stageVideo.load();
    }
    setLoading(false);
    if (isPlaying) {
      stageVideo.play().catch(() => {
        isPlaying = false;
        updatePlayButton();
      });
    }
  } else {
    stageVideo.pause();
    stageVideo.hidden = true;
    viewer.hidden = false;
    gestureHint.hidden = false;
    setLoading(true);
    viewer.setAttribute("animation-name", mode.animationName);
    viewer.setAttribute("src", assetUrl(mode, mode.src));
    viewer.setAttribute("ios-src", assetUrl(mode, mode.iosAnchorSrc || mode.iosSrc));
    viewer.alt = mode.alt;
    viewer.setAttribute("exposure", String(mode.exposure));
    viewer.setAttribute("camera-orbit", mode.cameraOrbit);
    if (mode.cameraTarget) viewer.setAttribute("camera-target", mode.cameraTarget);
    else viewer.removeAttribute("camera-target");
  }

  updateArAvailability();
  updatePlayButton();
  if (landscapeBlocked && isPlaying) {
    resumeAfterLandscape = true;
    if (mode.kind === "video") stageVideo.pause();
    else viewer.pause();
  }
  if (syncUrl) updateModeUrl(mode);
  if (reference.open && !reduceMotion) referenceVideo.play().catch(() => {});
}

modePicker.addEventListener("change", () => selectMode(modePicker.value));

playButton.addEventListener("click", () => {
  const activeMedia = selectedMode.kind === "video" ? stageVideo : viewer;
  if (isPlaying) activeMedia.pause();
  else activeMedia.play();
  isPlaying = !isPlaying;
  updatePlayButton();
});

reference.addEventListener("toggle", () => {
  if (reference.open && !reduceMotion) referenceVideo.play().catch(() => {});
  else referenceVideo.pause();
});

stageVideo.addEventListener("play", () => {
  if (selectedMode?.kind !== "video") return;
  isPlaying = true;
  updatePlayButton();
});

stageVideo.addEventListener("pause", () => {
  if (selectedMode?.kind !== "video") return;
  isPlaying = false;
  updatePlayButton();
});

stageVideo.addEventListener("error", () => {
  if (selectedMode?.kind !== "video") return;
  arMessage.textContent = "動画を読み込めませんでした。通信または配信設定を確認してください。";
});

viewer.addEventListener("progress", (event) => {
  if (loadState.hidden) return;
  const percent = Math.round((event.detail.totalProgress || 0) * 100);
  loadState.textContent = percent > 0 ? `3Dを読み込み中 ${percent}%` : "3Dを読み込み中…";
});

viewer.addEventListener("ar-status", (event) => {
  const anchored = isAppleMobile && Boolean(selectedMode?.iosAnchorSrc);
  const message = {
    "session-started": anchored
      ? "ARを開始しました。印刷したQR poster全体をゆっくり映してください。"
      : "ARを開始しました。平らな面をゆっくり映してください。",
    "object-placed": anchored
      ? "QR posterへ固定されました。端末を動かして形状を観察できます。"
      : "配置できました。端末を動かして形状を観察できます。",
    "failed": "ARを開始できないため、このまま3D表示を使用します。",
    "not-presenting": "ARを終了しました。"
  }[event.detail.status];
  if (message) arMessage.textContent = message;
});

viewer.addEventListener("error", () => {
  if (selectedMode?.kind !== "model") return;
  setLoading(false);
  arMessage.textContent = "3D modelを読み込めませんでした。通信または配信設定を確認してください。";
});

viewer.addEventListener("load", () => {
  if (selectedMode?.kind !== "model") return;
  setLoading(false);
  updateArAvailability();
  const initialTime = selectedMode.initialTime;
  if (Number.isFinite(initialTime)) viewer.currentTime = initialTime;
  if (isPlaying) viewer.play();
  else viewer.pause();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    resumeAfterVisibility = isPlaying;
    viewer.pause();
    stageVideo.pause();
    referenceVideo.pause();
    return;
  }
  if (!resumeAfterVisibility) return;
  if (landscapeBlocked) {
    resumeAfterLandscape = true;
    resumeAfterVisibility = false;
    return;
  }
  isPlaying = true;
  if (selectedMode.kind === "video") stageVideo.play().catch(() => {});
  else viewer.play();
  if (reference.open && !reduceMotion) referenceVideo.play().catch(() => {});
  resumeAfterVisibility = false;
  updatePlayButton();
});

window.addEventListener("offline", () => {
  arMessage.textContent = "通信が切れました。読み込み済みの表示はそのまま操作できます。";
});

window.addEventListener("online", updateArAvailability);

setupTabletLandscapeGate(orientationGate, (blocked, previous) => {
  landscapeBlocked = blocked;
  if (blocked) {
    resumeAfterLandscape = Boolean(selectedMode && isPlaying);
    if (selectedMode?.kind === "video") stageVideo.pause();
    else if (selectedMode) viewer.pause();
    return;
  }

  if (previous && resumeAfterLandscape && selectedMode) {
    isPlaying = true;
    if (selectedMode.kind === "video") stageVideo.play().catch(() => {});
    else viewer.play();
    updatePlayButton();
  }
  resumeAfterLandscape = false;
  updateArAvailability();
});

Promise.all([customElements.whenDefined("model-viewer"), loadManifest()])
  .then(() => {
    const requestedCase = new URLSearchParams(window.location.search).get("case");
    const rawMode = new URLSearchParams(window.location.search).get("mode");
    const requestedMode = manifest.aliases?.[rawMode] || rawMode;
    const requestedKey = requestedMode ? findModeKey(requestedMode, requestedCase) : null;
    const caseDefault = caseIndex.get(requestedCase)?.defaultMode;
    const initialKey = requestedKey
      || (caseDefault ? findModeKey(caseDefault, requestedCase) : null)
      || findModeKey(manifest.defaultMode)
      || modeIndex.keys().next().value;
    selectMode(initialKey, true);
  })
  .catch((error) => {
    console.error(error);
    modePicker.disabled = true;
    setLoading(false);
    arMessage.textContent = "表示caseを読み込めませんでした。HTTP serverから開いてください。";
  });
