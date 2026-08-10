import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  deviceProfile,
  isTabletPortrait,
  requestTabletLandscapeMode,
  setupTabletLandscapeGate
} from "./deviceSupport.js?v=1";
import {
  assetArrayBuffer,
  assetObjectUrl,
  carryUnlockFragment,
  fetchAssetJson,
  usesEncryptedAssets
} from "./secureAsset.js?v=2";
import {
  calibratedWorldScale,
  mayAcceptTimedPoseSample,
  maySampleInitialPose,
  poseWindowReady,
  sceneDistanceMetres,
  stablePosterPoseProfile,
  stablePosterPoseStep,
  stableMeanScale,
  targetPhysicalSize
} from "./markerPoseCore.js?v=5";
import {
  arPerformanceProfileForDevice,
  constrainCameraFrameRate,
  timedWorkDue,
  timelineDeltaSeconds
} from "./arPerformanceCore.js?v=1";
import { installArUiOverlayGuard } from "./arUiOverlayCore.js?v=1";
import { hasPlayableTimeline } from "./playbackModeCore.js?v=1";

// 8th Wall's Three.js pipeline reads this global. All application code still
// imports the same vendored Three.js module through the import map.
window.THREE = THREE;

const arPerformanceProfile = arPerformanceProfileForDevice(deviceProfile);
const stablePosterPoseFilterEnabled = deviceProfile.isAndroid && deviceProfile.isTablet;

const canvas = document.getElementById("camerafeed");
const arUi = document.getElementById("ar-ui");
const intro = document.getElementById("intro");
const introTitle = document.getElementById("intro-title");
const introCopy = document.getElementById("intro-copy");
const introError = document.getElementById("intro-error");
const markerPreview = document.getElementById("marker-preview");
const startButton = document.getElementById("start-button");
const modePicker = document.getElementById("mode-picker");
const playButton = document.getElementById("play-button");
const transport = document.getElementById("transport");
const seekSlider = document.getElementById("seek-slider");
const ratePicker = document.getElementById("rate-picker");
const seekTime = document.getElementById("seek-time");
const homeLink = document.getElementById("home-link");
const posterLockLink = document.getElementById("poster-lock-link");
const fallbackLink = document.getElementById("fallback-link");
const imageFallbackLink = document.getElementById("image-fallback-link");
const scanGuide = document.getElementById("scan-guide");
const status = document.getElementById("status");
const platformNote = document.getElementById("platform-note");
const orientationGate = document.getElementById("orientation-gate");
const arUiOverlayGuard = installArUiOverlayGuard({
  overlay: arUi,
  canvas,
  orientationGate
});

// The QR route is camera-first. Keep the explanatory card out of the normal
// loading path; showStartFallback() exposes it only when startup needs help.
intro.hidden = true;
startButton.hidden = true;

const query = new URLSearchParams(window.location.search);
const requestedCase = query.get("case");
const requestedMode = query.get("mode");

const worldAnchorRoot = new THREE.Group();
const contentRoot = new THREE.Group();
const modelPlacementRoot = new THREE.Group();
worldAnchorRoot.name = "worldAnchorRoot";
contentRoot.name = "contentRoot";
modelPlacementRoot.name = "modelPlacementRoot";
worldAnchorRoot.add(contentRoot);
contentRoot.add(modelPlacementRoot);
worldAnchorRoot.visible = false;

const poseSample = [];
const posterAcquisitionSample = [];
let flipbookNode = [];

let catalog;
let definition;
let manifestUrl;
let assetRoot;
let worldTracking;
let selectedMode;
let targetData;
let targetSize;
let xr8;
let xrScene;
let activeModel;
let referencePlane;
let mixer;
let activeAction;
let clipDuration = 0;
let playbackRate = 1;
let lastTransportUpdateAt = -Infinity;
let running = false;
let playing = true;
let markerVisible = false;
let markerPosePreview = false;
let markerPreviewUpdatedAt = null;
let markerPreviewCalibrated = false;
let lastPosterAcquisitionAt = Number.NEGATIVE_INFINITY;
let markerHandoffTimer;
let poseLocked = false;
let posterLockedFallback = false;
let pipelineAdded = false;
let startPromise;
let runtimeNeedsStop = false;
let autoStartPending = false;
let automaticStartInFlight = false;
let cameraPipelineReadyPromise;
let cameraPipelineReadyResolve;
let modelStartupPromise;
let modeLoading = false;
let loadSerial = 0;
let lastFrameTime = performance.now();
let trackingStatus = "INITIALIZING";
let trackingReason = "INITIALIZING";
let trackingNormalSince = null;
let lastPoseSampleAt = Number.NEGATIVE_INFINITY;
let constrainedCameraTrack;
let allowedDevices;
let landscapeBlocked = false;
let resumeAfterLandscape = false;
let orientationRestoreTimer;


function setStatus(message, state = "loading") {
  if (status.textContent === message && status.dataset.state === state) return;
  status.textContent = message;
  status.dataset.state = state;
}

function resetCameraPipelineReady() {
  cameraPipelineReadyPromise = new Promise((resolve) => {
    cameraPipelineReadyResolve = resolve;
  });
}

function markCameraPipelineReady() {
  cameraPipelineReadyResolve?.({ ok: true });
  cameraPipelineReadyResolve = undefined;
  automaticStartInFlight = false;
}

function markCameraPipelineFailed(error) {
  cameraPipelineReadyResolve?.({ ok: false, error });
  cameraPipelineReadyResolve = undefined;
}

async function waitForCameraPipelineReady(timeoutMs = 15000) {
  if (running) return;
  if (!cameraPipelineReadyPromise) throw new Error("camera pipelineを開始できませんでした。");
  let timeout;
  try {
    const outcome = await Promise.race([
      cameraPipelineReadyPromise,
      new Promise((_, reject) => {
        timeout = window.setTimeout(
          () => reject(new Error("camera pipelineの開始がtimeoutしました。")),
          timeoutMs
        );
      })
    ]);
    if (outcome?.ok === false) throw outcome.error;
  } catch (error) {
    automaticStartInFlight = false;
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

canvas.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  setStatus("3D描画memoryが不足しました · pageを再読み込みしてください", "error");
});

function syncWorldAnchorVisibility() {
  // In Android-tablet poster-lock fallback, an unlocked preview is trustworthy
  // only while the poster is visible. Holding its last matrix after target loss
  // merely exposes SLAM drift as a wildly moving model. Other devices retain
  // the established world-handoff behaviour.
  const poseVisible = posterLockedFallback
    ? markerPosePreview && markerVisible
    : poseLocked || markerPosePreview;
  worldAnchorRoot.visible = poseVisible && Boolean(activeModel);
}

function syncFlipbookVisibility() {
  if (!flipbookNode.length) return;
  let activeCount = 0;
  for (const node of flipbookNode) {
    const visible = Math.max(Math.abs(node.scale.x), Math.abs(node.scale.y), Math.abs(node.scale.z)) > 0.5;
    node.visible = visible;
    if (visible) activeCount += 1;
  }
  // Before AnimationMixer evaluates its first STEP key, preserve frame 0.
  if (!activeCount) flipbookNode[0].visible = true;
}

function clearMarkerHandoffTimer() {
  window.clearTimeout(markerHandoffTimer);
  markerHandoffTimer = undefined;
}

function currentClipTime() {
  if (!activeAction || clipDuration <= 0) return 0;
  return ((activeAction.time % clipDuration) + clipDuration) % clipDuration;
}

function positiveTimingNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegativeTimingNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function modeTiming(mode, duration = 0) {
  const timing = mode?.timing || {};
  const sourceDurationSecond = positiveTimingNumber(timing.sourceDurationSecond);
  const storedFrameCount = positiveTimingNumber(timing.storedFrameCount);
  const sourceFrameCount = positiveTimingNumber(timing.sourceFrameCount);
  const explicitKeyframeFps = nonNegativeTimingNumber(timing.baseKeyframeFps);
  const defaultPlaybackRate = positiveTimingNumber(timing.defaultPlaybackRate);
  const clipSecond = positiveTimingNumber(duration);
  const basis = timing.basis === "physical" && sourceDurationSecond
    ? "physical"
    : "display";
  const basisDuration = basis === "physical" ? sourceDurationSecond : clipSecond;
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
  for (const option of ratePicker.options) {
    const rate = Number(option.value);
    if (Number.isFinite(rate) && rate > 0) {
      option.textContent = `${formatTimingRate(rate)}× ${basisLabel}`;
    }
  }
  ratePicker.setAttribute("aria-label", `animation再生速度（${basisLabel}）`);
}

function configurePlaybackRateOptions(mode, defaultRate) {
  const physical = modeTiming(mode).basis === "physical";
  const rates = physical
    ? [0.5, 1, 2, 4].map((factor) => defaultRate * factor)
    : [0.25, 0.5, 1, 2];
  const uniqueRates = [...new Set(rates.map((rate) => Number(rate.toPrecision(12))))]
    .filter((rate) => Number.isFinite(rate) && rate > 0)
    .sort((left, right) => left - right);
  ratePicker.replaceChildren(...uniqueRates.map((rate) => {
    const option = document.createElement("option");
    option.value = String(rate);
    return option;
  }));
  updatePlaybackRateLabels();
}

function playbackTimingText(clipTime) {
  const duration = positiveTimingNumber(clipDuration);
  if (!duration) return "timing unavailable";
  const timing = modeTiming(selectedMode, duration);
  const fraction = Math.min(1, Math.max(0, clipTime / duration));
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

function enginePlaybackRate() {
  const timing = modeTiming(selectedMode, clipDuration);
  return timing.basis === "physical" && clipDuration > 0
    ? playbackRate * clipDuration / timing.sourceDurationSecond
    : playbackRate;
}

function updateTransport(force = false) {
  const available = hasPlayableTimeline(
    selectedMode,
    !modeLoading && activeAction && clipDuration > 0
  );
  playButton.hidden = !available;
  playButton.disabled = !available;
  if (!available) {
    transport.hidden = true;
    ratePicker.disabled = true;
    return;
  }

  const now = performance.now();
  if (!force && now - lastTransportUpdateAt < 100) return;
  lastTransportUpdateAt = now;
  transport.hidden = false;
  const clipTime = currentClipTime();
  const sliderValue = Math.round((clipTime / clipDuration) * 1000);
  seekSlider.value = String(sliderValue);
  seekTime.textContent = playbackTimingText(clipTime);
  seekSlider.setAttribute("aria-valuetext", seekTime.textContent);
}

function selectPlaybackRateOption(rate) {
  const matchingOption = [...ratePicker.options].find(
    (option) => Math.abs(Number(option.value) - rate)
      <= Math.max(1e-12, Math.abs(rate)) * 1e-10
  );
  if (matchingOption) {
    ratePicker.value = matchingOption.value;
    return;
  }

  const option = document.createElement("option");
  option.value = String(rate);
  const nextOption = [...ratePicker.options].find(
    (candidate) => Number(candidate.value) > rate
  );
  ratePicker.insertBefore(option, nextOption || null);
  updatePlaybackRateLabels();
  ratePicker.value = option.value;
}

function setPlaybackRate(nextRate) {
  const rate = Number(nextRate);
  if (!Number.isFinite(rate) || rate <= 0) return;
  playbackRate = rate;
  selectPlaybackRateOption(rate);
  updatePlaybackRateLabels();
  if (mixer) mixer.timeScale = playing ? enginePlaybackRate() : 0;
  updateTransport(true);
}

function setPlaying(nextPlaying) {
  if (!mixer || !activeAction) return;
  playing = Boolean(nextPlaying);
  mixer.timeScale = playing ? enginePlaybackRate() : 0;
  playButton.textContent = playing ? "一時停止" : "再生";
  playButton.setAttribute("aria-label", playing ? "animationを一時停止" : "animationを再生");
  updateTransport(true);
}

function seekToSliderValue() {
  if (!mixer || !activeAction || clipDuration <= 0) return;
  const requestedSliderValue = Number(seekSlider.value);
  setPlaying(false);
  const fraction = Math.min(0.999999, Math.max(0, requestedSliderValue / 1000));
  activeAction.time = clipDuration * fraction;
  mixer.update(0);
  syncFlipbookVisibility();
  updateTransport(true);
  renderTrackingStatus();
}

function versionedUrl(path, root = assetRoot) {
  const url = new URL(path, root);
  if (catalog?.assetVersion) url.searchParams.set("v", catalog.assetVersion);
  return url.href;
}

function modeUrl(page, mode = selectedMode) {
  const url = new URL(page, document.baseURI);
  if (definition?.id) url.searchParams.set("case", definition.id);
  if (mode?.id) url.searchParams.set("mode", mode.id);
  return carryUnlockFragment(url).href;
}

function collectCaseReferences(source) {
  const references = [];
  for (const category of source.categories || []) {
    for (const reference of category.case || []) references.push(reference);
  }
  for (const reference of source.auxiliary || []) references.push(reference);
  return references;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value, fallback) {
  const number = finiteNumber(value, fallback);
  return number > 0 ? number : fallback;
}

function validateWorldTracking(caseDefinition) {
  const anchor = caseDefinition.anchor;
  const tracking = anchor?.worldTracking;
  const markerTracking = anchor?.webTracking;
  const liftMetres = Number(anchor?.liftMetres);

  if (!anchor?.image || !tracking?.target || !tracking?.image) {
    throw new Error("このcaseにはworld tracking dataがありません。image-marker版を使ってください。");
  }
  if (!Number.isFinite(liftMetres) || liftMetres < 0) {
    throw new Error("marker上の表示高さが不正です。");
  }

  const contentOffset = tracking.contentOffsetMetres || [0, 0];
  if (!Array.isArray(contentOffset)
    || contentOffset.length !== 2
    || !contentOffset.every(Number.isFinite)) {
    throw new Error("world target上の表示位置が不正です。");
  }

  const initialPoseConfig = tracking.initialPose || tracking.correction || {};
  const minimumSampleIntervalMs = Math.max(100, positiveNumber(
    initialPoseConfig.minimumSampleIntervalMs,
    100
  ));
  const minimumDurationMs = Math.min(800, Math.max(
    600,
    positiveNumber(initialPoseConfig.minimumDurationMs, 600)
  ));
  const configuredSampleCount = Math.min(9, Math.max(
    7,
    Math.round(positiveNumber(initialPoseConfig.sampleCount, 7))
  ));
  const durationSampleCount = Math.ceil(minimumDurationMs / minimumSampleIntervalMs) + 1;
  const modelRotationDegree = tracking.modelRotationDegree
    || markerTracking?.modelRotationDegree
    || [90, 0, 0];
  if (!Array.isArray(modelRotationDegree)
    || modelRotationDegree.length !== 3
    || !modelRotationDegree.every(Number.isFinite)) {
    throw new Error("world ARのmodel回転設定が不正です。");
  }

  return {
    ...tracking,
    targetName: tracking.targetName || caseDefinition.id,
    contentOffsetMetres: contentOffset,
    liftMetres,
    modelRotationDegree,
    initialPose: {
      sampleCount: Math.max(configuredSampleCount, durationSampleCount),
      minimumSampleIntervalMs,
      minimumDurationMs,
      trackingWarmupMs: Math.min(600, Math.max(
        400,
        finiteNumber(initialPoseConfig.trackingWarmupMs, 400)
      )),
      stabilityPositionMetres: positiveNumber(initialPoseConfig.stabilityPositionMetres, 0.015),
      stabilityRotationDegree: positiveNumber(initialPoseConfig.stabilityRotationDegree, 3),
      stabilityScaleFraction: positiveNumber(initialPoseConfig.stabilityScaleFraction, 0.04)
    }
  };
}

async function loadDefinition() {
  const catalogUrl = new URL("./case/catalog.json", document.baseURI);
  catalog = await fetchAssetJson(catalogUrl);
  if (catalog.schemaVersion !== 1) throw new Error("未対応のcase catalogです。");

  const references = collectCaseReferences(catalog);
  if (!requestedCase) {
    throw new Error("QR URLにcase parameterがありません。印刷用posterのQRから開き直してください。");
  }
  const reference = references.find((item) => item.id === requestedCase);
  if (!reference) {
    throw new Error(`指定case「${requestedCase}」は配信catalogにありません。`);
  }
  if (!reference?.manifest) throw new Error("表示できるcaseがありません。");

  manifestUrl = new URL(reference.manifest, catalogUrl);
  definition = await fetchAssetJson(manifestUrl);
  if (definition.schemaVersion !== 1 || !Array.isArray(definition.modes)) {
    throw new Error("case manifestが不正です。");
  }

  assetRoot = new URL(definition.assetRoot, manifestUrl);
  worldTracking = validateWorldTracking(definition);
  contentRoot.position.set(
    worldTracking.contentOffsetMetres[0],
    worldTracking.contentOffsetMetres[1],
    worldTracking.liftMetres
  );

  const modes = definition.modes.filter((mode) => mode.kind === "model" && mode.src);
  if (!modes.length) throw new Error("world ARで表示できる3D modeがありません。");
  selectedMode = modes.find((mode) => mode.id === requestedMode)
    || modes.find((mode) => mode.id === definition.defaultMode)
    || modes[0];

  modePicker.replaceChildren(...modes.map((mode) => {
    const option = document.createElement("option");
    option.value = mode.id;
    option.textContent = mode.label;
    option.selected = mode.id === selectedMode.id;
    return option;
  }));

  introTitle.textContent = definition.label;
  introCopy.textContent = "最初に色付きQR posterで位置を合わせます。安定した初期位置を確定した後はposterを参照せず、周囲だけで追跡します。";
  platformNote.textContent = deviceProfile.isAndroid
    ? deviceProfile.isTablet
      ? "Android tablet · Chrome／Firefox／Samsung Internet／Edge · 横向き"
      : "Android · Chrome／Firefox／Samsung Internet／Edge"
    : deviceProfile.isAppleTablet
      ? "iPad Safari · 横向き"
      : "iPhone Safari／Androidの対応browser";
  let guideStyle = document.getElementById("tracking-guide-copy");
  if (!guideStyle) {
    guideStyle = document.createElement("style");
    guideStyle.id = "tracking-guide-copy";
    document.head.append(guideStyle);
  }
  guideStyle.textContent = "";
  updateLinks();
}

function updateLinks() {
  const normalPage = modeUrl("./index.html");
  const posterPage = modeUrl("./imageMarkerAr.html");
  fallbackLink.href = normalPage;
  homeLink.href = normalPage;
  imageFallbackLink.href = posterPage;
  posterLockLink.href = posterPage;
  posterLockLink.hidden = !(deviceProfile.isAndroid && deviceProfile.isTablet);

  const url = new URL(window.location.href);
  if (definition?.id) url.searchParams.set("case", definition.id);
  if (selectedMode?.id) url.searchParams.set("mode", selectedMode.id);
  window.history.replaceState(null, "", url);
}

function clearReferencePlane() {
  if (!referencePlane) return;
  referencePlane.removeFromParent();
  referencePlane.geometry?.dispose();
  referencePlane.material?.dispose();
  referencePlane = null;
}

function boundsRelativeTo(root, object) {
  root.updateWorldMatrix(true, false);
  object.updateWorldMatrix(true, true);
  const worldToRoot = root.matrixWorld.clone().invert();
  const bounds = new THREE.Box3();
  object.traverse((node) => {
    if (!node.isMesh || !node.geometry) return;
    if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
    if (!node.geometry.boundingBox) return;
    const localToRoot = worldToRoot.clone().multiply(node.matrixWorld);
    bounds.union(node.geometry.boundingBox.clone().applyMatrix4(localToRoot));
  });
  return bounds;
}

function createReferencePlane(mode) {
  const config = mode.webAr?.referencePlane;
  if (!config?.enabled) return;

  const paddingMetres = Number(config.paddingMetres ?? 0);
  const opacity = Number(config.opacity ?? 0.28);
  if (!Number.isFinite(paddingMetres) || paddingMetres < 0) {
    throw new Error(`${mode.id}: webAr.referencePlane.paddingMetresが不正です。`);
  }
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new Error(`${mode.id}: webAr.referencePlane.opacityが不正です。`);
  }

  const bounds = boundsRelativeTo(worldAnchorRoot, activeModel);
  if (bounds.isEmpty()) return;
  const size = bounds.getSize(new THREE.Vector3());
  const centre = bounds.getCenter(new THREE.Vector3());
  const width = size.x + 2 * paddingMetres;
  const height = size.y + 2 * paddingMetres;
  if (!(width > 0 && height > 0)) return;

  const material = new THREE.MeshBasicMaterial({
    color: config.colour ?? "#75cbed",
    opacity,
    transparent: opacity < 1,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  referencePlane = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  referencePlane.name = "referencePlane";
  referencePlane.position.set(centre.x, centre.y, 0);
  referencePlane.renderOrder = -10;
  worldAnchorRoot.add(referencePlane);
}

function disposeModel(model) {
  model?.traverse((node) => {
    if (!node.isMesh) return;
    node.geometry?.dispose();
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!material) continue;
      for (const value of Object.values(material)) {
        if (value?.isTexture) value.dispose();
      }
      material.dispose();
    }
  });
}

function clearModel() {
  clearReferencePlane();
  mixer?.stopAllAction();
  mixer = null;
  activeAction = null;
  flipbookNode = [];
  clipDuration = 0;
  lastTransportUpdateAt = -Infinity;
  transport.hidden = true;
  playButton.hidden = true;
  ratePicker.disabled = true;
  if (!activeModel) return;
  modelPlacementRoot.remove(activeModel);
  disposeModel(activeModel);
  activeModel = null;
  modelPlacementRoot.position.set(0, 0, 0);
  modelPlacementRoot.quaternion.identity();
  modelPlacementRoot.scale.set(1, 1, 1);
  syncWorldAnchorVisibility();
}

async function loadMode(mode) {
  const serial = ++loadSerial;
  modeLoading = true;
  modePicker.disabled = true;
  playButton.hidden = true;
  playButton.disabled = true;
  ratePicker.disabled = true;
  setStatus(`${mode.label}を読み込み中…`, "loading");

  const logicalModelUrl = versionedUrl(mode.src);
  const loader = new GLTFLoader();
  let gltf;
  if (usesEncryptedAssets()) {
    setStatus(`${mode.label}を復号中…`, "loading");
    const modelBuffer = await assetArrayBuffer(logicalModelUrl);
    setStatus(`${mode.label}を3D解析中…`, "loading");
    gltf = await loader.parseAsync(modelBuffer, new URL(".", logicalModelUrl).href);
  } else {
    const modelUrl = await assetObjectUrl(logicalModelUrl, "model/gltf-binary");
    gltf = await loader.loadAsync(modelUrl);
  }
  if (serial !== loadSerial) {
    disposeModel(gltf.scene);
    return;
  }
  const clip = mode.animationName
    ? THREE.AnimationClip.findByName(gltf.animations, mode.animationName)
    : gltf.animations[0];
  if (mode.animationName && !clip) {
    throw new Error(`${mode.id}: animation clip ${mode.animationName} がGLBにありません。`);
  }

  const physicalScale = Number(mode.webAr?.modelScale ?? 1);
  if (!Number.isFinite(physicalScale) || physicalScale <= 0) {
    throw new Error(`${mode.id}: webAr.modelScaleが不正です。`);
  }
  const defaultPlaybackRate = definition.id?.toLowerCase() === "windwave" ? 0.2 : 1;
  const requestedPlaybackRate = Number(mode.webAr?.playbackRate ?? defaultPlaybackRate);
  if (!Number.isFinite(requestedPlaybackRate) || requestedPlaybackRate <= 0) {
    throw new Error(`${mode.id}: webAr.playbackRateが不正です。`);
  }

  clearModel();
  selectedMode = mode;
  configurePlaybackRateOptions(mode, requestedPlaybackRate);
  setPlaybackRate(requestedPlaybackRate);
  activeModel = gltf.scene;
  flipbookNode = [];
  activeModel.traverse((node) => {
    if (/^frame\d{4}$/i.test(node.name)) flipbookNode.push(node);
  });
  // Keep SI scale and marker-plane orientation outside the animated GLTF.
  // Animation tracks are then unable to overwrite the placement transform.
  modelPlacementRoot.scale.setScalar(physicalScale);
  modelPlacementRoot.rotation.set(
    ...worldTracking.modelRotationDegree.map(THREE.MathUtils.degToRad)
  );
  modelPlacementRoot.add(activeModel);
  syncWorldAnchorVisibility();
  createReferencePlane(mode);

  if (hasPlayableTimeline(mode, clip && clip.duration > 0)) {
    mixer = new THREE.AnimationMixer(activeModel);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    action.play();
    activeAction = action;
    clipDuration = clip.duration;
    mixer.timeScale = playing ? enginePlaybackRate() : 0;
    mixer.update(0);
    syncFlipbookVisibility();
    ratePicker.disabled = false;
    updateTransport(true);
  }

  modePicker.value = mode.id;
  modePicker.disabled = false;
  modeLoading = false;
  updateTransport(true);
  document.title = `FLOW AR · ${definition.label}`;
  updateLinks();
  if (running) renderTrackingStatus();
  else if (xr8 && targetData) {
    setStatus(
      deviceProfile.isAndroid && deviceProfile.isTablet
        ? "準備完了 · poster全体を映してください"
        : "準備完了 · 最初だけposterで位置を合わせます",
      "ready",
    );
  }
}

function waitForEngine(timeoutMs = 30000) {
  if (window.XR8) return Promise.resolve(window.XR8);
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error("world tracking engineを読み込めませんでした。image-marker版を試してください。"));
    }, timeoutMs);
    window.addEventListener("xrloaded", () => {
      window.clearTimeout(timeout);
      if (window.XR8) resolve(window.XR8);
      else reject(new Error("world tracking engineの初期化に失敗しました。"));
    }, { once: true });
  });
}

function worldArCompatibility(engine) {
  const deviceConfig = engine.XrConfig?.device?.();
  const allowed = deviceConfig?.MOBILE_AND_HEADSETS ?? deviceConfig?.MOBILE;
  const checker = engine.XrDevice?.isDeviceBrowserCompatible;
  if (!allowed || typeof checker !== "function") return allowed;

  let compatible = true;
  try {
    compatible = checker({ allowedDevices: allowed });
  } catch (error) {
    console.warn("world AR compatibility check failed; runtime check will continue", error);
    return allowed;
  }
  if (compatible) return allowed;

  let reasons = [];
  try {
    reasons = engine.XrDevice.incompatibleReasons?.({ allowedDevices: allowed }) || [];
  } catch {
    // The generic fallback below remains actionable when reason lookup is unavailable.
  }
  const reasonLabel = {
    UNSUPPORTED_OS: "OS非対応",
    UNSUPPORTED_BROWSER: "browser非対応",
    MISSING_DEVICE_ORIENTATION: "端末姿勢sensorなし",
    MISSING_USER_MEDIA: "camera APIなし",
    MISSING_WEB_ASSEMBLY: "WebAssembly非対応"
  };
  const reasonEnum = engine.XrDevice.IncompatibilityReasons || {};
  const details = reasons.map((reason) => {
    const reasonName = Object.entries(reasonEnum).find(([, value]) => value === reason)?.[0] || reason;
    return reasonLabel[reasonName] || reasonName;
  }).join("／");
  const suffix = details ? `（${details}）` : "";
  throw new Error(`この端末ではworld trackingを利用できません${suffix}。image-marker版または通常3Dを使ってください。`);
}

function assertCameraEnvironment() {
  if (!window.isSecureContext && window.location.hostname !== "localhost") {
    throw new Error("camera ARにはHTTPSが必要です。公開URLかlocalhostから開いてください。");
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("このbrowserではcamera APIを利用できません。image-marker版または通常3Dを使ってください。");
  }
}

function cameraFailureMessage(reason) {
  if (reason === "DENY_CAMERA") {
    return "camera権限が拒否されました。browserのsite設定でcameraを許可し、再読み込みしてください。";
  }
  if (reason === "NO_CAMERA") {
    return "背面cameraを利用できません。image-marker版または通常3Dを使ってください。";
  }
  return "cameraを開始できません。camera権限を確認するか、image-marker版を使ってください。";
}

async function loadTargetData() {
  const data = await fetchAssetJson(versionedUrl(worldTracking.target));
  if (!data?.properties || data.name !== worldTracking.targetName) {
    throw new Error("world target dataがmanifestと一致しません。");
  }
  data.imagePath = await assetObjectUrl(
    versionedUrl(worldTracking.image),
    "image/jpeg"
  );
  return data;
}

function quaternionAngle(a, b) {
  const dot = Math.min(1, Math.abs(a.dot(b)));
  return 2 * Math.acos(dot);
}

function poseFromDetail(detail) {
  if (!detail || detail.name !== worldTracking.targetName) return null;
  const position = new THREE.Vector3(
    Number(detail.position?.x),
    Number(detail.position?.y),
    Number(detail.position?.z)
  );
  const quaternion = new THREE.Quaternion(
    Number(detail.rotation?.x),
    Number(detail.rotation?.y),
    Number(detail.rotation?.z),
    Number(detail.rotation?.w)
  );
  if (![position.x, position.y, position.z,
    quaternion.x, quaternion.y, quaternion.z, quaternion.w].every(Number.isFinite)) {
    return null;
  }
  quaternion.normalize();
  const calibratedScale = calibratedWorldScale(detail, targetSize);
  return {
    position,
    quaternion,
    scale: calibratedScale ?? 1,
    scaleCalibrated: calibratedScale !== null,
    capturedAt: performance.now()
  };
}

function medianNumber(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function posterAcquisitionPose(samples) {
  if (!poseWindowReady(
    samples,
    stablePosterPoseProfile.acquisitionSampleCount,
    stablePosterPoseProfile.acquisitionDurationMs
  )) return null;
  if (targetSize && samples.some((sample) => !sample.scaleCalibrated)) return null;

  const position = new THREE.Vector3(
    medianNumber(samples.map((sample) => sample.position.x)),
    medianNumber(samples.map((sample) => sample.position.y)),
    medianNumber(samples.map((sample) => sample.position.z))
  );
  // Use the quaternion medoid. Unlike an arithmetic mean it cannot be pulled
  // halfway towards one bad first detection on a low-resolution camera.
  let quaternion = samples[0].quaternion;
  let minimumDistance = Number.POSITIVE_INFINITY;
  for (const candidate of samples) {
    const distance = samples.reduce(
      (sum, sample) => sum + quaternionAngle(candidate.quaternion, sample.quaternion),
      0
    );
    if (distance < minimumDistance) {
      minimumDistance = distance;
      quaternion = candidate.quaternion;
    }
  }
  return {
    position,
    quaternion: quaternion.clone(),
    scale: medianNumber(samples.map((sample) => sample.scale)),
    scaleCalibrated: samples.every((sample) => sample.scaleCalibrated),
    capturedAt: samples[samples.length - 1].capturedAt
  };
}

function resetPosterPoseFilter() {
  posterAcquisitionSample.length = 0;
  lastPosterAcquisitionAt = Number.NEGATIVE_INFINITY;
}

function collectPosterAcquisitionPose(pose) {
  const elapsedMs = pose.capturedAt - lastPosterAcquisitionAt;
  if (posterAcquisitionSample.length
    && elapsedMs > stablePosterPoseProfile.maximumElapsedMs) {
    posterAcquisitionSample.length = 0;
  }
  if (elapsedMs < stablePosterPoseProfile.minimumIntervalMs) return null;
  lastPosterAcquisitionAt = pose.capturedAt;
  posterAcquisitionSample.push(pose);
  while (posterAcquisitionSample.length
    > stablePosterPoseProfile.acquisitionSampleCount) posterAcquisitionSample.shift();
  return posterAcquisitionPose(posterAcquisitionSample);
}

function applyMarkerPreviewPose(pose) {
  if (poseLocked) return;
  const firstPreview = !markerPosePreview;
  worldAnchorRoot.matrixAutoUpdate = true;
  if (!markerPosePreview || markerPreviewUpdatedAt === null) {
    worldAnchorRoot.position.copy(pose.position);
    worldAnchorRoot.quaternion.copy(pose.quaternion);
    worldAnchorRoot.scale.setScalar(pose.scale);
  } else if (stablePosterPoseFilterEnabled) {
    const currentScale = worldAnchorRoot.scale.x;
    const positionDistanceScene = worldAnchorRoot.position.distanceTo(pose.position);
    const positionDistanceMetres = sceneDistanceMetres(positionDistanceScene, currentScale);
    const rotationDistanceRadians = worldAnchorRoot.quaternion.angleTo(pose.quaternion);
    const scaleDifferenceFraction = Math.abs(pose.scale / currentScale - 1);
    const step = stablePosterPoseStep({
      elapsedMs: pose.capturedAt - markerPreviewUpdatedAt,
      positionDistanceMetres,
      rotationDistanceRadians,
      scaleDifferenceFraction
    });
    if (!step.accepted) return false;

    if (positionDistanceScene > 0 && step.positionStepMetres > 0) {
      const positionStep = pose.position.clone().sub(worldAnchorRoot.position);
      positionStep.setLength(Math.min(
        positionDistanceScene,
        step.positionStepMetres * currentScale
      ));
      worldAnchorRoot.position.add(positionStep);
    }
    if (rotationDistanceRadians > 0 && step.rotationStepRadians > 0) {
      worldAnchorRoot.quaternion.slerp(
        pose.quaternion,
        Math.min(1, step.rotationStepRadians / rotationDistanceRadians)
      );
    }
    if (scaleDifferenceFraction > 0 && step.scaleStepFraction > 0) {
      const direction = pose.scale >= currentScale ? 1 : -1;
      const nextScale = currentScale * (1 + direction * step.scaleStepFraction);
      worldAnchorRoot.scale.setScalar(
        direction > 0 ? Math.min(nextScale, pose.scale) : Math.max(nextScale, pose.scale)
      );
    }
  } else {
    const elapsedMs = Math.max(0, pose.capturedAt - markerPreviewUpdatedAt);
    const alpha = Math.min(0.18, Math.max(0.03, 1 - Math.exp(-elapsedMs / 450)));
    const currentScale = worldAnchorRoot.scale.x;
    const positionStep = pose.position.clone().sub(worldAnchorRoot.position);
    const maximumSceneStep = Math.max(0.001, currentScale * 0.02);
    if (positionStep.length() > maximumSceneStep) positionStep.setLength(maximumSceneStep);
    worldAnchorRoot.position.addScaledVector(positionStep, alpha);
    const rotationDistance = worldAnchorRoot.quaternion.angleTo(pose.quaternion);
    const rotationAlpha = rotationDistance > 0
      ? Math.min(alpha, THREE.MathUtils.degToRad(1.5) / rotationDistance)
      : 1;
    worldAnchorRoot.quaternion.slerp(pose.quaternion, rotationAlpha);
    const boundedScale = THREE.MathUtils.clamp(
      pose.scale,
      currentScale * 0.98,
      currentScale * 1.02
    );
    const smoothedScale = THREE.MathUtils.lerp(currentScale, boundedScale, alpha * 0.7);
    worldAnchorRoot.scale.setScalar(smoothedScale);
  }
  markerPosePreview = true;
  markerPreviewCalibrated = pose.scaleCalibrated;
  markerPreviewUpdatedAt = pose.capturedAt;
  worldAnchorRoot.updateMatrix();
  syncWorldAnchorVisibility();
  if (!posterLockedFallback && (firstPreview || !markerHandoffTimer)) {
    scheduleMarkerHandoffDeadline();
  }
  return true;
}

function scheduleMarkerHandoffDeadline(delayMs = 1800) {
  clearMarkerHandoffTimer();
  markerHandoffTimer = window.setTimeout(() => {
    markerHandoffTimer = undefined;
    if (poseLocked || !markerPosePreview) return;
    if (landscapeBlocked) {
      scheduleMarkerHandoffDeadline(400);
      return;
    }
    if (!markerPreviewCalibrated) return;
    // A bounded marker-authority interval prevents noisy Android image events
    // from driving the object forever when the strict quality gate starves.
    // The last calibrated provisional pose is still usable after a brief
    // image-target loss; requiring the target to be visible at this instant
    // made low-end Android cameras restart this window indefinitely.
    lockCurrentMarkerPreview();
  }, delayMs);
}

function lockMarkerPose(pose = null) {
  if (!markerPosePreview || poseLocked) return false;
  if (pose) {
    worldAnchorRoot.matrixAutoUpdate = true;
    worldAnchorRoot.position.copy(pose.position);
    worldAnchorRoot.quaternion.copy(pose.quaternion);
    worldAnchorRoot.scale.setScalar(pose.scale);
  }
  worldAnchorRoot.updateMatrix();
  worldAnchorRoot.matrixAutoUpdate = false;
  poseLocked = true;
  markerPosePreview = false;
  clearMarkerHandoffTimer();
  poseSample.length = 0;
  lastPoseSampleAt = Number.NEGATIVE_INFINITY;
  syncWorldAnchorVisibility();
  scanGuide.hidden = true;
  renderTrackingStatus();
  return true;
}

function lockCurrentMarkerPreview() {
  return lockMarkerPose();
}

function averagedStablePose(samples) {
  if (!poseWindowReady(
    samples,
    worldTracking.initialPose.sampleCount,
    worldTracking.initialPose.minimumDurationMs
  )) return null;

  const position = new THREE.Vector3();
  for (const sample of samples) position.add(sample.position);
  position.multiplyScalar(1 / samples.length);

  const reference = samples[0].quaternion;
  const sum = { x: 0, y: 0, z: 0, w: 0 };
  for (const sample of samples) {
    const sign = reference.dot(sample.quaternion) < 0 ? -1 : 1;
    sum.x += sample.quaternion.x * sign;
    sum.y += sample.quaternion.y * sign;
    sum.z += sample.quaternion.z * sign;
    sum.w += sample.quaternion.w * sign;
  }
  const quaternion = new THREE.Quaternion(sum.x, sum.y, sum.z, sum.w).normalize();

  const maxPositionSpread = Math.max(
    ...samples.map((sample) => sample.position.distanceTo(position))
  );
  const maxRotationSpread = Math.max(
    ...samples.map((sample) => quaternionAngle(sample.quaternion, quaternion))
  );
  const scale = stableMeanScale(
    samples,
    worldTracking.initialPose.stabilityScaleFraction
  );
  if (scale === null) return null;
  // A known printed target must provide a marker-derived scale. Falling back
  // to one here would silently turn responsive scene units into metres.
  if (targetSize && samples.some((sample) => !sample.scaleCalibrated)) return null;
  const maxPositionSpreadMetres = sceneDistanceMetres(maxPositionSpread, scale);
  if (maxPositionSpreadMetres === null
    || maxPositionSpreadMetres > worldTracking.initialPose.stabilityPositionMetres) return null;
  if (maxRotationSpread > THREE.MathUtils.degToRad(
    worldTracking.initialPose.stabilityRotationDegree
  )) return null;
  return { position, quaternion, scale };
}

function resetInitialPoseSamples() {
  poseSample.length = 0;
  lastPoseSampleAt = Number.NEGATIVE_INFINITY;
}

function addPoseSample(detail) {
  if (poseLocked || landscapeBlocked) return;
  const pose = poseFromDetail(detail);
  if (!pose) return;
  if (stablePosterPoseFilterEnabled) {
    if (!markerPosePreview) {
      const acquisitionPose = collectPosterAcquisitionPose(pose);
      if (!acquisitionPose) return;
      applyMarkerPreviewPose(acquisitionPose);
      resetPosterPoseFilter();
    } else {
      applyMarkerPreviewPose(pose);
    }
    if (posterLockedFallback) {
      resetInitialPoseSamples();
      return;
    }
  } else {
    // The marker is the immediate authority. This gives feedback as soon as the
    // poster is found while the world tracker earns a stable hand-off window.
    applyMarkerPreviewPose(pose);
  }
  if (!maySampleInitialPose(trackingStatus, poseLocked, landscapeBlocked)) {
    if (!poseLocked) resetInitialPoseSamples();
    return;
  }
  const now = pose.capturedAt;
  if (!mayAcceptTimedPoseSample({
    now,
    previousSampleAt: lastPoseSampleAt,
    trackingNormalSince,
    minimumSampleIntervalMs: worldTracking.initialPose.minimumSampleIntervalMs,
    trackingWarmupMs: worldTracking.initialPose.trackingWarmupMs
  })) return;
  lastPoseSampleAt = pose.capturedAt;
  poseSample.push(pose);
  while (poseSample.length > worldTracking.initialPose.sampleCount) poseSample.shift();

  const stablePose = averagedStablePose(poseSample);
  if (!stablePose) return;
  // Use the pose that passed the quality gate. The fallback deadline freezes
  // the smoothed preview only when event cadence prevents this path.
  lockMarkerPose(stablePose);
}

function readableTrackingReason(reason) {
  const label = {
    INITIALIZING: "周囲を初期化中",
    RELOCALIZING: "周囲を再認識中",
    TOO_MUCH_MOTION: "端末をゆっくり動かしてください",
    NOT_ENOUGH_TEXTURE: "机や周囲の模様を映してください"
  };
  return label[reason] || "周囲trackingが一時的に不安定です";
}

function renderTrackingStatus() {
  if (!running) return;
  if (landscapeBlocked) {
    setStatus("tabletは横向きにしてください", "limited");
    return;
  }
  if (!activeModel) {
    setStatus("camera起動済み · 3D modelを読み込み中…", "loading");
    return;
  }
  if (!poseLocked) {
    if (posterLockedFallback) {
      setStatus(
        markerVisible
          ? "poster固定モード · 安定表示にはposterを映し続けてください"
          : "poster固定モード · 色付きQR poster全体を映してください",
        markerVisible ? "found" : "scanning"
      );
      return;
    }
    setStatus(
      markerPosePreview
        ? (markerVisible
          ? "poster基準で仮表示 · 周囲trackingへ固定中…"
          : "仮位置を保持 · posterをもう一度映してください")
        : "色付きQR poster全体を映してください",
      "scanning"
    );
    return;
  }
  if (trackingStatus === "LIMITED" || trackingStatus === "NOT_AVAILABLE") {
    setStatus(readableTrackingReason(trackingReason), "limited");
    return;
  }
  setStatus("world座標に固定 · posterは初期位置合わせ後は参照しません", "world");
}

function handleImageFound({ detail }) {
  if (poseLocked) return;
  if (landscapeBlocked) return;
  if (!detail || detail.name !== worldTracking.targetName) return;
  markerVisible = true;
  resetInitialPoseSamples();
  addPoseSample(detail);
  renderTrackingStatus();
}

function handleImageUpdated({ detail }) {
  if (poseLocked) return;
  if (landscapeBlocked) return;
  if (!detail || detail.name !== worldTracking.targetName) return;
  markerVisible = true;
  addPoseSample(detail);
}

function handleImageLost({ detail }) {
  if (poseLocked) return;
  if (landscapeBlocked) return;
  if (detail?.name && detail.name !== worldTracking.targetName) return;
  markerVisible = false;
  // A reacquired poster starts a fresh robust seed. Mixing samples captured
  // before and after target loss can create a false median pose on slow cameras.
  resetPosterPoseFilter();
  if (!poseLocked) {
    resetInitialPoseSamples();
    if (posterLockedFallback) {
      // Do not leave an old poster pose visible in a drifting world frame.
      markerPosePreview = false;
      markerPreviewUpdatedAt = null;
      markerPreviewCalibrated = false;
    }
    // Losing the target is not proof of pose quality. Keep the last provisional
    // pose and its bounded hand-off deadline. Reacquisition may still satisfy
    // the strict gate, otherwise the deadline freezes this calibrated pose.
    syncWorldAnchorVisibility();
  }
  renderTrackingStatus();
}

function handleTrackingStatus({ detail }) {
  const previousStatus = trackingStatus;
  trackingStatus = detail?.status || trackingStatus;
  trackingReason = detail?.reason || trackingReason;
  if (trackingStatus === "NORMAL") {
    if (previousStatus !== "NORMAL") {
      trackingNormalSince = performance.now();
      if (!poseLocked) resetInitialPoseSamples();
    }
  } else {
    trackingNormalSince = null;
    if (!poseLocked) resetInitialPoseSamples();
  }
  syncWorldAnchorVisibility();
  if (landscapeBlocked) return;
  renderTrackingStatus();
}

function showStartFallback(error, { retry = false } = {}) {
  console.error(error);
  running = false;
  runtimeNeedsStop = pipelineAdded;
  intro.hidden = false;
  markerPreview.hidden = true;
  introCopy.textContent = retry
    ? "cameraを自動起動できませんでした。下のbuttonを1回押してください。"
    : "この端末ではcamera ARを開始できません。fallback表示を使ってください。";
  const message = error?.message || "";
  introError.textContent = /No valid session manager/i.test(message)
    ? "このbrowser／端末ではworld trackingを開始できません。iPhoneまたはAndroidの対応browserで開くか、image-marker版を使ってください。"
    : message || "world trackingを開始できませんでした。image-marker版を試してください。";
  introError.hidden = false;
  startButton.hidden = !retry;
  startButton.disabled = !retry;
  startButton.textContent = retry ? "cameraを開始" : "cameraを開始できません";
  setStatus("world trackingを開始できませんでした", "error");
}

function mayNeedUserActivation(error) {
  const name = String(error?.name || "");
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  return name === "NotAllowedError"
    || code === "DENY_CAMERA"
    || /user\s*(gesture|activation)|not\s*allowed|permission|権限/i.test(message);
}

function handleRuntimeError(error) {
  const runtimeError = error instanceof Error ? error : new Error(String(error || "runtime error"));
  runtimeError.flowArHandled = true;
  // Invalidate an in-flight GLB load. loadMode() disposes the parsed scene when
  // its serial no longer matches, avoiding a hidden late attachment after XR fails.
  loadSerial += 1;
  showStartFallback(runtimeError, {
    retry: automaticStartInFlight && mayNeedUserActivation(runtimeError)
  });
  markCameraPipelineFailed(runtimeError);
  automaticStartInFlight = false;
}

function configureCameraPerformance(stream) {
  const track = stream?.getVideoTracks?.()[0];
  if (!track || track === constrainedCameraTrack) return;
  constrainedCameraTrack = track;
  void constrainCameraFrameRate(stream, arPerformanceProfile).then((result) => {
    if (result.applied) {
      const { width, height, frameRate } = result.settings;
      const resolution = width && height ? `${width}x${height}` : "native resolution";
      console.info(`FLOW AR camera: ${resolution} @ ${frameRate || "device"} fps`);
    } else if (result.attempted) {
      console.warn(`FLOW AR camera FPS constraint was not applied: ${result.reason}`);
    }
  });
}

function handleCameraStatus({ status: cameraStatus, reason, stream }) {
  if (cameraStatus === "requesting") {
    setStatus("camera権限を確認中…", "loading");
    return;
  }
  if (cameraStatus === "hasStream") {
    configureCameraPerformance(stream);
    setStatus("camera映像を初期化中…", "loading");
    return;
  }
  if (cameraStatus !== "failed") return;

  const error = new Error(cameraFailureMessage(reason));
  error.code = reason;
  handleRuntimeError(error);
}

function createWorldPipelineModule() {
  return {
    name: "flow-ar-world-anchor",
    onStart: () => {
      arUiOverlayGuard.enforce();
      xrScene = xr8.Threejs.xrScene();
      const { scene, camera, renderer } = xrScene;
      // XR8 owns the shared camera/WebGL canvas and its viewport sizing. Changing
      // pixelRatio here resizes only the drawing buffer after GlTextureRenderer
      // has initialised, which shrinks the camera feed and leaves 3D frame trails
      // on high-DPI iPhone displays.
      // Keep any DPR tuning on the independent MindAR renderer, not this one.
      if ("outputColorSpace" in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;

      scene.add(worldAnchorRoot);
      scene.add(new THREE.HemisphereLight(0xe9f7ff, 0x20303a, 2.4));
      const keyLight = new THREE.DirectionalLight(0xffffff, 2.1);
      keyLight.position.set(-1.5, 2.5, 3);
      scene.add(keyLight);

      camera.position.set(0, 1.5, 0);
      camera.quaternion.identity();
      xr8.XrController.updateCameraProjectionMatrix({
        origin: camera.position,
        facing: camera.quaternion
      });

      running = true;
      markCameraPipelineReady();
      intro.hidden = true;
      scanGuide.hidden = false;
      updateTransport(true);
      lastFrameTime = performance.now();
      renderTrackingStatus();
    },
    onUpdate: () => {
      const now = performance.now();
      if (!timedWorkDue(now, lastFrameTime, arPerformanceProfile.timelineIntervalMs)) return;
      // Preserve physical playback speed at the reduced cadence. Only a long
      // browser stall is capped; ordinary 10--15 Hz updates keep their full dt.
      const delta = timelineDeltaSeconds(
        now,
        lastFrameTime,
        arPerformanceProfile.maximumTimelineDeltaSeconds
      );
      lastFrameTime = now;
      if (!landscapeBlocked && playing && (poseLocked || markerPosePreview)) {
        mixer?.update(delta);
        syncFlipbookVisibility();
      }
      updateTransport();
    },
    onCameraStatusChange: handleCameraStatus,
    onException: handleRuntimeError,
    listeners: [
      { event: "reality.imagefound", process: handleImageFound },
      { event: "reality.imageupdated", process: handleImageUpdated },
      { event: "reality.imagelost", process: handleImageLost },
      { event: "reality.trackingstatus", process: handleTrackingStatus }
    ]
  };
}

async function runArAttempt({ automatic = false } = {}) {
  if (isTabletPortrait()) {
    autoStartPending = true;
    setStatus("tabletは横向きにしてください", "limited");
    return false;
  }

  autoStartPending = false;
  intro.hidden = true;
  startButton.disabled = true;
  startButton.textContent = "cameraを起動中…";
  introError.hidden = true;
  setStatus("cameraとworld trackingを起動中…", "loading");
  automaticStartInFlight = automatic;

  try {
    assertCameraEnvironment();
    if (!xr8 || !targetData) {
      throw new Error("world ARの準備が完了していません。");
    }

    if (runtimeNeedsStop) {
      try { await xr8.stop?.(); } catch {}
      runtimeNeedsStop = false;
    }
    await requestTabletLandscapeMode();

    markerVisible = false;
    markerPosePreview = false;
    markerPreviewUpdatedAt = null;
    markerPreviewCalibrated = false;
    resetPosterPoseFilter();
    clearMarkerHandoffTimer();
    poseLocked = false;
    // The coloured poster determines only the initial pose. All supported
    // devices, including Android tablets, then hand off to the world frame.
    // The image-marker page remains an explicit poster-locked fallback.
    posterLockedFallback = false;
    resetInitialPoseSamples();
    trackingNormalSince = null;
    worldAnchorRoot.matrixAutoUpdate = true;
    worldAnchorRoot.visible = false;
    worldAnchorRoot.position.set(0, 0, 0);
    worldAnchorRoot.quaternion.identity();
    worldAnchorRoot.scale.set(1, 1, 1);
    worldAnchorRoot.updateMatrix();
    trackingStatus = "INITIALIZING";
    trackingReason = "INITIALIZING";
    resetCameraPipelineReady();

    xr8.XrController.configure({
      // The standard route always hands the initial poster pose to SLAM.
      // Poster-locked tracking remains available on imageMarkerAr.html.
      disableWorldTracking: arPerformanceProfile.disableWorldTracking,
      // Responsive tracking avoids late floor-scale reconvergence. The known
      // printed target size calibrates world-unit/metre in poseFromDetail().
      scale: "responsive",
      imageTargetData: [targetData]
    });

    if (!pipelineAdded) {
      const pipelineModule = [
        xr8.GlTextureRenderer.pipelineModule(),
        xr8.Threejs.pipelineModule(),
        xr8.XrController.pipelineModule(),
        createWorldPipelineModule()
      ];
      const fullWindowCanvas = xr8.FullWindowCanvas?.pipelineModule?.();
      if (fullWindowCanvas) pipelineModule.unshift(fullWindowCanvas);
      xr8.addCameraPipelineModules(pipelineModule);
      pipelineAdded = true;
    }

    const runOptions = allowedDevices ? { canvas, allowedDevices } : { canvas };
    if (arPerformanceProfile.glContextConfig) {
      runOptions.glContextConfig = { ...arPerformanceProfile.glContextConfig };
    }
    await xr8.run(runOptions);
    arUiOverlayGuard.enforce();
    return true;
  } catch (error) {
    handleRuntimeError(error);
    return false;
  }
}

async function startAr(options = {}) {
  if (running) return true;
  if (startPromise) return startPromise;

  startPromise = runArAttempt(options);
  try {
    return await startPromise;
  } finally {
    startPromise = undefined;
  }
}

async function ensureCameraAndModel(options = {}) {
  const cameraStarted = await startAr(options);
  if (!cameraStarted) return false;
  await waitForCameraPipelineReady();
  if (!activeModel) {
    if (!modelStartupPromise) {
      const requestedMode = selectedMode;
      modelStartupPromise = loadMode(requestedMode).finally(() => {
        modelStartupPromise = undefined;
      });
    }
    await modelStartupPromise;
  }
  return true;
}

async function prepare() {
  try {
    setStatus("caseとworld tracking engineを読み込み中…", "loading");
    const enginePromise = waitForEngine();
    await loadDefinition();
    assertCameraEnvironment();
    const targetPromise = loadTargetData();
    const [engine, loadedTarget] = await Promise.all([enginePromise, targetPromise]);
    xr8 = engine;
    allowedDevices = worldArCompatibility(xr8);
    targetData = loadedTarget;
    targetSize = targetPhysicalSize(
      targetData.properties,
      definition.anchor.physicalWidthCm
    );
    if (!targetSize) {
      throw new Error("posterの印刷寸法とworld target寸法を対応付けられません。");
    }
    startButton.disabled = false;
    startButton.textContent = "cameraを開始";
    setStatus("cameraを自動起動中…", "ready");
    // Let camera/SLAM finish allocating first. Decrypting and parsing a large
    // animated GLB concurrently can exceed Android's short memory/CPU peak.
    const ready = await ensureCameraAndModel({ automatic: true });
    if (!ready) return;
  } catch (error) {
    if (error?.flowArHandled) return;
    showStartFallback(
      error?.message ? error : new Error("world ARを準備できませんでした。"),
      { retry: false }
    );
    return;
  }
}

startButton.addEventListener("click", async () => {
  try {
    await ensureCameraAndModel();
  } catch (error) {
    if (error?.flowArHandled) return;
    showStartFallback(error, { retry: true });
  }
});

modePicker.addEventListener("change", async () => {
  const next = definition.modes.find((mode) => mode.id === modePicker.value);
  if (!next || (next === selectedMode && activeModel)) return;
  try {
    await loadMode(next);
  } catch (error) {
    console.error(error);
    modeLoading = false;
    updateTransport(true);
    if (selectedMode) modePicker.value = selectedMode.id;
    setStatus(error?.message || "3D modeを切り替えられませんでした", "error");
    modePicker.disabled = false;
  }
});

playButton.addEventListener("click", () => {
  if (!mixer) return;
  setPlaying(!playing);
  renderTrackingStatus();
});

seekSlider.addEventListener("input", seekToSliderValue);

ratePicker.addEventListener("change", () => {
  setPlaybackRate(ratePicker.value);
  renderTrackingStatus();
});

setupTabletLandscapeGate(orientationGate, (blocked, wasBlocked) => {
  landscapeBlocked = blocked;
  window.clearTimeout(orientationRestoreTimer);

  if (blocked) {
    clearMarkerHandoffTimer();
    if (!poseLocked) {
      resetInitialPoseSamples();
      trackingNormalSince = null;
    }
    resumeAfterLandscape = Boolean(mixer && activeAction && playing);
    if (resumeAfterLandscape) setPlaying(false);
    setStatus("tabletは横向きにしてください", "limited");
    return;
  }

  orientationRestoreTimer = window.setTimeout(() => {
    lastFrameTime = performance.now();
    if (!poseLocked) {
      resetInitialPoseSamples();
      trackingNormalSince = trackingStatus === "NORMAL" ? performance.now() : null;
    }
    if (wasBlocked && resumeAfterLandscape && mixer && activeAction) setPlaying(true);
    resumeAfterLandscape = false;
    if (autoStartPending && !running) {
      void ensureCameraAndModel({ automatic: true }).catch((error) => {
        if (!error?.flowArHandled) showStartFallback(error, { retry: true });
      });
    }
    renderTrackingStatus();
  }, 200);
});

window.addEventListener("pagehide", () => {
  arUiOverlayGuard.disconnect();
  clearMarkerHandoffTimer();
  try { xr8?.stop?.(); } catch {}
  running = false;
});

window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});

prepare();
