const userAgent = navigator.userAgent || "";
const maxTouchPoints = Number(navigator.maxTouchPoints || 0);
const coarsePointer = window.matchMedia?.("(any-pointer: coarse)").matches ?? maxTouchPoints > 0;
const screenWidth = Number(window.screen?.width || window.innerWidth || 0);
const screenHeight = Number(window.screen?.height || window.innerHeight || 0);
const shortScreenSide = Math.min(screenWidth, screenHeight);

const isAndroid = /Android/i.test(userAgent);
const isAppleTablet = /iPad/i.test(userAgent)
  || (navigator.platform === "MacIntel" && maxTouchPoints > 1);
const userAgentDataMobile = typeof navigator.userAgentData?.mobile === "boolean"
  ? navigator.userAgentData.mobile
  : null;
const isAndroidPhone = isAndroid
  && (userAgentDataMobile === true || /Mobile/i.test(userAgent) || shortScreenSide < 600);
const isLargeTouchDevice = maxTouchPoints > 1
  && coarsePointer
  && shortScreenSide >= 600;
const isTablet = isAppleTablet
  || (isAndroid && !isAndroidPhone && shortScreenSide >= 600)
  || (!/iPhone|iPod/i.test(userAgent) && isLargeTouchDevice);

export const deviceProfile = Object.freeze({
  isAndroid,
  isAppleTablet,
  isPhone: !isTablet && (isAndroidPhone || /iPhone|iPod/i.test(userAgent)),
  isTablet
});

export function applyDeviceDataset() {
  const root = document.documentElement;
  root.dataset.platform = isAndroid ? "android" : isAppleTablet ? "apple" : "other";
  root.dataset.formFactor = isTablet ? "tablet" : deviceProfile.isPhone ? "phone" : "other";
}

export function isTabletPortrait() {
  return isTablet && window.matchMedia("(orientation: portrait)").matches;
}

export async function requestTabletLandscapeMode() {
  if (!isTablet || isTabletPortrait()) {
    return { fullscreen: Boolean(document.fullscreenElement), locked: false };
  }

  let fullscreen = Boolean(document.fullscreenElement);
  let locked = false;

  try {
    if (!fullscreen && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen({ navigationUI: "hide" });
      fullscreen = true;
    }
  } catch {
    // Fullscreen is optional. The visible orientation gate remains the source of truth.
  }

  try {
    if (window.screen?.orientation?.lock) {
      await window.screen.orientation.lock("landscape");
      locked = true;
    }
  } catch {
    // iPadOS and some Android browsers reject orientation lock; continue in landscape.
  }

  return { fullscreen, locked };
}

export function setupTabletLandscapeGate(gate, onChange = () => {}) {
  applyDeviceDataset();
  let blocked = false;

  const sync = () => {
    const next = isTabletPortrait();
    gate.hidden = !next;
    gate.setAttribute("aria-hidden", String(!next));
    document.documentElement.dataset.orientationBlocked = String(next);
    if (next === blocked) return;
    const previous = blocked;
    blocked = next;
    onChange(next, previous);
  };

  const orientationQuery = window.matchMedia("(orientation: portrait)");
  orientationQuery.addEventListener?.("change", sync);
  window.screen?.orientation?.addEventListener?.("change", sync);
  window.addEventListener("resize", sync, { passive: true });
  sync();

  return {
    isBlocked: () => blocked,
    sync
  };
}
