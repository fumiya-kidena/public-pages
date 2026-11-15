import { createCardPointCamera } from "./pointCamera.js";
import { createCardPointTracking } from "../cardPointTracking.js";
import { homographyFromCardPose } from "../cardPointPose.js";
import { createTrackingLabCore } from "./trackingCore.js";

let enginePromise;
export function prepareXr8(THREE) {
  if (globalThis.XR8) return Promise.resolve(globalThis.XR8);
  if (enginePromise) return enginePromise;
  globalThis.THREE = THREE;
  enginePromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const finish = () => {
      if (!globalThis.XR8) return;
      clearTimeout(timeout); window.removeEventListener("xrloaded", finish);
      resolve(globalThis.XR8);
    };
    const timeout = setTimeout(() => {
      window.removeEventListener("xrloaded", finish);
      reject(new Error("XR8 engineの準備が時間切れです。ページを再読込してください。"));
    }, 30000);
    script.async = true;
    script.crossOrigin = "anonymous";
    script.dataset.preloadChunks = "slam";
    script.src = new URL("../vendor/8thwall/xr.js", import.meta.url).href;
    script.onerror = () => {
      clearTimeout(timeout); window.removeEventListener("xrloaded", finish);
      reject(new Error("XR8 engineを取得できません。ネットワークと配信ファイルを確認してください。"));
    };
    script.onload = finish;
    window.addEventListener("xrloaded", finish);
    document.head.append(script);
  });
  return enginePromise;
}

export async function startXr8({ THREE, canvas, layout, mode, createBox, metrics,
  onStatus = () => {}, onDiagnostic = () => {}, onError = () => {}, signal = null }) {
  const engine = await prepareXr8(THREE);
  if (signal?.aborted) throw new DOMException("AR start cancelled", "AbortError");
  let stopped = false, running = false, xrScene, worker, pending, requestId = 0;
  let stopPromise = null, moduleNames = [];
  let lastResult = null, lastAcceptedAt = -Infinity, lastGlobalAt = -Infinity;
  let worldHealthy = false, lastVideoTime = null, lastDiagnosticAt = -Infinity;
  let lastFreshCameraAt = -Infinity, lastFreshCameraPose = null;
  let legacyPose = null, legacyState = { name: "searching" };
  let box, root, cameraRoot;
  const core = mode === "current" ? null : createTrackingLabCore({ mode,
    minPoints: 8, maxRmsPixels: 2.5, maxObservationAgeMs: 300 });
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => {}); // Startup cancellation can precede XR8.run settling.
  const now = () => performance.now();
  const wanted = () => running && !stopped && !document.hidden && (!core || core.needsPaperObservation());
  const legacy = mode === "current" ? createCardPointTracking({
    THREE, layout, isEnabled: wanted, isWorldTrackingNormal: () => worldHealthy,
    maySnap: () => true,
    // Use the pilot's public layout-aware worker, including the Test Box card.
    // The generic legacy tracker does not request partial fits, so this worker
    // keeps its full/global 17-point threshold for the baseline comparison.
    workerFactory: () => new Worker(new URL("./pointWorker.js", import.meta.url), { type: "module" }),
    onPose: pose => {
      legacyPose = pose;
      metrics.mark("pose", { latencyMs: now() - pose.capturedAt, count: pose.count });
    },
    onState: state => { legacyState = state; },
  }) : null;
  let cameraReader;
  const rejectPending = () => {
    if (!pending) return;
    clearTimeout(pending.timeout); pending.resolve(); pending = null;
  };
  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true; running = false;
    readyReject?.(new Error("開始が取り消されました。"));
    rejectPending(); worker?.terminate(); worker = null;
    cameraReader?.dispose(); legacy?.dispose();
    document.removeEventListener("visibilitychange", visibilityChanged);
    canvas.removeEventListener("webglcontextlost", contextLost);
    signal?.removeEventListener("abort", abort);
    box?.dispose(); cameraRoot?.removeFromParent(); root?.removeFromParent();
    // Idempotent, bounded stop. Never start a preview/second camera while the
    // engine has not acknowledged camera release; a timeout requires reload.
    stopPromise = Promise.resolve().then(async () => {
      let timer;
      try {
        await Promise.race([Promise.resolve(engine.stop()), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("カメラ停止が時間切れです。再読込してください。")), 1500);
        })]);
        engine.removeCameraPipelineModules?.(moduleNames);
      } finally { clearTimeout(timer); }
    });
    return stopPromise;
  }
  function fail(error) {
    if (stopped) return;
    readyReject?.(error);
    void stop().then(() => onError(error), failure => onError(failure));
  }
  function abort() { void stop().catch(() => {}); }
  function reset(reason = "user-reset") {
    lastResult = null; lastAcceptedAt = -Infinity; lastGlobalAt = -Infinity;
    lastVideoTime = null; lastFreshCameraAt = -Infinity; lastFreshCameraPose = null;
    core?.reset({ reason }); legacy?.invalidate({ reset: true });
    legacyPose = null; cameraReader?.invalidate();
    rejectPending(); worker?.terminate(); worker = null;
    if (box) box.group.visible = false;
  }
  function visibilityChanged() {
    reset("visibility-changed");
    if (document.hidden) {
      try { engine.pause(); } catch { /* Resume requires user retry if engine fails. */ }
      onStatus({ state: "paused", message: "背景で停止しました。復帰後は紙面を再認識します。" });
    } else {
      try { engine.resume(); } catch { fail(new Error("カメラを再開できません。再読込してください。")); }
    }
  }
  function contextLost(event) {
    event.preventDefault(); fail(new Error("WebGL contextを失いました。通常3Dか再読込を選んでください。"));
  }
  function ensureWorker() {
    if (worker) return;
    const ownedWorker = new Worker(new URL("./pointWorker.js", import.meta.url), { type: "module" });
    const workerGeneration = core.generation;
    worker = ownedWorker;
    const ownsWorker = () => worker === ownedWorker && !stopped && running && core.generation === workerGeneration;
    const ownsRequest = request => ownsWorker() && request?.worker === ownedWorker &&
      request.generation === core.generation && request.frame.isCurrent();
    const workerError = () => {
      if (!ownsWorker()) return;
      if (pending && (!ownsRequest(pending) || now() - pending.frame.capturedAt >= 300)) {
        // An obsolete frame cannot fail the live session. Retire this broken
        // worker so a later frame can create one rather than time out on it.
        rejectPending(); ownedWorker.terminate(); worker = null;
        return;
      }
      fail(new Error("点追跡workerを起動できません。再読込してください。"));
    };
    ownedWorker.onerror = workerError;
    ownedWorker.onmessageerror = workerError;
    ownedWorker.onmessage = ({ data }) => {
      if (!ownsWorker() || !pending || data?.id !== pending.id || pending.worker !== ownedWorker) return;
      const request = pending; pending = null; clearTimeout(request.timeout);
      try {
        const latencyMs = now() - request.frame.capturedAt;
        if (!ownsRequest(request) || latencyMs >= 300) {
          if (ownsRequest(request)) metrics.mark("discarded", { latencyMs });
          return;
        }
        // Generation/frame guards precede even an error packet. A reset or
        // crop change must not let an old failure tear down the new runtime.
        if (data.error) { fail(new Error("点計測に失敗しました。再読込してください。")); return; }
        if (!data.result || typeof data.result.reason !== "string") {
          fail(new Error("点計測workerの応答を読めませんでした。再読込してください。")); return;
        }
        metrics.mark("processed", { latencyMs, workerMs: data.processingMs,
          count: data.result.count, rmsPixels: data.result.rmsPixels });
        // Adaptive cadence, not a promised rate. One worker request at a time.
        cameraReader.setIntervalMs(data.result.reason !== "measured" ? 180 :
          Math.max(33, Math.min(300, (data.processingMs + request.frame.readbackMs) * 1.25)));
        lastResult = data.result;
        if (data.result.reason !== "measured") return;
        const accepted = core.observe({ ...request.frame, generation: request.generation,
          worldTrackingNormal: request.worldHealthy, pose: data.result.pose,
          quality: { valid: true, count: data.result.count, rmsPixels: data.result.rmsPixels } });
        if (accepted.accepted) {
          lastAcceptedAt = request.frame.capturedAt;
          metrics.mark("pose", { latencyMs, count: data.result.count,
            cellPixels: data.result.cellPixels });
        }
      } finally { request.resolve(); }
    };
  }
  function processFrame(frame) {
    metrics.mark("capture", { readbackMs: frame.readbackMs, width: frame.width, height: frame.height });
    if (legacy) return legacy.processFrame(frame);
    ensureWorker();
    const generation = core.generation;
    const current = core.sample();
    const trusted = current.observationFresh && frame.capturedAt - lastAcceptedAt < 300;
    const seedHomography = trusted && current.cameraPose
      ? homographyFromCardPose(current.cameraPose.position, current.cameraPose.quaternion,
        frame.projectionMatrix, frame) : null;
    const allowGlobal = !trusted && frame.capturedAt - lastGlobalAt >= 500;
    if (allowGlobal) lastGlobalAt = frame.capturedAt;
    return new Promise(resolve => {
      const id = ++requestId;
      pending = { id, generation, frame, resolve, worldHealthy, worker,
        timeout: setTimeout(() => fail(new Error("点計測が時間切れです。再読込してください。")), 3500) };
      try {
        worker.postMessage({ id, caseId: layout.caseId, data: frame.data,
          width: frame.width, height: frame.height, projectionMatrix: frame.projectionMatrix,
          seedHomography, allowPartial: trusted, allowGlobal }, [frame.data.buffer]);
      } catch { fail(new Error("workerへ画像を渡せませんでした。")); }
    });
  }
  cameraReader = createCardPointCamera({ onFrame: processFrame,
    onError: () => fail(new Error("カメラ画像の計測用読み出しに失敗しました。")),
    isEnabled: wanted, maxDimension: mode === "current" ? 640 : 960,
    intervalMs: mode === "current" ? 125 : 50 });
  function place(snapshot) {
    if (!box) return;
    box.group.visible = Boolean(snapshot?.visible);
    if (!snapshot?.visible) return;
    const parent = snapshot.poseSpace === "camera" ? cameraRoot : root;
    if (box.group.parent !== parent) parent.add(box.group);
    const pose = snapshot.pose;
    box.group.position.set(pose.position.x, pose.position.y, pose.position.z);
    box.group.quaternion.set(pose.quaternion.x, pose.quaternion.y, pose.quaternion.z, pose.quaternion.w);
    box.group.scale.setScalar(pose.scale);
  }
  const module = {
    name: "flowartrackinglab",
    onStart() {
      if (stopped) {
        // Some engine versions may throw synchronously as well as reject.
        void Promise.resolve().then(() => engine.stop()).catch(() => {});
        return;
      }
      xrScene = engine.Threejs.xrScene();
      root = new THREE.Group(); cameraRoot = new THREE.Group();
      xrScene.scene.add(root);
      xrScene.scene.add(xrScene.camera); xrScene.camera.add(cameraRoot);
      box = createBox(); box.group.visible = false; root.add(box.group);
      // Let XR8 own camera canvas/viewport/DPR. Do not resize its renderer.
      xrScene.camera.position.set(0, 0, 0); xrScene.camera.quaternion.identity();
      engine.XrController.updateCameraProjectionMatrix({ origin: xrScene.camera.position,
        facing: xrScene.camera.quaternion });
      running = true;
      onStatus({ state: "searching", message: "箱は準備済み。左右の点が入るようカードを映してください。" });
      readyResolve();
    },
    onUpdate({ frameStartResult, processCpuResult } = {}) {
      if (!running || stopped || document.hidden) return;
      const time = now(), reality = processCpuResult?.reality;
      if (frameStartResult && !frameStartResult.repeatFrame &&
          Number.isFinite(frameStartResult.videoTime) && frameStartResult.videoTime !== lastVideoTime) {
        lastVideoTime = frameStartResult.videoTime; lastFreshCameraAt = time;
        lastFreshCameraPose = reality?.position && reality?.rotation ? {
          cameraPosition: { x: reality.position.x, y: reality.position.y, z: reality.position.z },
          cameraQuaternion: { x: reality.rotation.x, y: reality.rotation.y, z: reality.rotation.z, w: reality.rotation.w },
        } : null;
        metrics.mark("camera", {}, time);
      }
      // Renderer callbacks are not fresh camera samples. Repeated/stalled
      // video retains its original pose/timestamp so the core's 250 ms camera
      // freshness limit can hide a predicted box instead of holding forever.
      if (core && lastFreshCameraPose) core.updateCamera({ generation: core.generation,
        capturedAt: lastFreshCameraAt, ...lastFreshCameraPose,
        worldTrackingNormal: worldHealthy });
      legacy?.tick(time);
      const cameraFresh = time - lastFreshCameraAt < 250;
      const snapshot = legacy ? { visible: Boolean(legacyPose) && cameraFresh, poseSpace: "world", pose: legacyPose,
        status: legacyState.name, observationAgeMs: legacyPose ? time - legacyPose.capturedAt : null,
        calibration: { calibrated: !!legacyPose?.scaleCalibrated, scale: legacyPose?.scale },
        worldTrackingNormal: worldHealthy, quality: legacyPose && { count: legacyPose.count,
          rmsPixels: legacyPose.rmsPixels } } : core.sample(time);
      place(snapshot);
      if (time - lastDiagnosticAt > 200) {
        lastDiagnosticAt = time; onDiagnostic({ ...snapshot, result: lastResult });
      }
    },
    onRender() { if (running && !stopped && !document.hidden) metrics.mark("render"); },
    onDeviceOrientationChange() { reset("orientation-changed"); },
    onCanvasSizeChange() { reset("viewport-changed"); },
    onCameraStatusChange({ status }) {
      if (status === "failed") fail(new Error("カメラを開始できません。権限と他のカメラ利用を確認してください。"));
    },
    onException() { fail(new Error("XR8 runtimeでエラーが発生しました。再読込してください。")); },
    listeners: [{ event: "reality.trackingstatus", process({ detail }) {
      const healthy = detail?.status === "NORMAL";
      if (legacy && healthy !== worldHealthy) legacy.invalidate();
      worldHealthy = healthy;
    } }],
  };
  let startupTimer;
  try {
    // Include synchronous configure/module/registration failures in the same
    // terminal cleanup path as run/permission/timeouts. Configure before the
    // XrController pipeline module is created, not only before run.
    engine.XrController.configure({ disableWorldTracking: false, scale: "responsive", imageTargetData: [] });
    const modules = [engine.GlTextureRenderer.pipelineModule(), engine.Threejs.pipelineModule(),
      engine.XrController.pipelineModule(), module, cameraReader.pipelineModule()];
    const fullWindow = engine.FullWindowCanvas?.pipelineModule?.();
    if (fullWindow) modules.unshift(fullWindow);
    moduleNames = modules.map(item => item.name);
    // No image targets, private catalog, model files or second camera stream.
    engine.addCameraPipelineModules(modules);
    document.addEventListener("visibilitychange", visibilityChanged);
    canvas.addEventListener("webglcontextlost", contextLost);
    signal?.addEventListener("abort", abort, { once: true });
    await Promise.race([
      Promise.all([ready, Promise.resolve(engine.run({ canvas }))]),
      new Promise((_, reject) => { startupTimer = setTimeout(() =>
        reject(new Error("カメラ開始が時間切れです。権限を確認して再読込してください。")), 20000); }),
    ]);
  } catch (error) { await stop(); throw error; }
  finally { clearTimeout(startupTimer); }
  return { stop, reset, mode };
}
