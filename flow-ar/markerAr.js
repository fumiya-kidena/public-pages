import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

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
const homeLink = document.getElementById("home-link");
const fallbackLink = document.getElementById("fallback-link");
const imageFallbackLink = document.getElementById("image-fallback-link");
const scanGuide = document.getElementById("scan-guide");
const status = document.getElementById("status");

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
const correction = {
  active: false,
  startedAt: 0,
  durationMs: 0,
  fromPosition: new THREE.Vector3(),
  toPosition: new THREE.Vector3(),
  fromQuaternion: new THREE.Quaternion(),
  toQuaternion: new THREE.Quaternion()
};

let catalog;
let definition;
let manifestUrl;
let assetRoot;
let worldTracking;
let selectedMode;
let targetData;
let xr8;
let xrScene;
let activeModel;
let mixer;
let running = false;
let playing = true;
let markerVisible = false;
let poseLocked = false;
let pipelineAdded = false;
let reloadBeforeRetry = false;
let loadSerial = 0;
let lastFrameTime = performance.now();
let lastCorrectionAt = -Infinity;
let trackingStatus = "INITIALIZING";
let trackingReason = "INITIALIZING";

function setStatus(message, state = "loading") {
  if (status.textContent === message && status.dataset.state === state) return;
  status.textContent = message;
  status.dataset.state = state;
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

  const correctionConfig = tracking.correction || {};
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
    correction: {
      sampleCount: Math.max(4, Math.round(positiveNumber(correctionConfig.sampleCount, 8))),
      intervalMs: positiveNumber(correctionConfig.intervalMs, 1500),
      blendDurationMs: positiveNumber(correctionConfig.blendDurationMs, 600),
      positionDeadbandMetres: positiveNumber(correctionConfig.positionDeadbandMetres, 0.008),
      rotationDeadbandDegree: positiveNumber(correctionConfig.rotationDeadbandDegree, 1.5),
      maxPositionStepMetres: positiveNumber(correctionConfig.maxPositionStepMetres, 0.018),
      maxRotationStepDegree: positiveNumber(correctionConfig.maxRotationStepDegree, 2),
      stabilityPositionMetres: positiveNumber(correctionConfig.stabilityPositionMetres, 0.015),
      stabilityRotationDegree: positiveNumber(correctionConfig.stabilityRotationDegree, 3)
    }
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
  introCopy.textContent = "最初に色付きQR posterで位置を合わせます。固定後はposterが画角外でも周囲を参照して追跡し、再び映った時だけ緩やかに位置を補正します。";
  markerPreview.src = versionedUrl(definition.anchor.image);
  markerPreview.hidden = false;
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

function clearModel() {
  mixer?.stopAllAction();
  mixer = null;
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

  const physicalScale = Number(mode.webAr?.modelScale ?? 1);
  if (!Number.isFinite(physicalScale) || physicalScale <= 0) {
    throw new Error(`${mode.id}: webAr.modelScaleが不正です。`);
  }

  clearModel();
  selectedMode = mode;
  activeModel = gltf.scene;
  activeModel.scale.setScalar(physicalScale);
  activeModel.rotation.set(
    ...worldTracking.modelRotationDegree.map(THREE.MathUtils.degToRad)
  );
  contentRoot.add(activeModel);

  if (clip) {
    mixer = new THREE.AnimationMixer(activeModel);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    action.play();
    mixer.timeScale = playing ? 1 : 0;
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

async function loadTargetData() {
  const response = await fetch(versionedUrl(worldTracking.target), { cache: "no-cache" });
  if (!response.ok) throw new Error(`world target: HTTP ${response.status}`);
  const data = await response.json();
  if (!data?.properties || data.name !== worldTracking.targetName) {
    throw new Error("world target dataがmanifestと一致しません。");
  }
  data.imagePath = versionedUrl(worldTracking.image);
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
  return { position, quaternion, capturedAt: performance.now() };
}

function averagedStablePose(samples) {
  if (samples.length < worldTracking.correction.sampleCount) return null;

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
  if (maxPositionSpread > worldTracking.correction.stabilityPositionMetres) return null;
  if (maxRotationSpread > THREE.MathUtils.degToRad(
    worldTracking.correction.stabilityRotationDegree
  )) return null;
  return { position, quaternion };
}

function applyInitialPose(pose) {
  worldAnchorRoot.position.copy(pose.position);
  worldAnchorRoot.quaternion.copy(pose.quaternion);
  worldAnchorRoot.scale.set(1, 1, 1);
  worldAnchorRoot.visible = true;
  poseLocked = true;
  scanGuide.hidden = true;
  lastCorrectionAt = performance.now();
  renderTrackingStatus();
}

function beginCorrection(pose, now) {
  const positionDistance = worldAnchorRoot.position.distanceTo(pose.position);
  const rotationDistance = quaternionAngle(worldAnchorRoot.quaternion, pose.quaternion);
  const positionDeadband = worldTracking.correction.positionDeadbandMetres;
  const rotationDeadband = THREE.MathUtils.degToRad(
    worldTracking.correction.rotationDeadbandDegree
  );

  lastCorrectionAt = now;
  if (positionDistance <= positionDeadband && rotationDistance <= rotationDeadband) return;

  correction.fromPosition.copy(worldAnchorRoot.position);
  correction.fromQuaternion.copy(worldAnchorRoot.quaternion);

  const positionFraction = positionDistance > 0
    ? Math.min(1, worldTracking.correction.maxPositionStepMetres / positionDistance)
    : 1;
  correction.toPosition.copy(worldAnchorRoot.position).lerp(pose.position, positionFraction);

  const maxRotationStep = THREE.MathUtils.degToRad(
    worldTracking.correction.maxRotationStepDegree
  );
  const rotationFraction = rotationDistance > 0
    ? Math.min(1, maxRotationStep / rotationDistance)
    : 1;
  correction.toQuaternion.copy(worldAnchorRoot.quaternion).slerp(
    pose.quaternion,
    rotationFraction
  );

  correction.startedAt = now;
  correction.durationMs = worldTracking.correction.blendDurationMs;
  correction.active = true;
  renderTrackingStatus();
}

function addPoseSample(detail) {
  const pose = poseFromDetail(detail);
  if (!pose) return;
  poseSample.push(pose);
  while (poseSample.length > worldTracking.correction.sampleCount) poseSample.shift();

  const stablePose = averagedStablePose(poseSample);
  if (!stablePose) return;
  if (!poseLocked) {
    applyInitialPose(stablePose);
    return;
  }

  const now = performance.now();
  if (correction.active || now - lastCorrectionAt < worldTracking.correction.intervalMs) return;
  beginCorrection(stablePose, now);
}

function updateCorrection(now) {
  if (!correction.active) return;
  const linear = Math.min(1, Math.max(0, (now - correction.startedAt) / correction.durationMs));
  const eased = linear * linear * (3 - 2 * linear);
  worldAnchorRoot.position.lerpVectors(
    correction.fromPosition,
    correction.toPosition,
    eased
  );
  worldAnchorRoot.quaternion.copy(correction.fromQuaternion).slerp(
    correction.toQuaternion,
    eased
  );
  if (linear >= 1) {
    correction.active = false;
    renderTrackingStatus();
  }
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
  if (!poseLocked) {
    setStatus(
      markerVisible ? "posterを検出 · 位置を安定化中…" : "色付きQR poster全体を映してください",
      "scanning"
    );
    return;
  }
  if (correction.active) {
    setStatus("world tracking継続中 · poster基準へ緩やかに補正中", "correcting");
    return;
  }
  if (trackingStatus === "LIMITED" || trackingStatus === "NOT_AVAILABLE") {
    setStatus(readableTrackingReason(trackingReason), "limited");
    return;
  }
  if (markerVisible) {
    setStatus("world tracking中 · posterは低頻度の補正参照", "world");
  } else {
    setStatus("world tracking継続中 · posterは画角外でもOK", "world");
  }
}

function handleImageFound({ detail }) {
  markerVisible = true;
  poseSample.length = 0;
  addPoseSample(detail);
  renderTrackingStatus();
}

function handleImageUpdated({ detail }) {
  markerVisible = true;
  addPoseSample(detail);
}

function handleImageLost({ detail }) {
  if (detail?.name && detail.name !== worldTracking.targetName) return;
  markerVisible = false;
  poseSample.length = 0;
  // worldAnchorRoot deliberately remains visible and unchanged. XR8's SLAM
  // camera continues moving in the same world coordinate frame.
  renderTrackingStatus();
}

function handleTrackingStatus({ detail }) {
  trackingStatus = detail?.status || trackingStatus;
  trackingReason = detail?.reason || trackingReason;
  renderTrackingStatus();
}

function handleRuntimeError(error) {
  console.error(error);
  running = false;
  reloadBeforeRetry = true;
  intro.hidden = false;
  const message = error?.message || "";
  introError.textContent = /No valid session manager/i.test(message)
    ? "このbrowser／端末ではworld trackingを開始できません。iPhoneまたはAndroidの対応browserで開くか、image-marker版を使ってください。"
    : message || "world trackingを開始できませんでした。image-marker版を試してください。";
  introError.hidden = false;
  startButton.disabled = false;
  startButton.textContent = "再読み込みして試す";
  setStatus("world trackingを開始できませんでした", "error");
}

function createWorldPipelineModule() {
  return {
    name: "flow-ar-world-anchor",
    onStart: () => {
      xrScene = xr8.Threejs.xrScene();
      const { scene, camera, renderer } = xrScene;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
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
      if (playing) mixer?.update(delta);
      updateCorrection(now);
    },
    onException: handleRuntimeError,
    listeners: [
      { event: "reality.imagefound", process: handleImageFound },
      { event: "reality.imageupdated", process: handleImageUpdated },
      { event: "reality.imagelost", process: handleImageLost },
      { event: "reality.trackingstatus", process: handleTrackingStatus }
    ]
  };
}

async function startAr() {
  startButton.disabled = true;
  startButton.textContent = "cameraを起動中…";
  introError.hidden = true;
  setStatus("cameraとworld trackingを起動中…", "loading");

  try {
    if (!window.isSecureContext && window.location.hostname !== "localhost") {
      throw new Error("camera ARにはHTTPSが必要です。公開URLかlocalhostから開いてください。");
    }
    if (!xr8 || !targetData || !activeModel) {
      throw new Error("world ARの準備が完了していません。");
    }

    markerVisible = false;
    poseLocked = false;
    poseSample.length = 0;
    correction.active = false;
    worldAnchorRoot.visible = false;
    trackingStatus = "INITIALIZING";
    trackingReason = "INITIALIZING";

    xr8.XrController.configure({
      disableWorldTracking: false,
      scale: "absolute",
      imageTargetData: [targetData]
    });

    if (!pipelineAdded) {
      xr8.addCameraPipelineModules([
        xr8.GlTextureRenderer.pipelineModule(),
        xr8.Threejs.pipelineModule(),
        xr8.XrController.pipelineModule(),
        createWorldPipelineModule()
      ]);
      pipelineAdded = true;
    }

    await xr8.run({ canvas });
  } catch (error) {
    handleRuntimeError(error);
  }
}

async function prepare() {
  try {
    setStatus("caseとworld tracking engineを読み込み中…", "loading");
    const enginePromise = waitForEngine();
    await loadDefinition();
    const [loadedEngine, loadedTarget] = await Promise.all([
      enginePromise,
      loadTargetData(),
      loadMode(selectedMode)
    ]);
    xr8 = loadedEngine;
    targetData = loadedTarget;
    modePicker.disabled = false;
    startButton.disabled = false;
    startButton.textContent = "cameraを開始";
    setStatus("準備完了 · 最初だけposterで位置を合わせます", "ready");
  } catch (error) {
    console.error(error);
    introError.textContent = error?.message || "world ARを準備できませんでした。";
    introError.hidden = false;
    startButton.disabled = true;
    setStatus("world ARを準備できませんでした", "error");
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
  if (!next || next === selectedMode) return;
  try {
    await loadMode(next);
  } catch (error) {
    console.error(error);
    setStatus(error?.message || "3D modeを切り替えられませんでした", "error");
    modePicker.disabled = false;
  }
});

playButton.addEventListener("click", () => {
  if (!mixer) return;
  playing = !playing;
  mixer.timeScale = playing ? 1 : 0;
  playButton.textContent = playing ? "一時停止" : "再生";
  renderTrackingStatus();
});

window.addEventListener("pagehide", () => {
  try { xr8?.stop?.(); } catch {}
  running = false;
});

window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});

prepare();
