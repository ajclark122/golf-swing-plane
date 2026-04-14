import { createPeerConnection, decodeSignal, encodeSignal, waitForIceGatheringComplete } from "./webrtc-signaling.js";

const el = {
  status: /** @type {HTMLDivElement} */ (document.getElementById("monitorStatus")),
  liveIcon: /** @type {HTMLDivElement} */ (document.getElementById("liveIcon")),
  liveMeta: /** @type {HTMLDivElement} */ (document.getElementById("liveMeta")),
  backIcon: /** @type {HTMLDivElement} */ (document.getElementById("backIcon")),
  backMeta: /** @type {HTMLDivElement} */ (document.getElementById("backMeta")),
  downIcon: /** @type {HTMLDivElement} */ (document.getElementById("downIcon")),
  downMeta: /** @type {HTMLDivElement} */ (document.getElementById("downMeta")),

  btnScanOffer: /** @type {HTMLButtonElement} */ (document.getElementById("btnScanOffer")),
  btnPasteOffer: /** @type {HTMLButtonElement} */ (document.getElementById("btnPasteOffer")),
  btnStopScan: /** @type {HTMLButtonElement} */ (document.getElementById("btnStopScan")),
  btnUseOffer: /** @type {HTMLButtonElement} */ (document.getElementById("btnUseOffer")),
  btnCopyAnswer: /** @type {HTMLButtonElement} */ (document.getElementById("btnCopyAnswer")),
  btnResetPair: /** @type {HTMLButtonElement} */ (document.getElementById("btnResetPair")),

  paneScanner: /** @type {HTMLDivElement} */ (document.getElementById("paneScanner")),
  panePaste: /** @type {HTMLDivElement} */ (document.getElementById("panePaste")),
  paneAnswer: /** @type {HTMLDivElement} */ (document.getElementById("paneAnswer")),
  qrReader: /** @type {HTMLDivElement} */ (document.getElementById("qrReader")),

  offerText: /** @type {HTMLTextAreaElement} */ (document.getElementById("offerText")),
  answerQr: /** @type {HTMLCanvasElement} */ (document.getElementById("answerQr")),
  answerText: /** @type {HTMLTextAreaElement} */ (document.getElementById("answerText")),
};

/** @type {RTCPeerConnection|null} */
let pc = null;
/** @type {RTCDataChannel|null} */
let dc = null;
/** @type {any|null} */
let qr = null;

function setStatus(msg) {
  el.status.textContent = msg;
}

function hideAllPanes() {
  el.paneScanner.hidden = true;
  el.panePaste.hidden = true;
  el.paneAnswer.hidden = true;
}

function planeToIcon(plane) {
  if (plane === "above") return "▲";
  if (plane === "on") return "●";
  if (plane === "below") return "▽";
  return "—";
}

function planeToLabel(plane) {
  if (plane === "above") return "Above plane";
  if (plane === "on") return "On plane";
  if (plane === "below") return "Below plane";
  return "—";
}

function phaseToLabel(phase) {
  const m = { address: "Address", backswing: "Backswing", top: "Top", downswing: "Downswing", impact: "Impact" };
  return m[phase] || String(phase || "—");
}

function applyLiveUpdate(msg) {
  const phase = msg?.phase ?? null;
  const plane = msg?.plane ?? null;

  el.liveIcon.textContent = planeToIcon(plane);
  el.liveMeta.textContent = `${phaseToLabel(phase)} · ${planeToLabel(plane)}`;
}

function applySummary(msg) {
  el.backIcon.textContent = planeToIcon(msg?.backswingDominant ?? null);
  el.backMeta.textContent = planeToLabel(msg?.backswingDominant ?? null);

  el.downIcon.textContent = planeToIcon(msg?.downswingDominant ?? null);
  el.downMeta.textContent = planeToLabel(msg?.downswingDominant ?? null);
}

function attachDataChannel(channel) {
  dc = channel;
  dc.onopen = () => setStatus("Paired (receiving)");
  dc.onclose = () => setStatus("Disconnected");
  dc.onerror = () => setStatus("Data channel error");
  dc.onmessage = (e) => {
    try {
      const msg = JSON.parse(String(e.data));
      if (msg?.type === "summary") applySummary(msg);
      else applyLiveUpdate(msg);
    } catch {
      // ignore
    }
  };
}

function resetAll() {
  try { dc?.close(); } catch { /* ignore */ }
  try { pc?.close(); } catch { /* ignore */ }
  dc = null;
  pc = null;
  stopScanner();
  hideAllPanes();
  setStatus("Not paired");
  el.offerText.value = "";
  el.answerText.value = "";
  el.liveIcon.textContent = "—";
  el.liveMeta.textContent = "Waiting…";
}

async function ensurePeer() {
  if (pc) return pc;
  pc = createPeerConnection();
  pc.onconnectionstatechange = () => {
    const s = pc?.connectionState;
    if (s === "connected") setStatus("Paired (connected)");
    else if (s === "disconnected" || s === "failed") setStatus("Disconnected");
  };
  pc.ondatachannel = (ev) => attachDataChannel(ev.channel);
  return pc;
}

async function useOfferText(text) {
  const offer = decodeSignal(text);
  if (!offer?.type || !offer?.sdp) throw new Error("Invalid offer");

  hideAllPanes();
  setStatus("Creating answer…");

  const peer = await ensurePeer();
  await peer.setRemoteDescription(offer);
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  await waitForIceGatheringComplete(peer, { timeoutMs: 2200 });

  const local = peer.localDescription;
  if (!local) throw new Error("No local description");

  const encoded = encodeSignal({ type: local.type, sdp: local.sdp });
  el.answerText.value = encoded;
  await drawQrToCanvas(el.answerQr, encoded);

  el.paneAnswer.hidden = false;
  setStatus("Answer ready (show to iPhone)");
}

async function drawQrToCanvas(canvas, text) {
  // QRCode is a global from qrcode.min.js
  // @ts-ignore
  await QRCode.toCanvas(canvas, text, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: canvas.width,
    color: { dark: "#ffffff", light: "#00000000" },
  });
}

async function startScanner() {
  stopScanner();
  hideAllPanes();
  el.paneScanner.hidden = false;

  // Html5Qrcode is global from html5-qrcode.min.js
  // @ts-ignore
  const Html5Qrcode = window.Html5Qrcode;
  if (!Html5Qrcode) throw new Error("QR scanner unavailable");

  qr = new Html5Qrcode("qrReader");
  setStatus("Scanning offer…");

  // @ts-ignore
  const cameras = await Html5Qrcode.getCameras();
  const cameraId = cameras?.[0]?.id;
  if (!cameraId) throw new Error("No camera found");

  await qr.start(
    { deviceId: { exact: cameraId } },
    { fps: 10, qrbox: { width: 240, height: 240 } },
    async (decodedText) => {
      stopScanner();
      try {
        await useOfferText(decodedText);
      } catch (e) {
        setStatus(`Offer error`);
        el.panePaste.hidden = false;
      }
    }
  );
}

function stopScanner() {
  if (!qr) return;
  const q = qr;
  qr = null;
  q.stop?.().catch(() => {}).finally(() => q.clear?.());
}

async function copyAnswer() {
  const text = el.answerText.value.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Answer copied");
  } catch {
    // Fallback: select for manual copy
    el.answerText.focus();
    el.answerText.select();
    setStatus("Select + copy");
  }
}

function init() {
  hideAllPanes();

  el.btnScanOffer.addEventListener("click", () => startScanner().catch(() => setStatus("Scan failed")));
  el.btnStopScan.addEventListener("click", () => { stopScanner(); hideAllPanes(); setStatus("Not paired"); });

  el.btnPasteOffer.addEventListener("click", () => { stopScanner(); hideAllPanes(); el.panePaste.hidden = false; setStatus("Paste offer"); });
  el.btnUseOffer.addEventListener("click", () => useOfferText(el.offerText.value).catch(() => setStatus("Offer error")));

  el.btnCopyAnswer.addEventListener("click", () => copyAnswer());
  el.btnResetPair.addEventListener("click", () => resetAll());
}

init();

