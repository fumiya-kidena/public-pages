import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MindARThree } from "mindar-image-three";
import {
  deviceProfile,
  isTabletPortrait,
  requestTabletLandscapeMode,
  setupTabletLandscapeGate
} from "./deviceSupport.js?v=1";

const stage = document.getElementById("ar-stage");
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
const seekTime = document.getElementById("seek-time");
const homeLink = document.getElementById("home-link");
const fallbackLink = document.getElementById("fallback-link");
const scanGuide = document.getElementById("scan-guide");
const status = document.getElementById("status");
const platformNote = document.getElementById("platform-note");
const orientationGate = document.getElementById("orientation-gate");

const query = new URLSearchParams(window.location.search);
const requestedCase = query.get("case");
const requestedMode = query.get("mode");

let catalog;
let definition;
let manifestUrl;
let assetRoot;
let webTracking;
let selectedMode;
let mindarThree;
let anchor;
let contentRoot;
let activeModel;
let mixer;
let activeAction;
let clipDuration = 0;
let playbackRate = 1;
let lastTransportUpdateAt = -Infinity;
let running = false;
let playing = true;
let reloadBeforeRetry = false;
let loadSerial = 0;
let lastFrameTime = performance.now();
let landscapeBlocked = false;
let resumeAfterLandscape = false;
let orientationRestoreTimer;

function setStatus(message, state = "loading") {
  status.textContent = message;
  status.dataset.state = state;
}

function isMarkerVisible() {
  return Boolean(anchor?.group?.visible);
}

function currentClipTime() {
  if (!activeAction || clipDuration <= 0) return 0;
  return ((activeAction.time % clipDuration) + clipDuration) % clipDuration;
}

function updateTransport(force = false) {
  if (!activeAction || clipDuration <= 0) {
    transport.hidden = true;
    return;
  }

  const now = performance.now();
  if (!force && now - lastTransportUpdateAt < 100) return;
  lastTransportUpdateAt = now;
  transport.hidden = false;
  const clipTime = currentClipTime();
  const sliderValue = Math.round((clipTime / clipDuration) * 1000);
  seekSlider.value = String(sliderValue);
  seekTime.textContent = `${playbackRate}× · ${clipTime.toFixed(1)} / ${clipDuration.toFixed(1)} s`;
  seekSlider.setAttribute(
    "aria-valuetext",
    `${clipTime.toFixed(1)} / ${clipDuration.toFixed(1)}秒、${playbackRate}倍速`
  );
}

function setPlaying(nextPlaying) {
  if (!mixer || !activeAction) return;
  playing = Boolean(nextPlaying);
  mixer.timeScale = playing ? playbackRate : 0;
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
  setStatus(
    `${selectedMode.label} · 一時停止`,
    isMarkerVisible() ? "found" : "scanning"
  );
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
  return url.href;
}

function collectCaseReferences(source) {
  const references = [];
  for (const category of source.categories || []) {
    for (const reference of category.case || []) references.push(reference);
  }
  for (const reference of source.auxiliary || []) references.push(reference);
  return references;
}

function validateTracking(caseDefinition) {
  const anchorDefinition = caseDefinition.anchor;
  const tracking = anchorDefinition?.webTracking;
  const widthCm = Number(anchorDefinition?.physicalWidthCm);
  const liftMetres = Number(anchorDefinition?.liftMetres);
  if (!anchorDefinition?.image || !tracking?.target) {
    throw new Error("このcaseにはbrowser marker ARがありません。");
  }
  if (!Number.isFinite(widthCm) || widthCm <= 0 || !Number.isFinite(liftMetres)) {
    throw new Error("markerの実寸設定が不正です。");
  }
  const offset = tracking.contentOffset;
  if (offset && (!Array.isArray(offset) || offset.length !== 2 || !offset.every(Number.isFinite))) {
    throw new Error("marker上の表示位置が不正です。");
  }
  return {
    ...tracking,
    targetIndex: Number.isInteger(tracking.targetIndex) ? tracking.targetIndex : 0,
    contentOffset: offset || [0, 0],
    physicalWidthMetres: widthCm / 100,
    liftMetres
  };
}

async function loadDefinition() {
  const catalogUrl = new URL("./case/catalog.json", document.baseURI);
  const response = await fetch(catalogUrl, { cache: "no-cache" });
  if (!response.ok) throw new Error(`case catalog: HTTP ${response.status}`);
  catalog = await response.json();
  if (catalog.schemaVersion !== 1) throw new Error("未対応のcase catalogです。");

  const references = collectCaseReferences(catalog);
  const reference = references.find((item) => item.id === requestedCase)
    || references.find((item) => item.id === "bagBreakup")
    || references[0];
  if (!reference?.manifest) throw new Error("表示できるcaseがありません。");

  manifestUrl = new URL(reference.manifest, catalogUrl);
  const manifestResponse = await fetch(manifestUrl, { cache: "no-cache" });
  if (!manifestResponse.ok) throw new Error(`case manifest: HTTP ${manifestResponse.status}`);
  definition = await manifestResponse.json();
  if (definition.schemaVersion !== 1 || !Array.isArray(definition.modes)) {
    throw new Error("case manifestが不正です。");
  }
  webTracking = validateTracking(definition);
  assetRoot = new URL(definition.assetRoot, manifestUrl);

  const modes = definition.modes.filter((mode) => mode.kind === "model" && mode.src);
  if (!modes.length) throw new Error("marker ARで表示できる3D modeがありません。");
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
  modePicker.disabled = false;
  introTitle.textContent = definition.label;
  introCopy.textContent = "world tracking非対応端末向けです。開始後、印刷した色付きQR poster全体を映し続けてください。";
  platformNote.textContent = deviceProfile.isAndroid
    ? deviceProfile.isTablet
      ? "Android tablet · 横向き · posterを映し続けるfallback"
      : "Android · posterを映し続けるfallback"
    : deviceProfile.isAppleTablet
      ? "iPad Safari · 横向き · posterを映し続けるfallback"
      : "iPhone Safari／Androidの対応browser向けfallback";
  markerPreview.src = versionedUrl(definition.anchor.image);
  markerPreview.hidden = false;
  startButton.disabled = false;
  startButton.textContent = "cameraを開始";
  updateLinks();
  setStatus("camera開始待ち", "ready");
}

function updateLinks() {
  const fallback = modeUrl("./index.html");
  fallbackLink.href = fallback;
  homeLink.href = fallback;
  const url = new URL(window.location.href);
  url.searchParams.set("case", definition.id);
  url.searchParams.set("mode", selectedMode.id);
  window.history.replaceState(null, "", url);
}

function clearModel() {
  mixer?.stopAllAction();
  mixer = null;
  activeAction = null;
  clipDuration = 0;
  lastTransportUpdateAt = -Infinity;
  transport.hidden = true;
  if (!activeModel) return;
  contentRoot.remove(activeModel);
  activeModel.traverse((node) => {
    if (!node.isMesh) return;
    node.geometry?.dispose();
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) material?.dispose();
  });
  activeModel = null;
}

async function loadMode(mode) {
  const serial = ++loadSerial;
  modePicker.disabled = true;
  playButton.disabled = true;
  setStatus(`${mode.label}を読み込み中…`, "loading");
  const gltf = await new GLTFLoader().loadAsync(versionedUrl(mode.src));
  if (serial !== loadSerial) return;
  const clip = mode.animationName
    ? THREE.AnimationClip.findByName(gltf.animations, mode.animationName)
    : gltf.animations[0];
  if (mode.animationName && !clip) {
    throw new Error(`${mode.id}: animation clip ${mode.animationName} がGLBにありません。`);
  }

  clearModel();
  selectedMode = mode;
  activeModel = gltf.scene;
  const physicalScale = Number(mode.webAr?.modelScale ?? 1);
  if (!Number.isFinite(physicalScale) || physicalScale <= 0) {
    throw new Error(`${mode.id}: webAr.modelScaleが不正です。`);
  }
  const requestedPlaybackRate = Number(mode.webAr?.playbackRate ?? 1);
  if (!Number.isFinite(requestedPlaybackRate) || requestedPlaybackRate <= 0) {
    throw new Error(`${mode.id}: webAr.playbackRateが不正です。`);
  }
  playbackRate = requestedPlaybackRate;
  const normalizedScale = physicalScale / webTracking.physicalWidthMetres;
  activeModel.scale.setScalar(normalizedScale);
  const rotation = mode.webAr?.rotationDegree || webTracking.modelRotationDegree || [90, 0, 0];
  if (!Array.isArray(rotation) || rotation.length !== 3 || !rotation.every(Number.isFinite)) {
    throw new Error(`${mode.id}: marker ARの回転設定が不正です。`);
  }
  activeModel.rotation.set(...rotation.map(THREE.MathUtils.degToRad));
  contentRoot.add(activeModel);

  if (clip) {
    mixer = new THREE.AnimationMixer(activeModel);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    action.play();
    activeAction = action;
    clipDuration = clip.duration;
    mixer.timeScale = playing ? playbackRate : 0;
    updateTransport(true);
  }

  modePicker.value = mode.id;
  modePicker.disabled = false;
  playButton.disabled = !mixer;
  updateLinks();
  document.title = `FLOW AR · ${definition.label}`;
  if (!running) setStatus(`${mode.label}の3Dを準備完了 · cameraを初期化中…`, "loading");
  else {
    setStatus(
      isMarkerVisible()
        ? `${mode.label} · ${playing ? "animation再生中" : "一時停止"}`
        : "色付きQR poster全体をcameraへ映してください",
      isMarkerVisible() ? "found" : "scanning"
    );
  }
}

function createArScene() {
  const targetUrl = versionedUrl(webTracking.target);
  mindarThree = new MindARThree({
    container: stage,
    imageTargetSrc: targetUrl,
    maxTrack: 1,
    uiLoading: "no",
    uiScanning: "no",
    uiError: "no",
    filterMinCF: Number(webTracking.filterMinCF ?? 0.001),
    filterBeta: Number(webTracking.filterBeta ?? 1000),
    warmupTolerance: Number(webTracking.warmupTolerance ?? 3),
    missTolerance: Number(webTracking.missTolerance ?? 5)
  });
  const { renderer, scene } = mindarThree;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, deviceProfile.isTablet ? 1.5 : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene.add(new THREE.HemisphereLight(0xe9f7ff, 0x20303a, 2.4));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.1);
  keyLight.position.set(-1.5, 2.5, 3);
  scene.add(keyLight);

  anchor = mindarThree.addAnchor(webTracking.targetIndex);
  contentRoot = new THREE.Group();
  const [offsetX, offsetY] = webTracking.contentOffset;
  contentRoot.position.set(
    offsetX,
    offsetY,
    webTracking.liftMetres / webTracking.physicalWidthMetres
  );
  anchor.group.add(contentRoot);

  anchor.onTargetFound = () => {
    if (landscapeBlocked) return;
    scanGuide.hidden = true;
    setStatus(`${selectedMode.label} · ${playing ? "animation再生中" : "一時停止"}`, "found");
  };
  anchor.onTargetLost = () => {
    if (landscapeBlocked) return;
    scanGuide.hidden = false;
    setStatus("markerを見失いました。色付きposter全体を映してください", "scanning");
  };
}

function stopArSession() {
  mindarThree?.renderer?.setAnimationLoop(null);
  try { mindarThree?.controller?.stopProcessVideo?.(); } catch {}
  try { mindarThree?.controller?.dispose?.(); } catch {}
  try {
    mindarThree?.video?.srcObject?.getTracks?.().forEach((track) => track.stop());
  } catch {}
  try { mindarThree?.video?.remove?.(); } catch {}
  try { mindarThree?.renderer?.dispose?.(); } catch {}
  try { mindarThree?.renderer?.domElement?.remove?.(); } catch {}
  try { mindarThree?.cssRenderer?.domElement?.remove?.(); } catch {}
  running = false;
}

async function startAr() {
  if (isTabletPortrait()) {
    setStatus("tabletは横向きにしてください", "scanning");
    return;
  }

  startButton.disabled = true;
  startButton.textContent = "cameraを準備中…";
  introError.hidden = true;
  setStatus("3Dとcameraを準備中…", "loading");
  try {
    if (!window.isSecureContext && window.location.hostname !== "localhost") {
      throw new Error("camera ARにはHTTPSが必要です。公開URLから開いてください。");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("このbrowserではcamera APIを利用できません。通常3Dを使ってください。");
    }
    await requestTabletLandscapeMode();
    createArScene();
    await loadMode(selectedMode);
    await mindarThree.start();
    running = true;
    intro.hidden = true;
    scanGuide.hidden = false;
    playButton.disabled = !mixer;
    lastFrameTime = performance.now();
    mindarThree.renderer.setAnimationLoop((time) => {
      const delta = Math.min(Math.max((time - lastFrameTime) / 1000, 0), 0.1);
      lastFrameTime = time;
      if (!landscapeBlocked && playing) mixer?.update(delta);
      updateTransport();
      mindarThree.renderer.render(mindarThree.scene, mindarThree.camera);
    });
    setStatus("色付きQR poster全体をcameraへ映してください", "scanning");
  } catch (error) {
    console.error(error);
    stopArSession();
    reloadBeforeRetry = true;
    intro.hidden = false;
    introError.textContent = error?.message || "camera ARを開始できませんでした。";
    introError.hidden = false;
    startButton.disabled = false;
    startButton.textContent = "もう一度試す";
    setStatus("camera ARを開始できませんでした", "error");
  }
}

startButton.addEventListener("click", () => {
  if (reloadBeforeRetry) {
    window.location.reload();
    return;
  }
  startAr();
});

modePicker.addEventListener("change", async () => {
  const next = definition.modes.find((mode) => mode.id === modePicker.value);
  if (!next || next.id === selectedMode.id) return;
  try {
    await loadMode(next);
  } catch (error) {
    console.error(error);
    modePicker.disabled = false;
    setStatus("3D modeを切り替えられませんでした", "error");
  }
});

playButton.addEventListener("click", () => {
  if (!mixer) return;
  setPlaying(!playing);
  setStatus(
    playing ? `${selectedMode.label} · animation再生中` : `${selectedMode.label} · 一時停止`,
    isMarkerVisible() ? "found" : "scanning"
  );
});

seekSlider.addEventListener("input", seekToSliderValue);

setupTabletLandscapeGate(orientationGate, (blocked, wasBlocked) => {
  landscapeBlocked = blocked;
  window.clearTimeout(orientationRestoreTimer);

  if (blocked) {
    resumeAfterLandscape = Boolean(mixer && activeAction && playing);
    if (resumeAfterLandscape) setPlaying(false);
    setStatus("tabletは横向きにしてください", "scanning");
    return;
  }

  orientationRestoreTimer = window.setTimeout(() => {
    lastFrameTime = performance.now();
    mindarThree?.resize?.();
    if (wasBlocked && resumeAfterLandscape && mixer && activeAction) setPlaying(true);
    resumeAfterLandscape = false;
    if (running) {
      setStatus(
        isMarkerVisible()
          ? `${selectedMode.label} · ${playing ? "animation再生中" : "一時停止"}`
          : "色付きQR poster全体をcameraへ映してください",
        isMarkerVisible() ? "found" : "scanning"
      );
    }
  }, 200);
});

document.addEventListener("visibilitychange", () => {
  lastFrameTime = performance.now();
});

window.addEventListener("pagehide", () => {
  stopArSession();
});

window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});

loadDefinition().catch((error) => {
  console.error(error);
  introError.textContent = error?.message || "caseを読み込めませんでした。";
  introError.hidden = false;
  startButton.textContent = "利用できません";
  setStatus("caseを読み込めませんでした", "error");
});
