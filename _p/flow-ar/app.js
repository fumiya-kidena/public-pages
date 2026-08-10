import { deviceProfile, setupTabletLandscapeGate } from "./deviceSupport.js?v=1";
import {
  assetObjectUrl,
  carryUnlockFragment,
  fetchAssetJson,
  usesEncryptedAssets
} from "./secureAsset.js?v=1";
import {
  hasPlayableTimeline,
  isStaticMode
} from "./playbackModeCore.js?v=1";

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
const playbackControls = document.getElementById("playback-controls");
const playButton = document.getElementById("play-button");
const playbackSeek = document.getElementById("playback-seek");
const playbackTime = document.getElementById("playback-time");
const playbackSpeed = document.getElementById("playback-speed");
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
let selectionSerial = 0;
let mediaLoading = true;
let isSeeking = false;
let resumeAfterSeek = false;
let playbackRate = 1;
let playbackAnimationFrame = null;
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

function assetSourceUrl(mode, path) {
  const root = new URL(mode.assetRoot, mode.manifestUrl);
  return appendVersion(new URL(path, root).href, manifest.assetVersion);
}

function assetUrl(mode, path) {
  return assetObjectUrl(assetSourceUrl(mode, path));
}

function activeMedia() {
  if (!selectedMode) return null;
  return selectedMode.kind === "video" ? stageVideo : viewer;
}

function activeDuration() {
  if (isStaticMode(selectedMode)) return 0;
  const duration = Number(activeMedia()?.duration);
  return Number.isFinite(duration) && duration > 0.001 ? duration : 0;
}

function positiveTimingNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegativeTimingNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function modeTiming(mode, clipDuration = 0) {
  const timing = mode?.timing || {};
  const sourceDurationSecond = positiveTimingNumber(timing.sourceDurationSecond);
  const storedFrameCount = positiveTimingNumber(timing.storedFrameCount);
  const sourceFrameCount = positiveTimingNumber(timing.sourceFrameCount);
  const explicitKeyframeFps = nonNegativeTimingNumber(timing.baseKeyframeFps);
  const defaultPlaybackRate = positiveTimingNumber(timing.defaultPlaybackRate);
  const duration = positiveTimingNumber(clipDuration);
  const basis = timing.basis === "physical" && sourceDurationSecond
    ? "physical"
    : "display";
  const basisDuration = basis === "physical" ? sourceDurationSecond : duration;
  const intervalCount = basis === "physical" && storedFrameCount > 1
    ? storedFrameCount - 1
    : storedFrameCount;
  const baseKeyframeFps = explicitKeyframeFps !== null
    ? explicitKeyframeFps
    : storedFrameCount === 1
      ? 0
      : (intervalCount && basisDuration ? intervalCount / basisDuration : null);
  return {
    basis,
    sourceDurationSecond,
    sourceFrameCount,
    storedFrameCount,
    baseKeyframeFps,
    defaultPlaybackRate
  };
}

function formatTimingPair(elapsedSecond, totalSecond) {
  const safeElapsed = Number.isFinite(elapsedSecond) ? Math.max(0, elapsedSecond) : 0;
  const safeTotal = Number.isFinite(totalSecond) ? Math.max(0, totalSecond) : 0;
  const useMillisecond = safeTotal < 0.1;
  const multiplier = useMillisecond ? 1000 : 1;
  const scaledTotal = safeTotal * multiplier;
  const digits = useMillisecond ? 3 : scaledTotal < 1 ? 3 : scaledTotal < 10 ? 2 : scaledTotal < 100 ? 1 : 0;
  return `${(safeElapsed * multiplier).toFixed(digits)} / ${scaledTotal.toFixed(digits)} ${useMillisecond ? "ms" : "s"}`;
}

function formatTimingRate(rate) {
  return Number(rate.toPrecision(3)).toString();
}

function playbackBasisLabel(mode = selectedMode) {
  return modeTiming(mode).basis === "physical" ? "real time" : "display time";
}

function updatePlaybackRateLabels() {
  const basisLabel = playbackBasisLabel();
  for (const option of playbackSpeed.options) {
    const rate = Number(option.value);
    if (Number.isFinite(rate) && rate > 0) {
      option.textContent = `${formatTimingRate(rate)}× ${basisLabel}`;
    }
  }
  playbackSpeed.setAttribute("aria-label", `再生速度（${basisLabel}）`);
}

function configurePlaybackRateOptions(mode, defaultRate) {
  const physical = modeTiming(mode).basis === "physical";
  const rates = physical
    ? [0.5, 1, 2, 4].map((factor) => defaultRate * factor)
    : [0.25, 0.5, 1, 2];
  const uniqueRates = [...new Set(rates.map((rate) => Number(rate.toPrecision(12))))]
    .filter((rate) => Number.isFinite(rate) && rate > 0)
    .sort((left, right) => left - right);
  playbackSpeed.replaceChildren(...uniqueRates.map((rate) => {
    const option = document.createElement("option");
    option.value = String(rate);
    return option;
  }));
  updatePlaybackRateLabels();
}

function playbackTimingText(currentTime, clipDuration) {
  const duration = positiveTimingNumber(clipDuration);
  if (!duration) return "timing unavailable";
  const timing = modeTiming(selectedMode, duration);
  const fraction = Math.min(1, Math.max(0, currentTime / duration));
  const viewingTotal = timing.basis === "physical"
    ? timing.sourceDurationSecond / playbackRate
    : duration / playbackRate;
  const viewingElapsed = fraction * viewingTotal;
  const viewing = `viewing ${formatTimingPair(viewingElapsed, viewingTotal)}`;
  const simulation = timing.basis === "physical"
    ? `simulation ${formatTimingPair(fraction * timing.sourceDurationSecond, timing.sourceDurationSecond)}`
    : "simulation time unknown";
  const effectiveFps = timing.baseKeyframeFps
    ? ` · ≈${formatTimingRate(timing.baseKeyframeFps * playbackRate)} keyframe/s`
    : "";
  const frameCount = timing.storedFrameCount
    ? ` · ${Math.round(timing.storedFrameCount)}${timing.sourceFrameCount ? `/${Math.round(timing.sourceFrameCount)}` : ""} frame`
    : "";
  return `${simulation} · ${viewing}${effectiveFps}${frameCount}`;
}

function modePlaybackRate(mode) {
  const requested = Number(mode?.webAr?.playbackRate ?? mode?.playbackRate);
  const fallback = mode?.caseId?.toLowerCase() === "windwave" ? 0.2 : 1;
  return Number.isFinite(requested) && requested > 0 ? requested : fallback;
}

function enginePlaybackRate() {
  const duration = activeDuration();
  const timing = modeTiming(selectedMode, duration);
  if (timing.basis !== "physical" || !duration) return playbackRate;
  if (selectedMode?.kind === "video") {
    const encodedRate = timing.defaultPlaybackRate || modePlaybackRate(selectedMode);
    return playbackRate / encodedRate;
  }
  return playbackRate * duration / timing.sourceDurationSecond;
}

function applyPlaybackRate() {
  const mediaRate = enginePlaybackRate();
  if (selectedMode?.kind === "video") stageVideo.playbackRate = mediaRate;
  else viewer.timeScale = mediaRate;
  let matchingOption = [...playbackSpeed.options].find((option) => (
    Math.abs(Number(option.value) - playbackRate)
      <= Math.max(1, Math.abs(playbackRate)) * 1e-10
  ));
  if (!matchingOption) {
    const option = document.createElement("option");
    option.value = String(playbackRate);
    option.textContent = `${playbackRate}×`;
    playbackSpeed.append(option);
    matchingOption = option;
  }
  updatePlaybackRateLabels();
  playbackSpeed.value = matchingOption.value;
}

function refreshPlaybackControls() {
  const duration = activeDuration();
  const available = hasPlayableTimeline(
    selectedMode,
    selectedMode && duration && !mediaLoading
  );
  playbackControls.hidden = !available;
  playButton.disabled = mediaLoading || !available;
  playbackSeek.disabled = mediaLoading || !available;
  playbackSpeed.disabled = mediaLoading || !available;
  if (!available) {
    playbackSeek.value = "0";
    playbackTime.value = "timing unavailable";
    playbackTime.textContent = playbackTime.value;
    return;
  }

  const currentTime = Math.min(duration, Math.max(0, Number(activeMedia().currentTime) || 0));
  if (!isSeeking) playbackSeek.value = String(Math.round((currentTime / duration) * 1000));
  playbackTime.value = playbackTimingText(currentTime, duration);
  playbackTime.textContent = playbackTime.value;
}

function playbackAnimationTick() {
  playbackAnimationFrame = null;
  refreshPlaybackControls();
  if (isPlaying && !isSeeking && !document.hidden && !playbackControls.hidden) {
    playbackAnimationFrame = window.requestAnimationFrame(playbackAnimationTick);
  }
}

function schedulePlaybackRefresh() {
  if (playbackAnimationFrame === null) {
    playbackAnimationFrame = window.requestAnimationFrame(playbackAnimationTick);
  }
}

function pauseActiveMedia() {
  activeMedia()?.pause();
  isPlaying = false;
  updatePlayButton();
  refreshPlaybackControls();
}

function playActiveMedia() {
  if (isStaticMode(selectedMode)) return;
  const media = activeMedia();
  if (!media) return;
  const playResult = media.play();
  isPlaying = true;
  updatePlayButton();
  schedulePlaybackRefresh();
  if (playResult?.catch) {
    playResult.catch(() => {
      isPlaying = false;
      updatePlayButton();
      refreshPlaybackControls();
    });
  }
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
  manifest = await fetchAssetJson(catalogUrl);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.categories)) {
    throw new Error("Unsupported case catalog");
  }

  async function loadCase(reference) {
    const caseUrl = new URL(reference.manifest, catalogUrl);
    const caseDefinition = await fetchAssetJson(caseUrl);
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
  mediaLoading = isLoading;
  viewer.setAttribute("aria-busy", String(isLoading));
  loadState.hidden = !isLoading;
  loadState.textContent = message;
  if (isLoading) playbackControls.hidden = true;
  refreshPlaybackControls();
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
    markerArButton.href = carryUnlockFragment(markerUrl).href;
    markerArButton.textContent = selectedMode.anchor?.worldTracking?.target
      ? "camera ARで再生"
      : "QR marker ARで再生";
    markerArButton.hidden = false;
    const showAndroidNativeFallback = deviceProfile.isAndroid
      && !usesEncryptedAssets()
      && viewer.canActivateAR;
    nativeArButton.hidden = !showAndroidNativeFallback;
    nativeArButton.classList.toggle("secondary-ar-button", showAndroidNativeFallback);
    nativeArButton.textContent = showAndroidNativeFallback ? "標準AR（簡易）" : "ARで見る";
    arMessage.textContent = deviceProfile.isAndroid
      ? "camera ARが本命です。Chrome／Firefox／Samsung Internet／Edgeで開始し、最初だけ色付きQR posterへ位置を合わせます。非対応なら標準AR（簡易）を使えます。"
      : "印刷した色付きQR posterを机に置き、「camera ARで再生」からcameraを開始してください。";
    return;
  }
  markerArButton.hidden = true;
  if (usesEncryptedAssets()) {
    nativeArButton.hidden = true;
    nativeArButton.classList.remove("secondary-ar-button");
    arMessage.textContent = "暗号化caseではbrowser内3Dを使用します。marker tracking付きcaseはcamera ARを利用できます。";
    return;
  }
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

function updateReference(mode, referenceUrl = null) {
  reference.hidden = !mode.reference;
  if (!mode.reference) {
    reference.open = false;
    referenceVideo.pause();
    return;
  }
  referenceSource.src = referenceUrl;
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

async function selectMode(key, syncUrl = true) {
  const mode = modeIndex.get(key);
  if (!mode) return;
  const serial = ++selectionSerial;
  selectedMode = mode;
  modePicker.value = key;
  modeTitle.textContent = mode.title;
  modeDescription.textContent = mode.description;
  modeScale.textContent = mode.scale;
  modeMagnification.textContent = mode.magnification;
  colourLegend.hidden = !mode.legend;
  updateSource(mode);
  // Animated scientific results start immediately. A one-frame result has no
  // meaningful timeline, so its transport stays absent while mode switching remains.
  isPlaying = !isStaticMode(mode);
  isSeeking = false;
  resumeAfterSeek = false;
  playbackRate = modePlaybackRate(mode);
  configurePlaybackRateOptions(mode, playbackRate);
  applyPlaybackRate();

  setLoading(true, usesEncryptedAssets() ? "暗号assetを復号中…" : "3Dを読み込み中…");
  const referenceUrlPromise = mode.reference
    ? assetUrl(mode, mode.reference.video)
    : Promise.resolve(null);
  let prepared;
  if (mode.kind === "video") {
    const [poster, video, referenceUrl] = await Promise.all([
      assetUrl(mode, mode.poster),
      assetUrl(mode, mode.videoSrc),
      referenceUrlPromise
    ]);
    prepared = { poster, video, referenceUrl };
  } else {
    const iosPath = usesEncryptedAssets() ? null : (mode.iosAnchorSrc || mode.iosSrc);
    const [model, iosModel, referenceUrl] = await Promise.all([
      assetUrl(mode, mode.src),
      iosPath ? assetUrl(mode, iosPath) : Promise.resolve(null),
      referenceUrlPromise
    ]);
    prepared = { model, iosModel, referenceUrl };
  }
  if (serial !== selectionSerial) return;
  updateReference(mode, prepared.referenceUrl);

  if (mode.kind === "video") {
    viewer.pause();
    viewer.hidden = true;
    gestureHint.hidden = true;
    stageVideo.hidden = false;
    stageVideo.poster = prepared.poster;
    const videoSrc = prepared.video;
    if (stageVideo.src !== videoSrc) {
      stageVideo.src = videoSrc;
      stageVideo.load();
    }
    applyPlaybackRate();
    setLoading(false);
    if (isPlaying && !isStaticMode(mode)) {
      playActiveMedia();
    }
  } else {
    stageVideo.pause();
    stageVideo.hidden = true;
    viewer.hidden = false;
    gestureHint.hidden = false;
    setLoading(true);
    if (!isStaticMode(mode) && mode.animationName) {
      viewer.setAttribute("animation-name", mode.animationName);
    } else {
      viewer.removeAttribute("animation-name");
    }
    viewer.setAttribute("src", prepared.model);
    if (prepared.iosModel) viewer.setAttribute("ios-src", prepared.iosModel);
    else viewer.removeAttribute("ios-src");
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

modePicker.addEventListener("change", () => {
  selectMode(modePicker.value).catch((error) => {
    console.error(error);
    setLoading(false);
    arMessage.textContent = error.message;
  });
});

playButton.addEventListener("click", () => {
  if (isPlaying) pauseActiveMedia();
  else playActiveMedia();
});

playbackSeek.addEventListener("input", () => {
  const duration = activeDuration();
  if (!duration) return;
  if (!isSeeking) {
    isSeeking = true;
    resumeAfterSeek = isPlaying;
    activeMedia().pause();
    isPlaying = false;
    updatePlayButton();
  }
  activeMedia().currentTime = (Number(playbackSeek.value) / 1000) * duration;
  const currentTime = Number(activeMedia().currentTime) || 0;
  playbackTime.value = playbackTimingText(currentTime, duration);
  playbackTime.textContent = playbackTime.value;
});

function finishSeeking() {
  if (!isSeeking) return;
  isSeeking = false;
  const shouldResume = resumeAfterSeek
    && !landscapeBlocked
    && !document.hidden;
  resumeAfterSeek = false;
  if (shouldResume) playActiveMedia();
  else {
    updatePlayButton();
    refreshPlaybackControls();
  }
}

playbackSeek.addEventListener("change", finishSeeking);
playbackSeek.addEventListener("pointercancel", finishSeeking);

playbackSpeed.addEventListener("change", () => {
  playbackRate = Number(playbackSpeed.value);
  applyPlaybackRate();
  refreshPlaybackControls();
});

reference.addEventListener("toggle", () => {
  if (reference.open && !reduceMotion) referenceVideo.play().catch(() => {});
  else referenceVideo.pause();
});

stageVideo.addEventListener("play", () => {
  if (selectedMode?.kind !== "video") return;
  if (isStaticMode(selectedMode)) {
    stageVideo.pause();
    return;
  }
  isPlaying = true;
  updatePlayButton();
  schedulePlaybackRefresh();
});

stageVideo.addEventListener("pause", () => {
  if (selectedMode?.kind !== "video") return;
  isPlaying = false;
  updatePlayButton();
  refreshPlaybackControls();
});

stageVideo.addEventListener("loadedmetadata", () => {
  if (selectedMode?.kind !== "video") return;
  applyPlaybackRate();
  refreshPlaybackControls();
  if (isPlaying) schedulePlaybackRefresh();
});

stageVideo.addEventListener("durationchange", () => {
  if (selectedMode?.kind === "video") refreshPlaybackControls();
});

stageVideo.addEventListener("timeupdate", () => {
  if (selectedMode?.kind === "video" && !isSeeking) refreshPlaybackControls();
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
  applyPlaybackRate();
  const initialTime = selectedMode.initialTime;
  if (Number.isFinite(initialTime)) viewer.currentTime = initialTime;
  refreshPlaybackControls();
  if (isPlaying && !isStaticMode(selectedMode)) playActiveMedia();
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
  if (!resumeAfterVisibility || isStaticMode(selectedMode)) return;
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
    resumeAfterLandscape = Boolean(selectedMode && isPlaying && !isStaticMode(selectedMode));
    if (selectedMode?.kind === "video") stageVideo.pause();
    else if (selectedMode) viewer.pause();
    return;
  }

  if (previous && resumeAfterLandscape && selectedMode && !isStaticMode(selectedMode)) {
    isPlaying = true;
    if (selectedMode.kind === "video") stageVideo.play().catch(() => {});
    else viewer.play();
    updatePlayButton();
  }
  resumeAfterLandscape = false;
  updateArAvailability();
});

Promise.all([customElements.whenDefined("model-viewer"), loadManifest()])
  .then(async () => {
    const requestedCase = new URLSearchParams(window.location.search).get("case");
    const rawMode = new URLSearchParams(window.location.search).get("mode");
    if (requestedCase && !caseIndex.has(requestedCase)) {
      throw new Error(`指定case「${requestedCase}」は配信catalogにありません。`);
    }
    const requestedMode = manifest.aliases?.[rawMode] || rawMode;
    const requestedKey = requestedMode ? findModeKey(requestedMode, requestedCase) : null;
    const caseDefault = caseIndex.get(requestedCase)?.defaultMode;
    const initialKey = requestedKey
      || (caseDefault ? findModeKey(caseDefault, requestedCase) : null)
      || findModeKey(manifest.defaultMode)
      || modeIndex.keys().next().value;
    await selectMode(initialKey, true);
  })
  .catch((error) => {
    console.error(error);
    modePicker.disabled = true;
    setLoading(false);
    arMessage.textContent = "表示caseを読み込めませんでした。HTTP serverから開いてください。";
  });
