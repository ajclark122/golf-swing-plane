import { createPeerConnection, decodeSignal, encodeSignal, waitForIceGatheringComplete } from "./webrtc-signaling.js";
import {
  displayColor,
  displayGlyph,
  displayPhrase,
  displayScale,
  glyphIsTriangle,
} from "./plane-display.js";
import { playSwingPing, primeSwingPingAudio } from "./swing-ping.js";

// ── DOM refs ───────────────────────────────────────────────────────────────────

const el = {
  status:    /** @type {HTMLDivElement}    */ (document.getElementById("monitorStatus")),
  liveIcon:  /** @type {HTMLDivElement}    */ (document.getElementById("liveIcon")),
  liveMeta:  /** @type {HTMLDivElement}    */ (document.getElementById("liveMeta")),
  backIcon:  /** @type {HTMLDivElement}    */ (document.getElementById("backIcon")),
  backMeta:  /** @type {HTMLDivElement}    */ (document.getElementById("backMeta")),
  downIcon:  /** @type {HTMLDivElement}    */ (document.getElementById("downIcon")),
  downMeta:  /** @type {HTMLDivElement}    */ (document.getElementById("downMeta")),

  pairIdle:      /** @type {HTMLDivElement}      */ (document.getElementById("pairIdle")),
  pairAnswer:    /** @type {HTMLDivElement}      */ (document.getElementById("pairAnswer")),
  answerHint:    /** @type {HTMLDivElement}      */ (document.getElementById("answerHint")),
  panePaste:     /** @type {HTMLDivElement}      */ (document.getElementById("panePaste")),
  offerText:     /** @type {HTMLTextAreaElement} */ (document.getElementById("offerText")),
  btnPasteOffer: /** @type {HTMLButtonElement}   */ (document.getElementById("btnPasteOffer")),
  btnUseOffer:   /** @type {HTMLButtonElement}   */ (document.getElementById("btnUseOffer")),
  btnCopyAnswer: /** @type {HTMLButtonElement}   */ (document.getElementById("btnCopyAnswer")),
};

// ── State ──────────────────────────────────────────────────────────────────────

/** @type {RTCPeerConnection|null} */
let pc = null;
/** @type {RTCDataChannel|null} */
let dc = null;

/** Encoded answer string, stored so Share and Copy both use the same value. */
let answerEncoded = "";

/** Screen Wake Lock while receiving swing data (iPad Safari 16.4+). */
/** @type {WakeLockSentinel|null} */
let screenWakeLock = null;

async function acquireScreenWakeLock() {
  const wl = navigator.wakeLock;
  if (!wl?.request) return;
  try {
    if (screenWakeLock) return;
    screenWakeLock = await wl.request("screen");
    screenWakeLock.addEventListener("release", () => {
      screenWakeLock = null;
    });
  } catch {
    /* NotAllowedError (no user gesture / background tab), or unsupported */
  }
}

function releaseScreenWakeLock() {
  try {
    screenWakeLock?.release();
  } catch { /* ignore */ }
  screenWakeLock = null;
}

// ── Status / tile helpers ──────────────────────────────────────────────────────

function setStatus(msg) { el.status.textContent = msg; }

function phaseToLabel(phase) {
  const m = { address: "Address", backswing: "Backswing", top: "Top", downswing: "Downswing", impact: "Impact" };
  return m[phase] || String(phase || "—");
}

/** @param {HTMLDivElement} tileBig */
function setTileGlyph(tileBig, char) {
  const g = tileBig.querySelector(".monitorTileGlyph");
  if (g) g.textContent = char;
  else tileBig.textContent = char;
}

function applyLiveUpdate(msg) {
  const plane = msg?.plane ?? null;
  const level = (msg?.level === 0 || msg?.level === 1 || msg?.level === 2 || msg?.level === 3) ? msg.level : null;
  styleIcon(el.liveIcon, plane, level);
  setTileGlyph(el.liveIcon, displayGlyph(plane, level));
  const phrase = level !== null && level !== undefined
    ? displayPhrase(plane, level)
    : "No reading";
  el.liveMeta.textContent = `${phaseToLabel(msg?.phase)} · ${phrase}`;
}

function applySummary(msg) {
  const backPlane = msg?.backswingDominant ?? null;
  const backLevel = (msg?.backswingLevel === 0 || msg?.backswingLevel === 1 || msg?.backswingLevel === 2 || msg?.backswingLevel === 3) ? msg.backswingLevel : null;
  styleIcon(el.backIcon, backPlane, backLevel);
  setTileGlyph(el.backIcon, displayGlyph(backPlane, backLevel));
  el.backMeta.textContent = backLevel !== null && backLevel !== undefined
    ? displayPhrase(backPlane, backLevel)
    : "No reading";

  const downPlane = msg?.downswingDominant ?? null;
  const downLevel = (msg?.downswingLevel === 0 || msg?.downswingLevel === 1 || msg?.downswingLevel === 2 || msg?.downswingLevel === 3) ? msg.downswingLevel : null;
  styleIcon(el.downIcon, downPlane, downLevel);
  setTileGlyph(el.downIcon, displayGlyph(downPlane, downLevel));
  el.downMeta.textContent = downLevel !== null && downLevel !== undefined
    ? displayPhrase(downPlane, downLevel)
    : "No reading";

  playSwingPing();
}

/** @param {HTMLDivElement} iconEl tile `.monitorTileBig` wrapper */
function styleIcon(iconEl, plane, level) {
  const glyph = iconEl.querySelector(".monitorTileGlyph");
  const color = displayColor(plane, level);
  iconEl.style.color = color;
  if (glyph) glyph.style.color = color;

  const tri = glyphIsTriangle(plane, level);
  const scale = displayScale(level, tri);
  if (glyph) glyph.style.transform = `scale(${scale})`;
  else iconEl.style.transform = `scale(${scale})`;
}

// ── WebRTC ─────────────────────────────────────────────────────────────────────

function attachDataChannel(channel) {
  dc = channel;
  dc.onopen    = () => {
    setStatus("Paired — receiving data");
    void acquireScreenWakeLock();
  };
  dc.onclose   = () => {
    releaseScreenWakeLock();
    setStatus("Disconnected");
  };
  dc.onerror   = () => {
    releaseScreenWakeLock();
    setStatus("Data channel error");
  };
  dc.onmessage = (e) => {
    try {
      const msg = JSON.parse(String(e.data));
      if (msg?.type === "summary") applySummary(msg);
      else applyLiveUpdate(msg);
    } catch { /* ignore malformed */ }
  };
}

function ensurePeer() {
  if (pc) return pc;
  pc = createPeerConnection();
  pc.onconnectionstatechange = () => {
    const s = pc?.connectionState;
    if (s === "connected") {
      setStatus("Paired — receiving data");
    } else if (s === "disconnected" || s === "failed") {
      releaseScreenWakeLock();
      setStatus("Disconnected");
    }
  };
  pc.ondatachannel = (ev) => attachDataChannel(ev.channel);
  return pc;
}

function resetAll() {
  releaseScreenWakeLock();
  try { dc?.close(); } catch { /* ignore */ }
  try { pc?.close(); } catch { /* ignore */ }
  dc = null; pc = null;
  answerEncoded = "";
  showIdlePane();
  setStatus("Not paired");
  el.offerText.value = "";
  setTileGlyph(el.liveIcon, "—");
  const liveG = el.liveIcon.querySelector(".monitorTileGlyph");
  if (liveG) liveG.style.transform = "scale(1)";
  el.liveMeta.textContent = "Waiting…";
}

// ── Pairing UI helpers ─────────────────────────────────────────────────────────

function showIdlePane() {
  el.pairIdle.hidden   = false;
  el.pairAnswer.hidden = true;
  el.panePaste.hidden  = true;
}

function showAnswerPane(hint) {
  el.pairIdle.hidden   = true;
  el.pairAnswer.hidden = false;
  el.answerHint.textContent = hint;
}

// ── Core signaling logic ───────────────────────────────────────────────────────

/**
 * Process a raw offer string (either the raw encoded token extracted from a
 * hash/URL, or the full monitor.html URL containing #o=…).
 */
async function processOfferText(raw) {
  const trimmed = raw.trim();

  // Accept a full URL — extract just the hash param.
  let encoded = trimmed;
  try {
    const u = new URL(trimmed);
    const hash = u.hash; // e.g. "#o=abc123"
    if (hash.startsWith("#o=")) encoded = hash.slice(3);
  } catch { /* not a URL — treat as raw encoded token */ }

  if (!encoded) throw new Error("Empty offer — copy the full link from iPhone");

  let offer;
  try {
    offer = await decodeSignal(encoded);
  } catch {
    throw new Error("Couldn't decode offer — copy the full link from iPhone");
  }
  if (!offer?.type || !offer?.sdp) throw new Error("Invalid offer");

  setStatus("Generating answer…");
  const peer = ensurePeer();
  await peer.setRemoteDescription(offer);
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  await waitForIceGatheringComplete(peer, { timeoutMs: 2200 });

  const local = peer.localDescription;
  if (!local) throw new Error("No local description");

  answerEncoded = await encodeSignal({ type: local.type, sdp: local.sdp });

  // Auto-copy to clipboard (requires page focus; works in click-handler context).
  let autoCopied = false;
  try {
    await navigator.clipboard.writeText(answerEncoded);
    autoCopied = true;
  } catch { /* no clipboard permission — user will tap Copy */ }

  const hint = autoCopied
    ? "Answer copied — go to iPhone and tap Start Monitor"
    : "Tap Copy (fallback), then go to iPhone and tap Start Monitor";

  showAnswerPane(hint);
  setStatus(autoCopied ? "Answer copied" : "Answer ready");
}

/** Read offer from clipboard (user gesture required). */
async function pasteFromiPhone() {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    // Fallback: show the manual textarea.
    el.panePaste.hidden = false;
    el.offerText.focus();
    setStatus("Paste the link or offer text, then tap 'Use offer'");
    return;
  }
  if (!text?.trim()) {
    el.panePaste.hidden = false;
    el.offerText.focus();
    setStatus("Clipboard empty — paste manually");
    return;
  }
  await processOfferText(text);
}

/** Copy the answer encoded string to clipboard. */
async function copyAnswer() {
  if (!answerEncoded) return;
  try {
    await navigator.clipboard.writeText(answerEncoded);
    setStatus("Answer copied — go to iPhone and tap 'Paste Answer'");
  } catch {
    setStatus("Couldn't copy automatically — long-press the answer text to copy");
  }
}

// ── Init ───────────────────────────────────────────────────────────────────────

function init() {
  showIdlePane();

  document.addEventListener(
    "pointerdown",
    () => { void primeSwingPingAudio(); },
    { once: true, capture: true, passive: true }
  );

  // iOS releases the wake lock when the tab goes to background; re-apply when visible and still paired.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && dc?.readyState === "open") {
      void acquireScreenWakeLock();
    }
  });

  // Auto-process offer if the URL hash contains #o=… (opened via Share link from iPhone).
  const hash = location.hash;
  if (hash.startsWith("#o=")) {
    const encoded = hash.slice(3);
    processOfferText(encoded).catch((e) => {
      setStatus(e instanceof Error ? e.message : "Failed to process offer — get a new link from iPhone");
      showIdlePane();
    });
  }

  el.btnPasteOffer.addEventListener("click", () =>
    pasteFromiPhone().catch((e) => {
      setStatus(e instanceof Error ? e.message : "Paste failed");
      el.panePaste.hidden = false;
    })
  );

  el.btnUseOffer.addEventListener("click", () =>
    processOfferText(el.offerText.value).catch((e) =>
      setStatus(e instanceof Error ? e.message : "Invalid offer")
    )
  );

  el.btnCopyAnswer.addEventListener("click",  () => copyAnswer());
}

init();
