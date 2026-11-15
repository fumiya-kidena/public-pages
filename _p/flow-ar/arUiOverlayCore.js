export const AR_UI_Z_INDEX = "2147483000";
export const AR_ORIENTATION_Z_INDEX = "2147483001";

function setImportant(element, property, value) {
  element?.style?.setProperty?.(property, value, "important");
}

/**
 * Keep application controls above a camera canvas that an AR engine may move
 * directly under <body>.  The operation is idempotent so it is safe to repeat
 * after every engine attach or orientation change.
 */
export function pinArUiOverlay({
  documentRef = globalThis.document,
  overlay,
  canvas,
  orientationGate
} = {}) {
  const body = documentRef?.body;
  if (!body || !overlay) return false;

  if (overlay.parentNode !== body) body.append(overlay);

  setImportant(overlay, "position", "fixed");
  setImportant(overlay, "inset", "0");
  setImportant(overlay, "z-index", AR_UI_Z_INDEX);
  setImportant(overlay, "display", "block");
  setImportant(overlay, "visibility", "visible");
  setImportant(overlay, "opacity", "1");
  setImportant(overlay, "pointer-events", "none");

  // FullWindowCanvas appends the supplied canvas to <body>.  Explicitly keep
  // it below the UI even if the engine has added inline layout declarations.
  setImportant(canvas, "position", "fixed");
  setImportant(canvas, "inset", "0");
  setImportant(canvas, "z-index", "0");
  setImportant(canvas, "pointer-events", "none");

  setImportant(orientationGate, "z-index", AR_ORIENTATION_Z_INDEX);
  return true;
}

/**
 * Re-assert the UI layer when a third-party AR runtime reparents body children.
 */
export function installArUiOverlayGuard({
  documentRef = globalThis.document,
  MutationObserverClass = globalThis.MutationObserver,
  overlay,
  canvas,
  orientationGate,
  schedule = globalThis.queueMicrotask?.bind(globalThis)
    || ((callback) => Promise.resolve().then(callback))
} = {}) {
  const enforce = () => pinArUiOverlay({
    documentRef,
    overlay,
    canvas,
    orientationGate
  });

  enforce();
  if (!documentRef?.body || typeof MutationObserverClass !== "function") {
    return { disconnect() {}, enforce };
  }

  let pending = false;
  const observer = new MutationObserverClass(() => {
    if (pending) return;
    pending = true;
    schedule(() => {
      pending = false;
      enforce();
    });
  });
  observer.observe(documentRef.body, { childList: true });
  return {
    disconnect: () => observer.disconnect(),
    enforce
  };
}
