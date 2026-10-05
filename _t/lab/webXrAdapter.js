// Manual-placement baseline, not image/colour-point tracking. No camera images,
// QR payloads, case catalogues, or encrypted assets are read by this adapter.
// API references:
// https://developers.google.com/ar/develop/webxr/hello-webxr
// https://developer.mozilla.org/en-US/docs/Web/API/XRFrame/createAnchor
// https://developer.mozilla.org/en-US/docs/Web/API/XRReferenceSpace/reset_event

const CARD_WIDTH_M = 0.091;
const CARD_HEIGHT_M = 0.055;
const MAX_HIT_AGE_MS = 200;

function finiteVector(value, name) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) {
    throw new Error(`${name} must contain three finite numbers`);
  }
  return value.slice();
}

const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function unit(value, name) {
  const length = Math.hypot(...value);
  if (!(length > 1e-8)) throw new Error(`${name} is degenerate`);
  return value.map((component) => component / length);
}

/**
 * Two hand-selected points at the centre of the left/right card edges.
 * Card coordinates are +X=right, +Y=up on paper, +Z=out of paper.
 * The measured span, not an assumed print size, supplies the uniform scale.
 */
export function computeManualCardPlacement(first, second, {
  cardWidthM = CARD_WIDTH_M,
  cardHeightM = CARD_HEIGHT_M,
} = {}) {
  if (!(Number.isFinite(cardWidthM) && cardWidthM > 0)
      || !(Number.isFinite(cardHeightM) && cardHeightM > 0)) {
    throw new Error('Canonical card dimensions must be positive metres');
  }
  const left = finiteVector(first?.position, 'Left endpoint');
  const right = finiteVector(second?.position, 'Right endpoint');
  const firstNormal = unit(finiteVector(first?.normal, 'First normal'), 'First normal');
  let secondNormal = unit(finiteVector(second?.normal, 'Second normal'), 'Second normal');
  if (dot(firstNormal, secondNormal) < 0) secondNormal = secondNormal.map((v) => -v);
  if (dot(firstNormal, secondNormal) < Math.cos(25 * Math.PI / 180)) {
    throw new Error('左右の端点で異なる面が検出されました。カードと同じ平面を狙ってください。');
  }
  const normal = unit(firstNormal.map((v, i) => v + secondNormal[i]), 'Paper normal');
  const delta = right.map((v, i) => v - left[i]);
  const depth = dot(delta, normal);
  const planarDelta = delta.map((v, i) => v - depth * normal[i]);
  const widthM = Math.hypot(...planarDelta);
  if (!(widthM >= 0.025 && widthM <= 1)) {
    throw new Error('左右の端点を離して指定してください（紙面幅 25 mm〜1 m）。');
  }
  if (Math.abs(depth) > Math.max(0.003, widthM * 0.07)) {
    throw new Error('左右の端点の高さが異なります。同じ紙面の左右端を指定してください。');
  }
  const xAxis = unit(planarDelta, 'Long edge');
  const yAxis = unit(cross(normal, xAxis), 'Short edge');
  // Re-orthogonalise: X cross Y must equal the card's outward Z normal.
  const zAxis = unit(cross(xAxis, yAxis), 'Paper normal');
  return {
    position: left.map((v, i) => (v + right[i]) / 2),
    axes: { x: xAxis, y: yAxis, z: zAxis },
    widthM,
    heightM: widthM * cardHeightM / cardWidthM,
    scale: widthM / cardWidthM,
  };
}

function supportReason(error) {
  if (error?.name === 'SecurityError' || error?.name === 'NotAllowedError') {
    return 'ARの許可が得られませんでした。HTTPSとブラウザのカメラ／AR権限を確認してください。';
  }
  if (error?.name === 'NotSupportedError') {
    return 'この端末／ブラウザはWebXRのARと平面hit-testに対応していません。別の比較モードを選んでください。';
  }
  return error?.message || 'WebXRのARを開始できませんでした。';
}

export async function probeWebXr() {
  if (globalThis.isSecureContext === false) {
    return { supported: false, reason: 'WebXRはHTTPSまたはlocalhostで開く必要があります。' };
  }
  const xr = globalThis.navigator?.xr;
  if (!xr?.isSessionSupported || !xr?.requestSession) {
    return { supported: false, reason: 'このブラウザにはWebXRのimmersive-ar APIがありません。' };
  }
  try {
    const supported = await xr.isSessionSupported('immersive-ar');
    return {
      supported,
      reason: supported
        ? 'WebXR AR対応。hit-test／権限の可否は開始時に確認します。'
        : 'この端末／ブラウザではWebXR ARを開始できません。',
    };
  } catch (error) {
    return { supported: false, reason: supportReason(error) };
  }
}

function notify(callback, value) {
  // A statistics/UI callback must not strand a live camera session on failure.
  if (typeof callback !== 'function') return;
  try { callback(value); } catch { /* The adapter owns its lifecycle regardless. */ }
}

/**
 * Call directly from the user's Start click (requestSession needs activation).
 * createBox({cardWidthM, cardHeightM}) returns {group, dispose}; group is in
 * canonical metres and card-local XY. This adapter calls dispose exactly once.
 * Mode changes must reload the page; never run XR8 on the same canvas/session.
 * Optional anchors do not imply image tracking: the paper itself is not tracked.
 */
export async function startWebXr({
  THREE,
  canvas,
  createBox,
  overlayRoot = null,
  onMetrics,
  onStatus,
  onFrame,
  onError,
  signal = null,
  cardWidthM = CARD_WIDTH_M,
  cardHeightM = CARD_HEIGHT_M,
}) {
  if (!THREE || !canvas || typeof createBox !== 'function') {
    throw new Error('WebXR adapter needs THREE, canvas, and createBox');
  }
  if (!(Number.isFinite(cardWidthM) && cardWidthM > 0)
      || !(Number.isFinite(cardHeightM) && cardHeightM > 0)) {
    throw new Error('Canonical card dimensions must be positive metres');
  }
  if (globalThis.isSecureContext === false || !globalThis.navigator?.xr?.requestSession) {
    throw new Error('この端末／ブラウザではWebXR ARを開始できません。HTTPSと対応端末を確認してください。');
  }
  if (signal?.aborted) throw new DOMException('AR start cancelled', 'AbortError');

  let session = null;
  let sessionEnded = false;
  let disposed = false;
  let stopPromise = null;
  let renderer = null;
  let gl = null;
  let baseLayer = null;
  let scene = null;
  let camera = null;
  let box = null;
  let referenceSpace = null;
  let hitSource = null;
  let frameHandle = null;
  let reticle = null;
  let firstPointVisual = null;
  let reticleGeometry = null;
  let reticleMaterial = null;
  let firstPointMaterial = null;
  let firstPoint = null;
  let lastHit = null;
  let placement = null;
  let placementMatrix = null;
  let placementEpoch = 0;
  let anchor = null;
  let anchorPending = false;
  let anchorKind = 'none';
  let currentState = '';
  let currentMessage = '';
  let currentCanConfirm = false;
  let lastFrameAt = null;
  let metricsStartedAt = null;
  let metricsFrames = 0;
  let metricsPoses = 0;
  let metricsCpuMs = 0;
  let renderFps = null;
  let poseFps = null;
  const listeners = [];

  const now = () => globalThis.performance?.now?.() ?? Date.now();
  function status(state, message, canConfirm = false) {
    if (state === currentState && message === currentMessage && canConfirm === currentCanConfirm) return;
    currentState = state;
    currentMessage = message;
    currentCanConfirm = canConfirm;
    notify(onStatus, {
      state, message, canConfirm,
      placementStage: placement ? 2 : firstPoint ? 1 : 0,
      anchorKind,
      manualPlacement: true,
      imageTracking: false,
    });
  }
  function listen(target, type, callback, options) {
    target?.addEventListener?.(type, callback, options);
    listeners.push(() => target?.removeEventListener?.(type, callback, options));
  }
  function deleteAnchor(value) {
    try { value?.delete?.(); } catch { /* Ended sessions may already own cleanup. */ }
  }
  function clearPlacement() {
    placementEpoch += 1;
    deleteAnchor(anchor);
    anchor = null;
    anchorPending = false;
    anchorKind = 'none';
    placement = null;
    placementMatrix = null;
    firstPoint = null;
    lastHit = null;
    if (box?.group) box.group.visible = false;
    if (firstPointVisual) firstPointVisual.visible = false;
    if (reticle) reticle.visible = false;
  }
  function resetPlacement() {
    if (disposed) return false;
    clearPlacement();
    status('searching', '中央の照準をカード長辺の左端中央に合わせて、端点を決定してください。');
    return true;
  }
  function disposeScene() {
    try { box?.dispose?.(); } catch { /* Continue releasing all owned resources. */ }
    box = null;
    try { reticleGeometry?.dispose(); } catch { /* Continue. */ }
    try { reticleMaterial?.dispose(); } catch { /* Continue. */ }
    try { firstPointMaterial?.dispose(); } catch { /* Continue. */ }
    try { renderer?.renderLists?.dispose(); } catch { /* Continue. */ }
    try { renderer?.dispose(); } catch { /* Continue. */ }
    try { renderer?.forceContextLoss?.(); } catch { /* Session has ended. */ }
    renderer = null;
    scene?.clear?.();
  }
  function stop(reason = 'user') {
    if (stopPromise) return stopPromise;
    disposed = true;
    clearPlacement();
    for (const remove of listeners.splice(0)) remove();
    try { if (frameHandle !== null) session?.cancelAnimationFrame(frameHandle); } catch { /* Ended. */ }
    frameHandle = null;
    try { hitSource?.cancel(); } catch { /* Ended. */ }
    hitSource = null;
    // Install the idempotent Promise before end/status callbacks can re-enter.
    stopPromise = Promise.resolve().then(async () => {
      try {
        if (session && !sessionEnded) await session.end();
      } catch { /* end() can reject when the native session has already ended. */ }
      finally {
        sessionEnded = true;
        disposeScene();
        if (reason !== 'error') {
          status('ended', reason === 'background'
            ? 'バックグラウンドに移ったためARを終了しました。再開するには開始を押してください。'
            : 'WebXR ARを終了しました。');
        }
      }
    });
    return stopPromise;
  }
  function fail(error) {
    if (disposed) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    status('error', supportReason(failure));
    notify(onError, failure);
    void stop('error');
  }
  function confirmPoint() {
    if (disposed || placement || !lastHit || now() - lastHit.capturedAtMs > MAX_HIT_AGE_MS) {
      if (!disposed) status('searching', '平面を検出できていません。カードの周囲も映し、中央の照準が出るまで待ってください。');
      return false;
    }
    if (!firstPoint) {
      firstPoint = lastHit;
      firstPointVisual.matrix.fromArray(firstPoint.matrix);
      firstPointVisual.visible = true;
      status('point-ready', '次に照準をカード長辺の右端中央へ合わせて、端点を決定してください。', true);
      return true;
    }
    try {
      placement = computeManualCardPlacement(firstPoint, lastHit, { cardWidthM, cardHeightM });
    } catch (error) {
      status('point-rejected', error.message, true);
      return false;
    }
    const { axes, position, scale } = placement;
    placementMatrix = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(...axes.x), new THREE.Vector3(...axes.y), new THREE.Vector3(...axes.z),
    );
    placementMatrix.setPosition(...position);
    box.group.matrix.copy(placementMatrix).scale(new THREE.Vector3(scale, scale, scale));
    box.group.visible = true;
    firstPointVisual.visible = false;
    reticle.visible = false;
    anchorKind = 'local-space';
    // createAnchor must run while a fresh XRFrame is active, not in a DOM click.
    anchorPending = true;
    status('placed', '手動配置完了。紙を動かさず、スマホを動かして箱の追従を比較してください。');
    return true;
  }
  function requestPlacementAnchor(frame) {
    if (!anchorPending || !placement || disposed) return;
    anchorPending = false;
    const enabled = session.enabledFeatures;
    if (typeof frame.createAnchor !== 'function'
        || typeof globalThis.XRRigidTransform !== 'function'
        || (enabled && !Array.from(enabled).includes('anchors'))) {
      status('placed', '手動配置完了（アンカーAPIなし：local-space固定）。紙は追跡していません。');
      return;
    }
    const epoch = placementEpoch;
    const point = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    placementMatrix.decompose(point, rotation, scale);
    let result;
    try {
      result = frame.createAnchor(new XRRigidTransform(
        { x: point.x, y: point.y, z: point.z },
        { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
      ), referenceSpace);
    } catch {
      status('placed', '手動配置完了（アンカー作成不可：local-space固定）。紙は追跡していません。');
      return;
    }
    Promise.resolve(result).then((created) => {
      if (disposed || placementEpoch !== epoch || !placement) {
        deleteAnchor(created);
        return;
      }
      if (!created?.anchorSpace) {
        deleteAnchor(created);
        return;
      }
      anchor = created;
      anchorKind = 'anchor';
      status('placed', '手動配置完了（WebXRアンカー）。紙を動かさず、スマホを動かして比較してください。');
    }, () => {
      if (!disposed && placementEpoch === epoch) {
        status('placed', '手動配置完了（アンカー作成不可：local-space固定）。紙は追跡していません。');
      }
    });
  }
  function onReferenceReset() {
    if (disposed) return;
    lastHit = null;
    if (anchor) {
      box.group.visible = false;
      status('limited', '世界座標が更新されました。アンカー位置の再取得を待っています。');
    } else {
      resetPlacement();
      status('searching', '世界座標がリセットされました。左右の端点を指定し直してください。');
    }
  }
  function frameLoop(timestampMs, frame) {
    if (disposed || sessionEnded || frame.session !== session) return;
    frameHandle = null;
    try {
      const cpuStartedAt = now();
      const viewerPose = frame.getViewerPose(referenceSpace);
      const hasPose = !!viewerPose?.views?.length && !viewerPose.emulatedPosition;
      const visible = session.visibilityState !== 'hidden' && session.visibilityState !== 'visible-blurred';
      if (hasPose && visible) {
        if (!placement) {
          const hit = frame.getHitTestResults(hitSource)[0];
          const pose = hit?.getPose(referenceSpace);
          if (pose && Array.from(pose.transform.matrix).every(Number.isFinite)) {
            const matrix = Array.from(pose.transform.matrix);
            let normal = [matrix[4], matrix[5], matrix[6]];
            const position = [matrix[12], matrix[13], matrix[14]];
            const eye = viewerPose.transform.position;
            if (dot(normal, [eye.x - position[0], eye.y - position[1], eye.z - position[2]]) < 0) {
              normal = normal.map((v) => -v);
            }
            lastHit = { position, normal, matrix, capturedAtMs: now() };
            reticle.matrix.fromArray(matrix);
            reticle.visible = true;
            status('point-ready', firstPoint
              ? '照準をカード長辺の右端中央へ合わせて、端点を決定してください。'
              : '照準をカード長辺の左端中央へ合わせて、端点を決定してください。', true);
          } else {
            lastHit = null;
            reticle.visible = false;
            status('searching', 'カードの周囲も映して平面を検出してください。中央に照準が出てから端点を指定します。');
          }
          firstPointVisual.visible = !!firstPoint;
        } else {
          requestPlacementAnchor(frame);
          const anchorPose = anchor ? frame.getPose(anchor.anchorSpace, referenceSpace) : null;
          const anchorValid = !anchor || !!anchorPose;
          if (anchorPose) {
            box.group.matrix.fromArray(anchorPose.transform.matrix)
              .scale(new THREE.Vector3(placement.scale, placement.scale, placement.scale));
          }
          box.group.visible = anchorValid;
          if (!anchorValid) status('limited', 'アンカー位置を取得できません。周囲を映して追跡の復帰を待ってください。');
          else status('placed', anchorKind === 'anchor'
            ? 'WebXRアンカーで表示中。紙を動かさず、スマホを動かして比較してください。'
            : 'local-space固定で表示中。紙自体は追跡していません。');
        }
      } else {
        lastHit = null;
        if (box?.group) box.group.visible = false;
        if (reticle) reticle.visible = false;
        if (firstPointVisual) firstPointVisual.visible = false;
        status('limited', 'カメラ位置の追跡を待っています。ゆっくり周囲を映してください。');
      }

      // XR owns the camera image and framebuffer. No getUserMedia, texture
      // readPixels, colour analysis, separate camera clock, or smoothing here.
      renderer.resetState();
      gl.bindFramebuffer(gl.FRAMEBUFFER, baseLayer.framebuffer);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (hasPose && visible) {
        for (const view of viewerPose.views) {
          const viewport = baseLayer.getViewport(view);
          renderer.setViewport(viewport.x, viewport.y, viewport.width, viewport.height);
          camera.matrix.fromArray(view.transform.matrix);
          camera.projectionMatrix.fromArray(view.projectionMatrix);
          camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
          camera.updateMatrixWorld(true);
          renderer.render(scene, camera);
        }
      }
      const cpuMs = now() - cpuStartedAt;
      const frameIntervalMs = lastFrameAt === null ? null : timestampMs - lastFrameAt;
      lastFrameAt = timestampMs;
      if (metricsStartedAt === null) metricsStartedAt = timestampMs;
      else {
        // Count intervals after the window origin, not its initial frame.
        metricsFrames += 1;
        if (hasPose && visible) metricsPoses += 1;
        metricsCpuMs += cpuMs;
      }
      notify(onFrame, {
        timestampMs, timeMs: timestampMs, frameIntervalMs, renderCpuMs: cpuMs,
        hasPose: hasPose && visible, placed: !!placement, anchorKind,
        scale: placement?.scale ?? null,
        physicalCardWidthM: placement?.widthM ?? null,
        cameraMatrix: hasPose ? Array.from(viewerPose.transform.matrix) : null,
        paperMatrix: placement && box.group.visible ? Array.from(box.group.matrix.elements) : null,
        poseSource: 'webxr-world', imageTracking: false,
      });
      const elapsed = timestampMs - metricsStartedAt;
      if (elapsed >= 500) {
        renderFps = metricsFrames * 1000 / elapsed;
        poseFps = metricsPoses * 1000 / elapsed;
        notify(onMetrics, {
          mode: 'webxr', renderFps, poseFps,
          meanFrameCpuMs: metricsCpuMs / metricsFrames,
          state: currentState, hasPose: hasPose && visible,
          placed: !!placement, anchorKind, manualPlacement: true, imageTracking: false,
          physicalCardWidthM: placement?.widthM ?? null,
          physicalCardHeightM: placement?.heightM ?? null,
          scale: placement?.scale ?? null,
          geometries: renderer.info.memory.geometries,
          textures: renderer.info.memory.textures,
        });
        metricsStartedAt = timestampMs;
        metricsFrames = 0;
        metricsPoses = 0;
        metricsCpuMs = 0;
      }
      if (!disposed) frameHandle = session.requestAnimationFrame(frameLoop);
    } catch (error) { fail(error); }
  }

  listen(globalThis.document, 'visibilitychange', () => {
    if (globalThis.document.hidden) void stop('background');
  });
  listen(globalThis.window, 'pagehide', () => { void stop('background'); });
  listen(signal, 'abort', () => { void stop('cancelled'); }, { once: true });
  status('starting', 'WebXR ARを開始中…（自動マーカー追跡ではなく手動配置の比較です）');
  try {
    const optionalFeatures = ['anchors'];
    const options = { requiredFeatures: ['local', 'hit-test'], optionalFeatures };
    if (overlayRoot) {
      optionalFeatures.push('dom-overlay');
      options.domOverlay = { root: overlayRoot };
    }
    // Do not await probeWebXr() here: it would lose the initiating user gesture.
    session = await navigator.xr.requestSession('immersive-ar', options);
    if (disposed || signal?.aborted) {
      await session.end().catch(() => {});
      throw new DOMException('AR start cancelled', 'AbortError');
    }
    listen(session, 'end', () => { sessionEnded = true; void stop('native-end'); });
    listen(session, 'select', () => { confirmPoint(); });
    // A click on overlay controls must not also emit an XR select event.
    listen(overlayRoot, 'beforexrselect', (event) => { event.preventDefault(); });
    listen(session, 'visibilitychange', () => {
      if (session.visibilityState === 'hidden') void stop('background');
    });
    listen(canvas, 'webglcontextlost', (event) => {
      event.preventDefault();
      fail(new Error('WebGLコンテキストを失いました。ARを終了しました。再開してください。'));
    });
    gl = canvas.getContext('webgl2', { alpha: true, antialias: false, xrCompatible: true })
      || canvas.getContext('webgl', { alpha: true, antialias: false, xrCompatible: true });
    if (!gl) throw new Error('WebXR用のWebGLを初期化できませんでした。');
    if (gl.makeXRCompatible) await gl.makeXRCompatible();
    if (disposed) throw new DOMException('AR start cancelled', 'AbortError');
    if (typeof globalThis.XRWebGLLayer !== 'function') {
      throw new Error('このブラウザにはXRWebGLLayerがありません。');
    }
    renderer = new THREE.WebGLRenderer({ canvas, context: gl, alpha: true, antialias: false });
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 0);
    baseLayer = new XRWebGLLayer(session, gl, { alpha: true, depth: true, antialias: false });
    session.updateRenderState({ baseLayer, depthNear: 0.01, depthFar: 20 });
    renderer.setSize(baseLayer.framebufferWidth, baseLayer.framebufferHeight, false);
    referenceSpace = await session.requestReferenceSpace('local');
    if (disposed) throw new DOMException('AR start cancelled', 'AbortError');
    listen(referenceSpace, 'reset', onReferenceReset);
    const viewerSpace = await session.requestReferenceSpace('viewer');
    if (disposed) throw new DOMException('AR start cancelled', 'AbortError');
    hitSource = await session.requestHitTestSource({ space: viewerSpace });
    if (disposed) {
      hitSource.cancel();
      hitSource = null;
      throw new DOMException('AR start cancelled', 'AbortError');
    }
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera();
    camera.matrixAutoUpdate = false;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x526077, 2));
    box = createBox({ cardWidthM, cardHeightM });
    if (!box?.group || typeof box.dispose !== 'function') {
      throw new Error('createBox must return {group, dispose}');
    }
    box.group.matrixAutoUpdate = false;
    box.group.visible = false;
    scene.add(box.group);
    // Hit-test pose's +Y is the surface normal. RingGeometry starts in XY.
    reticleGeometry = new THREE.RingGeometry(0.003, 0.0045, 24).rotateX(-Math.PI / 2);
    reticleMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthTest: false });
    firstPointMaterial = new THREE.MeshBasicMaterial({ color: 0xff8c4b, side: THREE.DoubleSide, depthTest: false });
    reticle = new THREE.Mesh(reticleGeometry, reticleMaterial);
    firstPointVisual = new THREE.Mesh(reticleGeometry, firstPointMaterial);
    for (const marker of [reticle, firstPointVisual]) {
      marker.matrixAutoUpdate = false;
      marker.visible = false;
      marker.renderOrder = 10;
      scene.add(marker);
    }
    status('searching', session.domOverlayState
      ? '中央の照準をカード長辺の左端中央へ合わせて「端点を決定」を押してください。'
      : '中央の照準をカード長辺の左端中央へ合わせて画面をタップ。次に右端中央を同様に指定します。');
    frameHandle = session.requestAnimationFrame(frameLoop);
    return {
      stop, resetPlacement, confirmPoint,
      getState: () => ({ state: currentState, placed: !!placement, anchorKind, renderFps, poseFps }),
      manualPlacement: true,
      imageTracking: false,
      domOverlay: !!session.domOverlayState,
    };
  } catch (error) {
    if (!disposed && error.name !== 'AbortError') status('error', supportReason(error));
    await stop('error');
    throw error;
  }
}
