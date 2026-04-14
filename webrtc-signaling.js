// Shared WebRTC signaling helpers (static-host friendly).
// Encodes/decodes SDP blobs for QR/text transfer.

export function createPeerConnection() {
  return new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
}

export async function waitForIceGatheringComplete(pc, { timeoutMs = 2000 } = {}) {
  if (pc.iceGatheringState === "complete") return;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pc.removeEventListener("icegatheringstatechange", onState);
      clearTimeout(timer);
      resolve();
    };
    const onState = () => {
      if (pc.iceGatheringState === "complete") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener("icegatheringstatechange", onState);
  });
}

/**
 * Encode a signaling object (e.g. RTCSessionDescriptionInit) into base64url text.
 * @param {any} obj
 */
export function encodeSignal(obj) {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  return base64UrlEncode(bytes);
}

/**
 * Decode base64url text into a signaling object.
 * @param {string} text
 */
export function decodeSignal(text) {
  const bytes = base64UrlDecode(String(text || "").trim());
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json);
}

/**
 * @param {Uint8Array} bytes
 */
function base64UrlEncode(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * @param {string} b64url
 */
function base64UrlDecode(b64url) {
  let s = String(b64url || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

