import { createPeerConnection, decodeSignal, encodeSignal, waitForIceGatheringComplete } from "./webrtc-signaling.js";

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

// ── Status / tile helpers ──────────────────────────────────────────────────────

function setStatus(msg) { el.status.textContent = msg; }

function planeToIcon(plane) {
  if (plane === "above") return "▲";
  if (plane === "on")    return "●";
  if (plane === "below") return "▽";
  return "—";
}

function planeToLabel(plane) {
  if (plane === "above") return "Above plane";
  if (plane === "on")    return "On plane";
  if (plane === "below") return "Below plane";
  return "—";
}

function phaseToLabel(phase) {
  const m = { address: "Address", backswing: "Backswing", top: "Top", downswing: "Downswing", impact: "Impact" };
  return m[phase] || String(phase || "—");
}

function applyLiveUpdate(msg) {
  const plane = msg?.plane ?? null;
  const level = (msg?.level === 0 || msg?.level === 1 || msg?.level === 2 || msg?.level === 3) ? msg.level : null;
  styleIcon(el.liveIcon, plane, level);
  el.liveIcon.textContent = planeToIcon(plane);
  el.liveMeta.textContent = `${phaseToLabel(msg?.phase)} · ${planeToLabel(plane)}`;
}

function applySummary(msg) {
  const backPlane = msg?.backswingDominant ?? null;
  const backLevel = (msg?.backswingLevel === 0 || msg?.backswingLevel === 1 || msg?.backswingLevel === 2 || msg?.backswingLevel === 3) ? msg.backswingLevel : null;
  styleIcon(el.backIcon, backPlane, backLevel);
  el.backIcon.textContent = planeToIcon(backPlane);
  el.backMeta.textContent = planeToLabel(backPlane);

  const downPlane = msg?.downswingDominant ?? null;
  const downLevel = (msg?.downswingLevel === 0 || msg?.downswingLevel === 1 || msg?.downswingLevel === 2 || msg?.downswingLevel === 3) ? msg.downswingLevel : null;
  styleIcon(el.downIcon, downPlane, downLevel);
  el.downIcon.textContent = planeToIcon(downPlane);
  el.downMeta.textContent = planeToLabel(downPlane);
}

function styleIcon(iconEl, plane, level) {
  // Match the iPhone colors.
  const color = plane === "above" ? "#ff6b85"
    : plane === "below" ? "#6ab8ff"
    : plane === "on"    ? "#5dff9e"
    : "rgba(255,255,255,0.92)";
  iconEl.style.color = color;

  // 4-step size scale: on-plane biggest, way-off smallest.
  const scale = level === 0 ? 1.22 : level === 1 ? 1.08 : level === 2 ? 0.96 : level === 3 ? 0.86 : 1;
  iconEl.style.transform = `scale(${scale})`;
}

// ── WebRTC ─────────────────────────────────────────────────────────────────────

function attachDataChannel(channel) {
  dc = channel;
  dc.onopen    = () => setStatus("Paired — receiving data");
  dc.onclose   = () => setStatus("Disconnected");
  dc.onerror   = () => setStatus("Data channel error");
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
    if (s === "connected")                      setStatus("Paired — receiving data");
    else if (s === "disconnected" || s === "failed") setStatus("Disconnected");
  };
  pc.ondatachannel = (ev) => attachDataChannel(ev.channel);
  return pc;
}

function resetAll() {
  try { dc?.close(); } catch { /* ignore */ }
  try { pc?.close(); } catch { /* ignore */ }
  dc = null; pc = null;
  answerEncoded = "";
  showIdlePane();
  setStatus("Not paired");
  el.offerText.value = "";
  el.liveIcon.textContent = "—"; el.liveMeta.textContent = "Waiting…";
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
