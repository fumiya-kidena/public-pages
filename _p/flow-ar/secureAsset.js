const packageElement = document.getElementById("flow-ar-asset-package");
const packageDefinition = packageElement
  ? JSON.parse(packageElement.textContent)
  : null;

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const objectUrlCache = new Map();
const jsonCache = new Map();
const pendingDecrypt = new Map();
let contentKeyPromise;

function base64UrlBytes(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function hex(bytes) {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function logicalPath(input) {
  const url = new URL(input, document.baseURI);
  const root = new URL("./", document.baseURI);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) return null;
  return decodeURIComponent(url.pathname.slice(root.pathname.length)).replace(/^\/+/, "");
}

function encryptedPayloadUrl(entry, logicalAssetPath) {
  const url = new URL(entry?.url, document.baseURI);
  const assetPackRoot = new URL("./assetPack/", document.baseURI);
  const relative = url.pathname.startsWith(assetPackRoot.pathname)
    ? url.pathname.slice(assetPackRoot.pathname.length)
    : "";
  if (
    url.origin !== assetPackRoot.origin
    || url.username
    || url.password
    || url.search
    || url.hash
    || !/^[0-9a-f]{32}\.enc$/i.test(relative)
  ) {
    throw new Error(`暗号assetの配信pathが不正です: ${logicalAssetPath}`);
  }
  return url;
}

function encryptedEntry(input) {
  const path = logicalPath(input);
  if (!path) {
    if (packageDefinition) {
      throw new Error("暗号化pageからdeployment root外のassetは読み込めません。");
    }
    return null;
  }
  const entry = packageDefinition?.assets?.[path];
  if (!entry && packageDefinition) {
    throw new Error(`暗号packageにassetがありません: ${path}`);
  }
  return entry ? { entry, path, encryptedUrl: encryptedPayloadUrl(entry, path) } : null;
}

function contentKey() {
  if (!packageDefinition) return null;
  if (packageDefinition.schemaVersion !== 1 || packageDefinition.algorithm !== "AES-GCM") {
    throw new Error("未対応のFLOW AR暗号packageです。");
  }
  if (!window.isSecureContext || !crypto.subtle) {
    throw new Error("暗号assetの復号にはHTTPSまたはlocalhostが必要です。");
  }
  contentKeyPromise ||= crypto.subtle.importKey(
    "raw",
    base64UrlBytes(packageDefinition.contentKey),
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  return contentKeyPromise;
}

async function decryptAsset(input) {
  const resolved = encryptedEntry(input);
  if (!resolved) {
    const response = await fetch(new URL(input, document.baseURI), { cache: "no-cache" });
    if (!response.ok) throw new Error(`Asset HTTP ${response.status}`);
    return response.arrayBuffer();
  }

  if (pendingDecrypt.has(resolved.path)) return pendingDecrypt.get(resolved.path);
  const work = (async () => {
    const encryptedUrl = new URL(resolved.encryptedUrl);
    if (packageDefinition.assetVersion) {
      encryptedUrl.searchParams.set("v", packageDefinition.assetVersion);
    }
    const response = await fetch(encryptedUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Encrypted asset HTTP ${response.status}: ${resolved.path}`);
    const envelope = new Uint8Array(await response.arrayBuffer());
    if (
      envelope.length < 32
      || decoder.decode(envelope.subarray(0, 4)) !== "FAR1"
    ) {
      throw new Error(`暗号asset headerが不正です: ${resolved.path}`);
    }
    // Keep views onto the fetched envelope. Large animated GLBs otherwise
    // allocate two avoidable copies before WebCrypto starts decrypting.
    const iv = envelope.subarray(4, 16);
    const ciphertext = envelope.subarray(16);
    let plaintext;
    try {
      plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: encoder.encode(`flow-ar-asset-v1\n${resolved.path}`),
          tagLength: 128
        },
        await contentKey(),
        ciphertext
      );
    } catch {
      throw new Error(`暗号assetを復号できません: ${resolved.path}`);
    }
    if (resolved.entry.sha256) {
      const digest = hex(await crypto.subtle.digest("SHA-256", plaintext));
      if (digest !== resolved.entry.sha256) {
        throw new Error(`暗号assetの検証に失敗しました: ${resolved.path}`);
      }
    }
    return plaintext;
  })();
  pendingDecrypt.set(resolved.path, work);
  try {
    return await work;
  } finally {
    pendingDecrypt.delete(resolved.path);
  }
}

export function usesEncryptedAssets() {
  return Boolean(packageDefinition);
}

export async function assetArrayBuffer(input) {
  return decryptAsset(input);
}

export async function fetchAssetJson(input) {
  const path = logicalPath(input) || new URL(input, document.baseURI).href;
  if (!packageDefinition) {
    const response = await fetch(new URL(input, document.baseURI), { cache: "no-cache" });
    if (!response.ok) throw new Error(`JSON HTTP ${response.status}: ${path}`);
    return response.json();
  }
  if (!jsonCache.has(path)) {
    const promise = decryptAsset(input)
      .then((buffer) => JSON.parse(decoder.decode(buffer)))
      .catch((error) => {
        jsonCache.delete(path);
        throw error;
      });
    jsonCache.set(path, promise);
  }
  return jsonCache.get(path);
}

export async function assetObjectUrl(input, fallbackMime = "application/octet-stream") {
  if (!packageDefinition) return new URL(input, document.baseURI).href;
  const resolved = encryptedEntry(input);
  if (!resolved) return new URL(input, document.baseURI).href;
  if (!objectUrlCache.has(resolved.path)) {
    const promise = decryptAsset(input)
      .then((buffer) => URL.createObjectURL(new Blob(
        [buffer],
        { type: resolved.entry.mime || fallbackMime }
      )))
      .catch((error) => {
        objectUrlCache.delete(resolved.path);
        throw error;
      });
    objectUrlCache.set(resolved.path, promise);
  }
  return objectUrlCache.get(resolved.path);
}

export function carryUnlockFragment(url) {
  const target = url instanceof URL ? url : new URL(url, document.baseURI);
  if (window.location.hash.includes("staticrypt_pwd=")) {
    if (packageDefinition && !logicalPath(target)) {
      throw new Error("unlock fragmentをdeployment root外へ転送できません。");
    }
    target.hash = window.location.hash;
  }
  return target;
}

window.addEventListener("pagehide", async (event) => {
  if (event.persisted) return;
  for (const promise of objectUrlCache.values()) {
    try { URL.revokeObjectURL(await promise); } catch {}
  }
  objectUrlCache.clear();
});
