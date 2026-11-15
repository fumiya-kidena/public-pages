import * as THREE from "three";
import { getCardPointLayout } from "./layout.js";
import { boxSpecification, createBox } from "./box.js";
import { createLabMetrics } from "./metrics.js";
import { prepareXr8, startXr8 } from "./xr8Adapter.js";
import { probeWebXr, startWebXr } from "./webXrAdapter.js";

const $ = id => document.getElementById(id);
const ui = Object.fromEntries(["camera", "overlay", "mode", "layout", "intro", "mode-note",
  "start", "preview", "status", "summary", "error", "confirm", "reset", "reload", "report",
  "details-toggle", "details"].map(id => [id, $(id)]));
const parameters = new URL(location.href).searchParams;
const modes = ["current", "paper", "hybrid", "slam", "webxr"];
const mode = modes.includes(parameters.get("mode")) ? parameters.get("mode") : "hybrid";
const caseId = getCardPointLayout(parameters.get("card")) ? parameters.get("card") : "testBox";
ui.mode.value = mode; ui.layout.value = caseId;
const notes = {
  hybrid: "色点の実測を基準にし、並進で縮尺を校正できた間だけSLAMで補います。校正前は紙面表示のみ。",
  paper: "SLAMの座標を表示に使わない比較です。計測間の予測と画角外の継続はしません。XR8のカメラ処理は共通です。",
  slam: "色点で縮尺を校正して初期配置した後、色点計測を止めます。カードは動かさずに試してください。",
  current: "現行の点追跡・補正コードを箱で試します。画像ターゲットの縮尺ヒントは使わないため、本番全体の完全再現ではありません。",
  webxr: "対応Android ChromeのARCore比較です。カード長辺の両端を中央レティクルで手動指定します。自動マーカー追跡ではありません。",
};
ui["mode-note"].textContent = notes[mode];
const metrics = createLabMetrics();
let runtime, phase = "preparing", serial = 0, diagnostic = {}, webMetrics = {}, latestStatus = "";
let startController = null;
const number = (value, unit = "", digits = 1) => Number.isFinite(value) ? `${value.toFixed(digits)}${unit}` : "—";
function status(message) { latestStatus = message; ui.status.textContent = message; }
function error(error) {
  phase = "error"; serial++;
  ui.error.textContent = error?.message || "起動できませんでした。";
  ui.error.hidden = false; ui.intro.hidden = false;
  ui.start.disabled = true; ui.start.textContent = "起動失敗";
  ui.reload.hidden = false; ui.reset.disabled = true; ui.confirm.hidden = true;
  status(ui.error.textContent);
}
function reloadChoice() {
  const url = new URL(location.href);
  url.search = new URLSearchParams({ mode: ui.mode.value, card: ui.layout.value });
  url.hash = ""; // Never carry a private QR's unlock fragment into diagnostic URLs.
  location.replace(url.href);
}
ui.mode.addEventListener("change", reloadChoice);
ui.layout.addEventListener("change", reloadChoice);
ui.reload.addEventListener("click", () => location.reload());
ui.reset.addEventListener("click", () => {
  runtime?.reset?.(); runtime?.resetPlacement?.(); metrics.reset();
  diagnostic = {}; webMetrics = {}; status("再認識します。カードを固定して映してください。");
});
ui.confirm.addEventListener("click", () => runtime?.confirmPoint?.());
ui["details-toggle"].addEventListener("click", () => {
  ui.details.hidden = !ui.details.hidden;
  ui["details-toggle"].setAttribute("aria-expanded", String(!ui.details.hidden));
});
ui.report.addEventListener("click", () => {
  const report = metrics.report({ revision: "box-pilot-1", mode, cardLayout: caseId,
    box: boxSpecification, phase, webxr: mode === "webxr" ? {
      manualPlacement: true, imageTracking: false, anchorKind: webMetrics.anchorKind,
      physicalCardWidthM: webMetrics.physicalCardWidthM,
    } : undefined });
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = `flowArBox-${mode}.json`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
async function preview() {
  if (phase === "starting") return; // Do not create a second context during camera startup.
  const generation = ++serial;
  phase = "stopping"; ui.start.disabled = true;
  await runtime?.stop?.();
  if (serial !== generation) return;
  phase = "preview"; ui.intro.hidden = true; ui.error.hidden = true; ui.confirm.hidden = true;
  ui.reload.hidden = false; ui.reset.disabled = true;
  const renderer = new THREE.WebGLRenderer({ canvas: ui.camera, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x071019);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.001, 10);
  camera.position.set(0.085, 0.080, 0.16); camera.lookAt(0, 0, 0);
  const box = createBox(THREE); scene.add(box.group);
  let frame, stopped = false;
  const draw = () => {
    if (stopped || serial !== generation) return;
    const width = innerWidth, height = innerHeight;
    if (ui.camera.width !== Math.round(width * renderer.getPixelRatio()) ||
        ui.camera.height !== Math.round(height * renderer.getPixelRatio())) {
      renderer.setSize(width, height, false); camera.aspect = width / height;
      // Keep the whole paper frame visible in portrait preview. This is only
      // the no-camera viewer; it must not rescale the AR tracking result.
      const fit = Math.max(1, 0.85 / camera.aspect);
      camera.position.set(0.085 * fit, 0.080 * fit, 0.16 * fit);
      camera.lookAt(0, 0, 0); camera.updateProjectionMatrix();
    }
    renderer.render(scene, camera); metrics.mark("render"); frame = requestAnimationFrame(draw);
  };
  metrics.reset(); draw();
  runtime = { stop() { stopped = true; cancelAnimationFrame(frame); box.dispose(); renderer.dispose(); } };
  status("カメラなしの箱プレビューです。ARの追従性は評価できません。再読込でARへ戻れます。");
}
ui.preview.addEventListener("click", () => preview().catch(error));
ui.start.addEventListener("click", async () => {
  if (phase !== "ready") return;
  const generation = ++serial; phase = "starting";
  startController = new AbortController();
  ui.preview.disabled = true;
  ui.start.disabled = true; ui.start.textContent = "カメラ開始中…"; ui.error.hidden = true;
  metrics.reset(); status("カメラを開始しています。権限の確認が出たら許可してください。");
  const onStatus = value => {
    if (serial !== generation) return;
    status(value.message || value.state);
    if (mode === "webxr") {
      ui.confirm.hidden = !value.canConfirm;
      ui.confirm.textContent = value.placementStage === 1
        ? "中央を長辺の右端に合わせて確定" : "中央を長辺の左端に合わせて確定";
      if (value.state === "ended") {
        phase = "ended"; ui.reload.hidden = false; ui.reset.disabled = true;
        ui.confirm.hidden = true;
      }
    }
  };
  try {
    const candidate = mode === "webxr" ? await startWebXr({ THREE, canvas: ui.camera,
      overlayRoot: ui.overlay, createBox: () => createBox(THREE), onStatus, signal: startController.signal,
      onMetrics: value => { if (serial === generation) webMetrics = value; },
      onFrame: value => { if (serial !== generation) return;
        metrics.mark("render"); if (value.hasPose) metrics.mark("camera");
        metrics.mark("webxr", { frameCpuMs: value.renderCpuMs }); },
      onError: value => { if (serial === generation) error(value); },
    }) : await startXr8({ THREE, canvas: ui.camera, layout: getCardPointLayout(caseId), mode,
      createBox: () => createBox(THREE), metrics, onStatus, signal: startController.signal,
      onDiagnostic: value => { if (serial === generation) diagnostic = value; },
      onError: value => { if (serial === generation) error(value); },
    });
    if (serial !== generation) { await candidate.stop(); return; }
    runtime = candidate; phase = "running"; ui.intro.hidden = true;
    ui.reset.disabled = false;
  } catch (failure) { if (serial === generation) error(failure); }
  finally { ui.preview.disabled = false; }
});
const stateText = {
  searching: "左右の色点を探索中", "paper-measured": "色点のみ：紙面を計測中",
  "paper-unscaled": "紙面を計測中。カードは固定したまま、スマホを左右に数cm動かして校正してください。",
  "paper-limited": "紙面表示のみ。SLAMはまだ利用できません。",
  "marker-corrected": "色点基準＋SLAM予測", "world-predicted": "紙面未計測：SLAMで継続中",
  "engine-only": "SLAM単独：色点計測を止めました", calibrating: "縮尺の校正待ち",
  "engine-limited": "周囲追跡が不確かです。紙面を映してください。",
  "paper-lost": "色点を見失いました。紙面を映してください。",
};
const displayTimer = setInterval(() => {
  const measured = metrics.snapshot();
  const fps = mode === "webxr" ? webMetrics.renderFps : measured.renderFps;
  ui.summary.textContent = phase === "preview" ? `箱プレビュー 描画 ${number(measured.renderFps)} fps · AR計測なし` :
    `描画 ${number(fps)} fps · 点 ${number(measured.poseHz)} Hz · 遅延p95 ${number(measured.latencyP95Ms, " ms", 0)}`;
  if (phase === "running" && mode !== "webxr") {
    const pixels = diagnostic.result?.cellPixels;
    const message = stateText[diagnostic.status] || `現行比較：${diagnostic.status || "探索中"}`;
    const warning = diagnostic.result?.reason === "pose-resolution-limited"
      ? " · 点が小さいため姿勢を採用しません。少し近づいてください" : "";
    status(message + warning);
  }
  if (!ui.details.hidden) ui.details.textContent = JSON.stringify({ phase, mode,
    cameraFps: measured.cameraFps, renderFps: fps, captureHz: measured.captureHz,
    measuredPoseHz: measured.poseHz, readbackP95Ms: measured.readbackP95Ms,
    workerP95Ms: measured.workerP95Ms, latencyP95Ms: measured.latencyP95Ms,
    pointCount: diagnostic.quality?.count, reprojectionRmsPx: diagnostic.quality?.rmsPixels,
    minCellEdgePx: diagnostic.result?.cellPixels, bridge: diagnostic.calibration,
    observationAgeMs: diagnostic.observationAgeMs, detectorReason: diagnostic.result?.reason,
    diagnostic: diagnostic.diagnostic, webxr: webMetrics, status: latestStatus,
  }, null, 2);
}, 250);
window.addEventListener("pagehide", () => {
  serial++; startController?.abort(); clearInterval(displayTimer);
  Promise.resolve(runtime?.stop?.()).catch(() => {});
});
window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });

async function prepare() {
  if (!isSecureContext) throw new Error("カメラARはHTTPSが必要です。PCのlocalhost、またはHTTPSのテストURLで開いてください。");
  if (mode === "webxr") {
    const capability = await probeWebXr();
    if (!capability.supported) throw new Error(capability.reason || "この端末ではWebXR ARを利用できません。");
  } else await prepareXr8(THREE);
  if (phase !== "preparing") return;
  phase = "ready"; ui.start.disabled = false; ui.start.textContent = "箱でARを開始";
  status("準備済み。印刷カードの種類を選んで、ARを開始してください。");
}
if (parameters.get("preview") === "1") preview().catch(error);
else prepare().catch(failure => { if (phase === "preparing") error(failure); });
