// Shared WebRTC signaling helpers — no external libraries.
// Uses native CompressionStream (Safari 17+) with raw base64url fallback.

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
    const onState = () => { if (pc.iceGatheringState === "complete") finish(); };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener("icegatheringstatechange", onState);
  });
}

/**
 * Encode a signaling object to a compressed base64url string.
 * Compression via native DeflateRaw (Safari 17+); plain base64url fallback.
 * @param {any} obj
 * @returns {Promise<string>}
 */
export async function encodeSignal(obj) {
  const input = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream !== "undefined") {
    try {
      const cs = new CompressionStream("deflate-raw");
      const writer = cs.writable.getWriter();
      writer.write(input);
      writer.close();
      const buf = await new Response(cs.readable).arrayBuffer();
      return _b64uEncode(new Uint8Array(buf));
    } catch { /* fall through to uncompressed */ }
  }
  return _b64uEncode(input);
}

/**
 * Decode a base64url string back to a signaling object.
 * Tries DeflateRaw decompression; falls back to raw UTF-8 decode.
 * @param {string} text
 * @returns {Promise<any>}
 */
export async function decodeSignal(text) {
  const bytes = _b64uDecode(String(text || "").trim());
  if (typeof DecompressionStream !== "undefined") {
    try {
      const ds = new DecompressionStream("deflate-raw");
      const writer = ds.writable.getWriter();
      writer.write(bytes);
      writer.close();
      const buf = await new Response(ds.readable).arrayBuffer();
      return JSON.parse(new TextDecoder().decode(buf));
    } catch { /* fall through to raw */ }
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function _b64uEncode(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function _b64uDecode(b64url) {
  let s = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
