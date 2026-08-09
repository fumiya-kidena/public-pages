import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  deviceProfile,
  isTabletPortrait,
  requestTabletLandscapeMode,
  setupTabletLandscapeGate
} from "./deviceSupport.js?v=1";
import {
  assetObjectUrl,
  carryUnlockFragment,
  fetchAssetJson
} from "./secureAsset.js?v=1";
import {
  calibratedWorldScale,
  maySampleInitialPose,
  stableMeanScale,
  targetPhysicalSize
} from "./markerPoseCore.js?v=1";

// 8th Wall's Three.js pipeline reads this global. All application code still
// imports the same vendored Three.js module through the import map.
window.THREE = THREE;

const canvas = document.getElementById("camerafeed");
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
const fallbackLink = document.getElementById("fallback-link");
const imageFallbackLink = document.getElementById("image-fallback-link");
const scanGuide = document.getElementById("scan-guide");
const status = document.getElementById("status");
const platformNote = document.getElementById("platform-note");
const orientationGate = document.getElementById("orientation-gate");

const query = new URLSearchParams(window.location.search);
const requestedCase = query.get("case");
const requestedMode = query.get("mode");

const worldAnchorRoot = new THREE.Group();
const contentRoot = new THREE.Group();
worldAnchorRoot.name = "worldAnchorRoot";
contentRoot.name = "contentRoot";
worldAnchorRoot.add(contentRoot);
worldAnchorRoot.visible = false;

const poseSample = [];

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
let poseLocked = false;
let pipelineAdded = false;
let startPromise;
let runtimeNeedsStop = false;
let autoStartPending = false;
let automaticStartInFlight = false;
let loadSerial = 0;
let lastFrameTime = performance.now();
let trackingStatus = "INITIALIZING";
let trackingReason = "INITIALIZING";
let allowedDevices;
let landscapeBlocked = false;
let resumeAfterLandscape = false;
let orientationRestoreTimer;

function setStatus(message, state = "loading") {
  if (status.textContent === message && status.dataset.state === state) return;
  status.textContent = message;
  status.dataset.state = state;
}

function syncWorldAnchorVisibility() {
  worldAnchorRoot.visible = poseLocked && Boolean(activeModel);
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
  if (!activeAction || clipDuration <= 0) {
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
      sampleCount: Math.max(4, Math.round(positiveNumber(initialPoseConfig.sampleCount, 8))),
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
  updateLinks();
}

function updateLinks() {
  const normalPage = modeUrl("./index.html");
  fallbackLink.href = normalPage;
  homeLink.href = normalPage;
  imageFallbackLink.href = modeUrl("./imageMarkerAr.html");

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

function clearModel() {
  clearReferencePlane();
  mixer?.stopAllAction();
  mixer = null;
  activeAction = null;
  clipDuration = 0;
  lastTransportUpdateAt = -Infinity;
  transport.hidden = true;
  ratePicker.disabled = true;
  if (!activeModel) return;
  contentRoot.remove(activeModel);
  activeModel.traverse((node) => {
    if (!node.isMesh) return;
    node.geometry?.dispose();
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) material?.dispose();
  });
  activeModel = null;
  syncWorldAnchorVisibility();
}

async function loadMode(mode) {
  const serial = ++loadSerial;
  modePicker.disabled = true;
  playButton.disabled = true;
  ratePicker.disabled = true;
  setStatus(`${mode.label}を読み込み中…`, "loading");

  const modelUrl = await assetObjectUrl(versionedUrl(mode.src), "model/gltf-binary");
  const gltf = await new GLTFLoader().loadAsync(modelUrl);
  if (serial !== loadSerial) return;
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
  activeModel.scale.setScalar(physicalScale);
  activeModel.rotation.set(
    ...worldTracking.modelRotationDegree.map(THREE.MathUtils.degToRad)
  );
  contentRoot.add(activeModel);
  syncWorldAnchorVisibility();
  createReferencePlane(mode);

  if (clip) {
    mixer = new THREE.AnimationMixer(activeModel);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    action.play();
    activeAction = action;
    clipDuration = clip.duration;
    mixer.timeScale = playing ? enginePlaybackRate() : 0;
    ratePicker.disabled = false;
    updateTransport(true);
  }

  modePicker.value = mode.id;
  modePicker.disabled = false;
  playButton.disabled = !mixer;
  document.title = `FLOW AR · ${definition.label}`;
  updateLinks();
  if (running) renderTrackingStatus();
  else if (xr8 && targetData) {
    setStatus("準備完了 · 最初だけposterで位置を合わせます", "ready");
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

function averagedStablePose(samples) {
  if (samples.length < worldTracking.initialPose.sampleCount) return null;

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
  if (maxPositionSpread > worldTracking.initialPose.stabilityPositionMetres) return null;
  if (maxRotationSpread > THREE.MathUtils.degToRad(
    worldTracking.initialPose.stabilityRotationDegree
  )) return null;
  if (scale === null) return null;
  return { position, quaternion, scale };
}

function applyInitialPose(pose) {
  worldAnchorRoot.position.copy(pose.position);
  worldAnchorRoot.quaternion.copy(pose.quaternion);
  worldAnchorRoot.scale.setScalar(pose.scale);
  poseLocked = true;
  syncWorldAnchorVisibility();
  scanGuide.hidden = true;
  renderTrackingStatus();
}

function addPoseSample(detail) {
  if (!maySampleInitialPose(trackingStatus, poseLocked, landscapeBlocked)) {
    if (!poseLocked) poseSample.length = 0;
    return;
  }
  const pose = poseFromDetail(detail);
  if (!pose) return;
  poseSample.push(pose);
  while (poseSample.length > worldTracking.initialPose.sampleCount) poseSample.shift();

  const stablePose = averagedStablePose(poseSample);
  if (!stablePose) return;
  applyInitialPose(stablePose);
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
    setStatus(
      markerVisible
        ? "posterを検出 · 周囲trackingと初期位置を安定化中…"
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
  markerVisible = true;
  if (!poseLocked) poseSample.length = 0;
  addPoseSample(detail);
  renderTrackingStatus();
}

function handleImageUpdated({ detail }) {
  if (poseLocked) return;
  if (landscapeBlocked) return;
  markerVisible = true;
  addPoseSample(detail);
}

function handleImageLost({ detail }) {
  if (poseLocked) return;
  if (landscapeBlocked) return;
  if (detail?.name && detail.name !== worldTracking.targetName) return;
  markerVisible = false;
  if (!poseLocked) poseSample.length = 0;
  // worldAnchorRoot deliberately remains visible and unchanged. XR8's SLAM
  // camera continues moving in the same world coordinate frame.
  renderTrackingStatus();
}

function handleTrackingStatus({ detail }) {
  trackingStatus = detail?.status || trackingStatus;
  trackingReason = detail?.reason || trackingReason;
  if (!poseLocked && trackingStatus !== "NORMAL") poseSample.length = 0;
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
  showStartFallback(error, {
    retry: automaticStartInFlight && mayNeedUserActivation(error)
  });
}

function handleCameraStatus({ status: cameraStatus, reason }) {
  if (cameraStatus === "requesting") {
    setStatus("camera権限を確認中…", "loading");
    return;
  }
  if (cameraStatus === "hasStream") {
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
      intro.hidden = true;
      scanGuide.hidden = false;
      playButton.disabled = !mixer;
      lastFrameTime = performance.now();
      renderTrackingStatus();
    },
    onUpdate: () => {
      const now = performance.now();
      const delta = Math.min(Math.max((now - lastFrameTime) / 1000, 0), 0.1);
      lastFrameTime = now;
      if (!landscapeBlocked && playing) mixer?.update(delta);
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
    return;
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
    poseLocked = false;
    poseSample.length = 0;
    worldAnchorRoot.visible = false;
    worldAnchorRoot.scale.set(1, 1, 1);
    trackingStatus = "INITIALIZING";
    trackingReason = "INITIALIZING";

    xr8.XrController.configure({
      disableWorldTracking: false,
      scale: "absolute",
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

    await xr8.run(allowedDevices ? { canvas, allowedDevices } : { canvas });
  } catch (error) {
    handleRuntimeError(error);
  } finally {
    automaticStartInFlight = false;
  }
}

async function startAr(options = {}) {
  if (running) return;
  if (startPromise) return startPromise;

  startPromise = runArAttempt(options);
  try {
    await startPromise;
  } finally {
    startPromise = undefined;
  }
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
    startButton.disabled = false;
    startButton.textContent = "cameraを開始";
    setStatus("cameraを自動起動中…", "ready");
    void startAr({ automatic: true });
  } catch (error) {
    showStartFallback(
      error?.message ? error : new Error("world ARを準備できませんでした。"),
      { retry: false }
    );
    return;
  }

  try {
    await loadMode(selectedMode);
  } catch (error) {
    console.error(error);
    modePicker.disabled = false;
    setStatus(error?.message || "3D modelを読み込めませんでした", "error");
  }
}

startButton.addEventListener("click", async () => {
  await startAr();
});

modePicker.addEventListener("change", async () => {
  const next = definition.modes.find((mode) => mode.id === modePicker.value);
  if (!next || (next === selectedMode && activeModel)) return;
  try {
    await loadMode(next);
  } catch (error) {
    console.error(error);
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
    if (!poseLocked) poseSample.length = 0;
    resumeAfterLandscape = Boolean(mixer && activeAction && playing);
    if (resumeAfterLandscape) setPlaying(false);
    setStatus("tabletは横向きにしてください", "limited");
    return;
  }

  orientationRestoreTimer = window.setTimeout(() => {
    lastFrameTime = performance.now();
    if (!poseLocked) poseSample.length = 0;
    if (wasBlocked && resumeAfterLandscape && mixer && activeAction) setPlaying(true);
    resumeAfterLandscape = false;
    if (autoStartPending && !running) void startAr({ automatic: true });
    renderTrackingStatus();
  }, 200);
});

window.addEventListener("pagehide", () => {
  try { xr8?.stop?.(); } catch {}
  running = false;
});

window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});

prepare();
