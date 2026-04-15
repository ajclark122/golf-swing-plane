/**
 * Single-file, framework-free iPhone camera + draggable line overlay.
 * Designed for touch: drag endpoints to rotate/resize, drag body to move.
 *
 * v2 additions:
 *  - Dedicated amber swing-plane line (Side view, auto-proposed at address via MoveNet)
 *  - Pose-based phase detection (address / backswing / top / downswing / impact)
 *  - Above / on / below plane assessment with colored wrist dot + HUD badge
 */

import { displayGlyph, displayPhrase, displayScale, glyphIsTriangle } from "./plane-display.js";
import { playReadyCue, playSwingSummarySound, primeSwingPingAudio } from "./swing-ping.js";

const STORAGE_KEY_FRONT  = "golfcam.lines.front.v1";
const STORAGE_KEY_SIDE   = "golfcam.lines.side.v1";
const STORAGE_SWING_PLANE = "golfcam.swingplane.side.v1";
const STORAGE_UI   = "golfcam.ui.v1";
const STORAGE_HELP = "golfcam.helpDismissed";
const STORAGE_CLUB = "golfcam.club.v1";

/** Color used for the dedicated swing-plane line. */
const SWING_PLANE_COLOR = "#ffd44d";

/**
 * Standard club lie angles (degrees from horizontal).
 * Lie angle = angle the shaft makes with the ground at address.
 * Longer clubs are shallower (smaller angle); wedges are steepest.
 */
const CLUBS = [
  { id: "1w", label: "Dr",  lieAngle: 58   },
  { id: "3w", label: "3W",  lieAngle: 56   },
  { id: "5w", label: "5W",  lieAngle: 58   },
  { id: "hy", label: "HY",  lieAngle: 60   },
  { id: "3i", label: "3I",  lieAngle: 60   },
  { id: "4i", label: "4I",  lieAngle: 61   },
  { id: "5i", label: "5I",  lieAngle: 62   },
  { id: "6i", label: "6I",  lieAngle: 62.5 },
  { id: "7i", label: "7I",  lieAngle: 63   },
  { id: "8i", label: "8I",  lieAngle: 63.5 },
  { id: "9i", label: "9I",  lieAngle: 64   },
  { id: "pw", label: "PW",      lieAngle: 64   },
  { id: "gw", label: "GW",      lieAngle: 64   },
  { id: "sw", label: "SW",      lieAngle: 64   },
  { id: "lw", label: "LW",      lieAngle: 64   },
];

/** Fixed ground reference in normalized overlay coords (y increases downward). */
const GROUND_Y = 0.92;

/**
 * Camera perspective causes apparent lie angles to differ from physical values.
 * Negative = shallower projection → club head moves further from body.
 * Tune until the yellow line visually matches the club shaft at address.
 * (Driver at 58° looked right for an 8i at 63.5° → we need to subtract ~6°.)
 */
const CLUB_LIE_OFFSET = -6;

/** @typedef {{id:string,x1:number,y1:number,x2:number,y2:number,color:string,width:number}} Line */

const state = {
  stream:      /** @type {MediaStream|null} */ (null),
  lines:       /** @type {Line[]} */ ([]),
  selectedId:  /** @type {string|null} */ (null),
  drag: /** @type {null|{lineId:string,mode:"end1"|"end2"|"body",startNx:number,startNy:number,base:Line}} */ (null),
  ready:         false,
  view:          /** @type {"front"|"side"} */ ("front"),
  handedness:    /** @type {"right"|"left"} */ ("right"),
  selectedClub:  "7i", // persisted via STORAGE_CLUB

  recording: {
    active:          false,
    recorder:        /** @type {MediaRecorder|null} */ (null),
    chunks:          /** @type {BlobPart[]} */ ([]),
    compositeCanvas: /** @type {HTMLCanvasElement|null} */ (null),
    compositeCtx:    /** @type {CanvasRenderingContext2D|null} */ (null),
    raf:             /** @type {number|null} */ (null),
    lastUrl:         /** @type {string|null} */ (null),
  },

  ui: {
    hidden:       false,
    drawerOpen:   false,
    lastActiveAt: Date.now(),
    idleMs:       6000,
  },

  /**
   * Dedicated amber swing-plane line (Side view only).
   * Auto-proposed from pose at address — display-only, not user-draggable.
   */
  swingPlaneLine: {
    line: /** @type {Line} */ ({ id: "swingplane", x1: 0.70, y1: 0.25, x2: 0.35, y2: 0.72, color: SWING_PLANE_COLOR, width: 3 }),
  },

  /** MoveNet pose tracking. */
  pose: {
    detector:      /** @type {any|null} */ (null),
    active:        false,
    rafHandle:     /** @type {number|null} */ (null),
    frameCount:    0,
    inferring:     false,
    wristHistory:  /** @type {{x:number,y:number,t:number}[]} */ ([]),
    /** True while the post–re-calibrate overlay countdown is running. */
    recalibrateCountdown: false,
    phase:         /** @type {"address"|"backswing"|"top"|"downswing"|"impact"} */ ("address"),
    prevPhase:     /** @type {"address"|"backswing"|"top"|"downswing"|"impact"} */ ("address"),
    planeResult:   /** @type {"above"|"on"|"below"|null} */ (null),
    planeLevel:    /** @type {0|1|2|3|null} */ (null), // 0=on, 1=near, 2=off, 3=way off
    lastWristNorm: /** @type {{x:number,y:number}|null} */ (null),
    lastGoodAt:    0,
    addressWristY: /** @type {number|null} */ (null),
    addressWristX: /** @type {number|null} */ (null), // tracked alongside Y for plane-displacement gate
    stableFrames:  0,
    // Per-swing accumulator — stores plane readings during each phase
    backswingLog:       /** @type {string[]} */ ([]),
    downswingLog:       /** @type {string[]} */ ([]),
    backswingLevelLog:  /** @type {number[]} */ ([]),
    downswingLevelLog:  /** @type {number[]} */ ([]),
    swingCompleted: false,
    summaryTimerHandle: /** @type {ReturnType<typeof setTimeout>|null} */ (null),
    frameGuide:    /** @type {null|"step-back"|"step-closer"|"raise-club"} */ (null),
    shoulderNy:    /** @type {number|null} */ (null), // EMA-smoothed shoulder height at address
    planeLocked:   false, // true once the line has settled — won't move during swing
    /** Wrist midpoint in overlay norm space when the plane last locked (stance-change detection). */
    planeLockHandsNorm: /** @type {{x:number,y:number}|null} */ (null),
    /** If set: first timestamp while locked+address+hands drifted from `planeLockHandsNorm`. */
    planeRelockStillSince: /** @type {number|null} */ (null),
    /** True if we visited the "top" phase this swing (for full-swing summary gate). */
    sawTopThisSwing: false,
    /** Consecutive pose frames in backswing (for early takeaway plane gate). */
    backswingConsecutiveFrames: 0,
    /**
     * Hands must rise above this Y (overlay, y-down) to count as swing started.
     * Updated while at address: midpoint(address wrist, shoulder), or wrist−offset if no shoulder.
     */
    swingStartGateNy: /** @type {number|null} */ (null),
  },
};

const el = {
  stage:          /** @type {HTMLDivElement}    */ (document.getElementById("stage")),
  video:          /** @type {HTMLVideoElement}  */ (document.getElementById("video")),
  canvas:         /** @type {HTMLCanvasElement} */ (document.getElementById("overlay")),
  status:         /** @type {HTMLDivElement}    */ (document.getElementById("status")),
  hudTop:         /** @type {HTMLDivElement}    */ (document.querySelector(".hud.top")),
  hudBottom:      /** @type {HTMLDivElement}    */ (document.querySelector(".hud.bottom")),
  btnStartStop:   /** @type {HTMLButtonElement} */ (document.getElementById("btnStartStop")),
  btnViewFront:   /** @type {HTMLButtonElement} */ (document.getElementById("btnViewFront")),
  btnViewSide:    /** @type {HTMLButtonElement} */ (document.getElementById("btnViewSide")),
  btnAdd:         /** @type {HTMLButtonElement} */ (document.getElementById("btnAdd")),
  btnDelete:      /** @type {HTMLButtonElement} */ (document.getElementById("btnDelete")),
  btnReset:       /** @type {HTMLButtonElement} */ (document.getElementById("btnReset")),
  btnRecalibrate: /** @type {HTMLButtonElement} */ (document.getElementById("btnRecalibrate")),
  btnHandRight:   /** @type {HTMLButtonElement} */ (document.getElementById("btnHandRight")),
  btnHandLeft:    /** @type {HTMLButtonElement} */ (document.getElementById("btnHandLeft")),
  fps:            /** @type {HTMLSelectElement} */ (document.getElementById("fps")),
  btnMonitorPair: /** @type {HTMLButtonElement} */ (document.getElementById("btnMonitorPair")),
  btnRecord:      /** @type {HTMLButtonElement} */ (document.getElementById("btnRecord")),
  btnStopRec:     /** @type {HTMLButtonElement} */ (document.getElementById("btnStopRec")),
  btnStopFloat:   /** @type {HTMLButtonElement} */ (document.getElementById("btnStopFloat")),
  countdown:      /** @type {HTMLDivElement}    */ (document.getElementById("countdown")),
  countdownNum:   /** @type {HTMLDivElement|null} */ (document.getElementById("countdownNum")),
  countdownHint:  /** @type {HTMLDivElement|null} */ (document.getElementById("countdownHint")),
  swingDebug:     /** @type {HTMLDivElement|null} */ (document.getElementById("swingDebug")),
  help:           /** @type {HTMLDivElement}    */ (document.getElementById("help")),
  btnDismissHelp: /** @type {HTMLButtonElement} */ (document.getElementById("btnDismissHelp")),
  assessment:     /** @type {HTMLDivElement}    */ (document.getElementById("assessment")),
  frameGuide:     /** @type {HTMLDivElement}    */ (document.getElementById("frameGuide")),
  clubSelect:     /** @type {HTMLSelectElement} */ (document.getElementById("clubSelect")),
  hudHandle:      /** @type {HTMLDivElement}    */ (document.getElementById("hudHandle")),
  swingSummary:   /** @type {HTMLDivElement}    */ (document.getElementById("swingSummary")),

  // iPhone monitor pairing panel
  monitorPanel:         /** @type {HTMLDivElement} */ (document.getElementById("monitorPanel")),
  monitorPairStatus:    /** @type {HTMLDivElement} */ (document.getElementById("monitorPairStatus")),
  btnMonitorClose:      /** @type {HTMLButtonElement} */ (document.getElementById("btnMonitorClose")),
  btnMonitorShare:      /** @type {HTMLButtonElement} */ (document.getElementById("btnMonitorShare")),
  btnMonitorPasteAnswer:/** @type {HTMLButtonElement} */ (document.getElementById("btnMonitorPasteAnswer")),
  monitorAnswerText:    /** @type {HTMLTextAreaElement} */ (document.getElementById("monitorAnswerText")),
  btnMonitorUseAnswer:  /** @type {HTMLButtonElement} */ (document.getElementById("btnMonitorUseAnswer")),
};

const ctx = el.canvas.getContext("2d", { alpha: true });
if (!ctx) throw new Error("Canvas 2D context unavailable");

// ── Utilities ─────────────────────────────────────────────────────────────────

function setStatus(msg) { el.status.textContent = msg; }

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function uid() { return Math.random().toString(16).slice(2) + Date.now().toString(16); }

function isMenuShowing() {
  const monitorOpen = el.monitorPanel?.classList.contains("show") ?? false;
  const helpOpen    = el.help?.classList.contains("show") ?? false;
  return Boolean(state.ui.drawerOpen || monitorOpen || helpOpen);
}

function suppressSwingOverlaysIfMenuShowing() {
  if (!isMenuShowing()) return;
  dismissSwingSummary();
  renderAssessment();
  renderFrameGuide();
}

// ── Monitor (WebRTC DataChannel) ───────────────────────────────────────────────

const monitor = {
  pc:          /** @type {RTCPeerConnection|null} */ (null),
  dc:          /** @type {RTCDataChannel|null} */ (null),
  connected:   false,
  lastSentAt:  0,
  lastKey:     "",
  offerUrl:    "", // full monitor.html#o=… URL, ready for sharing / copying
};

function monitorSetStatus(msg) {
  if (el.monitorPairStatus) el.monitorPairStatus.textContent = msg;
}

function monitorShowPanel(show) {
  if (!el.monitorPanel) return;
  el.monitorPanel.classList.toggle("show", show);
  el.monitorPanel.setAttribute("aria-hidden", show ? "false" : "true");
  if (show) suppressSwingOverlaysIfMenuShowing();
}

function monitorResetPeer() {
  try { monitor.dc?.close(); } catch { /* ignore */ }
  try { monitor.pc?.close(); } catch { /* ignore */ }
  monitor.dc = null;
  monitor.pc = null;
  monitor.connected = false;
  monitor.lastSentAt = 0;
  monitor.lastKey = "";
  monitor.offerUrl = "";
}

function monitorCreatePeer() {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === "connected") {
      monitor.connected = true;
      monitorSetStatus("Connected — iPad is receiving data");
    } else if (s === "disconnected" || s === "failed") {
      monitor.connected = false;
      monitorSetStatus("Disconnected — open the panel to re-pair");
    }
  };
  return pc;
}

function monitorAttachDataChannel(dc) {
  monitor.dc = dc;
  monitor.dc.onopen  = () => { monitor.connected = true;  monitorSetStatus("Connected — iPad is receiving data"); };
  monitor.dc.onclose = () => { monitor.connected = false; monitorSetStatus("Disconnected"); };
  monitor.dc.onerror = () => { monitor.connected = false; monitorSetStatus("Data channel error"); };
}

async function monitorWaitForIce(pc, timeoutMs = 900) {
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

/** Compress an object to a base64url string. Uses native DeflateRaw; plain base64url fallback. */
async function monitorEncodeSignal(obj) {
  const input = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream !== "undefined") {
    try {
      const cs = new CompressionStream("deflate-raw");
      const w = cs.writable.getWriter();
      w.write(input); w.close();
      return _monitorB64uEncode(new Uint8Array(await new Response(cs.readable).arrayBuffer()));
    } catch { /* fall through */ }
  }
  return _monitorB64uEncode(input);
}

/** Decompress a base64url string back to an object. Mirrors monitorEncodeSignal. */
async function monitorDecodeSignal(text) {
  const bytes = _monitorB64uDecode(String(text || "").trim());
  if (typeof DecompressionStream !== "undefined") {
    try {
      const ds = new DecompressionStream("deflate-raw");
      const w = ds.writable.getWriter();
      w.write(bytes); w.close();
      return JSON.parse(new TextDecoder().decode(await new Response(ds.readable).arrayBuffer()));
    } catch { /* fall through */ }
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function _monitorB64uEncode(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function _monitorB64uDecode(b64url) {
  let s = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Generate a fresh WebRTC offer and build the monitor URL containing it. */
async function monitorNewOffer() {
  monitorResetPeer();
  monitorSetStatus("Generating link…");
  if (el.monitorAnswerText) { el.monitorAnswerText.value = ""; el.monitorAnswerText.hidden = true; }
  if (el.btnMonitorUseAnswer) el.btnMonitorUseAnswer.hidden = true;

  monitor.pc = monitorCreatePeer();
  const dc = monitor.pc.createDataChannel("monitor");
  monitorAttachDataChannel(dc);

  const offer = await monitor.pc.createOffer();
  await monitor.pc.setLocalDescription(offer);
  // Short timeout — on LAN, host candidates are enough and keep the SDP small.
  await monitorWaitForIce(monitor.pc, 900);

  const local = monitor.pc.localDescription;
  if (!local) throw new Error("No local description");

  const encoded = await monitorEncodeSignal({ type: local.type, sdp: local.sdp });
  const base = new URL("./monitor.html", location.href).href.split("#")[0];
  monitor.offerUrl = `${base}#o=${encoded}`;

  monitorSetStatus("Ready — tap Pair Monitor");
}

/** Open the native Share Sheet (AirDrop etc.) with the offer URL. */
async function monitorShare() {
  if (!monitor.offerUrl) await monitorNewOffer();
  if (navigator.share) {
    try {
      await navigator.share({ url: monitor.offerUrl, title: "Golf Monitor" });
    } catch (e) {
      if (!(e instanceof Error) || e.name !== "AbortError") {
        monitorSetStatus("Pair failed — try again");
      }
    }
  }
}

/**
 * Read the answer from the clipboard (requires a user-gesture click).
 * Falls back to showing a textarea if the clipboard API is unavailable.
 */
async function monitorPasteAnswer() {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    // Clipboard read unavailable — show the manual textarea fallback.
    if (el.monitorAnswerText) { el.monitorAnswerText.hidden = false; el.monitorAnswerText.focus(); }
    if (el.btnMonitorUseAnswer) el.btnMonitorUseAnswer.hidden = false;
    monitorSetStatus("Paste the answer from iPad into the box, then tap Connect");
    return;
  }
  if (!text?.trim()) {
    monitorSetStatus("Not ready yet — open the iPad link first, then come back and tap Start Monitor");
    return;
  }
  await monitorApplyAnswer(text.trim());
}

/** Decode and apply an answer SDP to the existing peer connection. */
async function monitorApplyAnswer(text) {
  if (!monitor.pc) { monitorSetStatus("Generate a new link first"); return; }
  let answer;
  try {
    answer = await monitorDecodeSignal(text);
  } catch {
    monitorSetStatus("Couldn't read the answer — try opening the iPad link again, then tap Start Monitor");
    return;
  }
  if (!answer?.type || !answer?.sdp) { monitorSetStatus("Invalid answer — try generating a new link"); return; }
  monitorSetStatus("Connecting…");
  try {
    await monitor.pc.setRemoteDescription(answer);
    monitorSetStatus("Paired — start the camera to send data to iPad");
  } catch {
    monitorSetStatus("Connection failed — try generating a new link");
  }
}

function monitorMaybeSendLive() {
  if (!monitor.connected || !monitor.dc || monitor.dc.readyState !== "open") return;
  const now = Date.now();
  const msg = {
    t:     now,
    view:  state.view,
    phase: state.pose.phase,
    plane: state.pose.planeResult,
    level: state.pose.planeLevel,
    club:  state.selectedClub,
  };
  const quietAddress = msg.phase === "address" && msg.plane == null;
  // Live feed: suppress rapid address+waggle noise; once swing is underway, keep responsive.
  if (quietAddress) {
    if (now - monitor.lastSentAt < 400) return;
  } else if (now - monitor.lastSentAt < 100) {
    return; // 10 Hz max during motion
  }

  const key = `${msg.view}|${msg.phase}|${msg.plane ?? "null"}|${msg.level ?? "x"}|${msg.club ?? ""}`;
  const dedupeMs = quietAddress ? 600 : 250;
  if (key === monitor.lastKey && now - monitor.lastSentAt < dedupeMs) return;

  monitor.lastKey = key;
  monitor.lastSentAt = now;
  try { monitor.dc.send(JSON.stringify(msg)); } catch { /* ignore */ }
}

function monitorSendSummary(backswingDominant, downswingDominant, backswingLevel, downswingLevel) {
  if (!monitor.connected || !monitor.dc || monitor.dc.readyState !== "open") return;
  const msg = {
    type: "summary",
    t: Date.now(),
    backswingDominant,
    downswingDominant,
    backswingLevel,
    downswingLevel,
  };
  try { monitor.dc.send(JSON.stringify(msg)); } catch { /* ignore */ }
}

/**
 * Draw videoEl into ctx2d at destW×destH using object-fit:cover semantics.
 * mirrorX flips horizontally (to match CSS scaleX(-1) on the live video).
 */
function drawVideoCover(ctx2d, videoEl, destW, destH, { mirrorX } = { mirrorX: false }) {
  const vw = videoEl.videoWidth || 0;
  const vh = videoEl.videoHeight || 0;
  if (!vw || !vh || !destW || !destH) return;

  const srcAR  = vw / vh;
  const destAR = destW / destH;
  let sx = 0, sy = 0, sw = vw, sh = vh;

  if (srcAR > destAR) {
    sw = Math.round(vh * destAR);
    sx = Math.round((vw - sw) / 2);
  } else {
    sh = Math.round(vw / destAR);
    sy = Math.round((vh - sh) / 2);
  }

  ctx2d.save();
  if (mirrorX) { ctx2d.translate(destW, 0); ctx2d.scale(-1, 1); }
  ctx2d.drawImage(videoEl, sx, sy, sw, sh, 0, 0, destW, destH);
  ctx2d.restore();
}

// ── Line data ─────────────────────────────────────────────────────────────────

function storageKeyForView(view) {
  return view === "side" ? STORAGE_KEY_SIDE : STORAGE_KEY_FRONT;
}

function defaultLinesForView(view) {
  const base = /** @type {Line} */ ({ id: uid(), x1: 0.5, y1: 0.2, x2: 0.5, y2: 0.85, color: "#ffffff", width: 3 });
  if (view === "front") return [base];
  return []; // Side view: no default white line — yellow swing-plane line is the only default
}

function loadLinesForView(view) {
  try {
    const raw = localStorage.getItem(storageKeyForView(view));
    if (!raw) { state.lines = defaultLinesForView(view); saveLinesForView(view); return; }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    state.lines = parsed
      .filter((l) => l && typeof l.id === "string")
      .map((l) => ({
        id:    String(l.id),
        x1:    clamp01(Number(l.x1)),
        y1:    clamp01(Number(l.y1)),
        x2:    clamp01(Number(l.x2)),
        y2:    clamp01(Number(l.y2)),
        color: typeof l.color === "string" ? l.color : "#ffffff",
        width: Number.isFinite(Number(l.width)) ? Number(l.width) : 3,
      }));
  } catch { /* ignore */ }
}

function saveLinesForView(view) {
  try { localStorage.setItem(storageKeyForView(view), JSON.stringify(state.lines)); } catch { /* ignore */ }
}

// ── Swing-plane line ──────────────────────────────────────────────────────────

function defaultSwingPlaneLine() {
  return /** @type {Line} */ ({ id: "swingplane", x1: 0.70, y1: 0.25, x2: 0.35, y2: 0.72, color: SWING_PLANE_COLOR, width: 3 });
}

function loadSwingPlaneLine() {
  try {
    const raw = localStorage.getItem(STORAGE_SWING_PLANE);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p.x1 === "number") {
        state.swingPlaneLine.line = {
          id: "swingplane",
          x1: clamp01(p.x1), y1: clamp01(p.y1),
          x2: clamp01(p.x2), y2: clamp01(p.y2),
          color: SWING_PLANE_COLOR, width: 3,
        };
        return;
      }
    }
  } catch { /* ignore */ }
  state.swingPlaneLine.line = defaultSwingPlaneLine();
}

function saveSwingPlaneLine() {
  try {
    localStorage.setItem(STORAGE_SWING_PLANE, JSON.stringify(state.swingPlaneLine.line));
  } catch { /* ignore */ }
}

// ── Selection / line management ───────────────────────────────────────────────

function selectLine(id) {
  state.selectedId = id;
  el.btnDelete.disabled = !id;
  render();
}

function addLine() {
  const line = /** @type {Line} */ ({
    id: uid(),
    ...(state.view === "front"
      ? { x1: 0.5, y1: 0.2, x2: 0.5, y2: 0.85 }
      : { x1: 0.78, y1: 0.25, x2: 0.28, y2: 0.75 }),
    color: "#ffffff",
    width: 3,
  });
  state.lines = [...state.lines, line];
  saveLinesForView(state.view);
  selectLine(line.id);
  setStatus(`Lines: ${state.lines.length}`);
}

function deleteSelected() {
  if (!state.selectedId) return;
  state.lines = state.lines.filter((l) => l.id !== state.selectedId);
  state.selectedId = null;
  saveLinesForView(state.view);
  el.btnDelete.disabled = true;
  setStatus(`Lines: ${state.lines.length}`);
  render();
}

function resetAll() {
  state.lines = defaultLinesForView(state.view);
  state.swingPlaneLine.line = defaultSwingPlaneLine();
  state.selectedId = null;
  state.drag       = null;
  saveLinesForView(state.view);
  saveSwingPlaneLine();
  el.btnDelete.disabled = true;
  setStatus("Reset");
  render();
}

// ── Canvas / coordinate helpers ───────────────────────────────────────────────

function getCanvasBox() {
  const r = el.canvas.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function clientToNormalized(clientX, clientY) {
  const { left, top, width, height } = getCanvasBox();
  return {
    nx: clamp01((clientX - left) / Math.max(1, width)),
    ny: clamp01((clientY - top)  / Math.max(1, height)),
  };
}

function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

function pointToSegmentDistance2(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const abLen2 = abx * abx + aby * aby || 1e-9;
  const t  = Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLen2));
  return dist2(px, py, ax + abx * t, ay + aby * t);
}

/**
 * Hit-test a point (nx, ny) against all user-draggable lines.
 * The swing-plane line is display-only and excluded from hit-testing.
 */
function hitTest(nx, ny) {
  const box = getCanvasBox();
  const px = nx * box.width, py = ny * box.height;
  const handleR2 = 18 * 18;
  const lineT2   = 14 * 14;

  function checkLine(l) {
    const ax = l.x1 * box.width, ay = l.y1 * box.height;
    const bx = l.x2 * box.width, by = l.y2 * box.height;
    if (dist2(px, py, ax, ay) <= handleR2) return { lineId: l.id, mode: "end1" };
    if (dist2(px, py, bx, by) <= handleR2) return { lineId: l.id, mode: "end2" };
    if (pointToSegmentDistance2(px, py, ax, ay, bx, by) <= lineT2) return { lineId: l.id, mode: "body" };
    return null;
  }

  for (let i = state.lines.length - 1; i >= 0; i--) {
    const hit = checkLine(state.lines[i]);
    if (hit) return hit;
  }
  return null;
}

function resizeCanvasToStage() {
  const r   = el.stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  el.canvas.width  = Math.max(1, Math.round(r.width  * dpr));
  el.canvas.height = Math.max(1, Math.round(r.height * dpr));
  el.canvas.style.width  = `${r.width}px`;
  el.canvas.style.height = `${r.height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

// ── HUD visibility ────────────────────────────────────────────────────────────

/** Open or close the bottom drawer. */
function setDrawerOpen(open) {
  state.ui.drawerOpen = open;
  el.hudBottom?.classList.toggle("expanded", open);
  if (open) suppressSwingOverlaysIfMenuShowing();
}

/** Fade the top HUD in/out. Bottom drawer is managed separately. */
function setHudHidden(hidden) {
  state.ui.hidden = hidden;
  el.hudTop?.classList.toggle("hidden", hidden);
}

/** Called on meaningful user interaction — resets idle timer and restores top HUD. */
function bumpUiActivity() {
  state.ui.lastActiveAt = Date.now();
  if (state.ui.hidden && !state.recording.active && !state.pose.recalibrateCountdown) setHudHidden(false);
}

/** Collapse drawer + fade top HUD after idle. */
function tickUiAutoHide() {
  if (state.recording.active || !state.ready || state.pose.recalibrateCountdown) return;
  if (Date.now() - state.ui.lastActiveAt >= state.ui.idleMs) {
    setHudHidden(true);
    if (state.ui.drawerOpen) setDrawerOpen(false);
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * Draw a single line + optional selection handles onto ctx2d.
 * Coords are normalized 0..1; W/H are the destination pixel dimensions.
 */
function drawLineOnCtx(c, line, W, H, selected, handleRadius) {
  const x1 = line.x1 * W, y1 = line.y1 * H;
  const x2 = line.x2 * W, y2 = line.y2 * H;

  c.lineCap     = "round";
  c.strokeStyle = selected ? "#ffd44d" : line.color;
  c.lineWidth   = selected ? line.width + 1.5 : line.width;
  c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();

  if (selected) {
    c.lineWidth = 2;
    for (const [x, y] of [[x1, y1], [x2, y2]]) {
      c.fillStyle   = "rgba(0,0,0,0.35)";
      c.strokeStyle = "rgba(255,255,255,0.92)";
      c.beginPath(); c.arc(x, y, handleRadius + 3, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(x, y, handleRadius,     0, Math.PI * 2); c.stroke();
    }
  }
}

/** Fill for wrist dot — same hues as `.assessment` / `.sswPhaseIcon` plane states. */
function planeResultWristFill(/** @type {"above"|"on"|"below"|null} */ plane) {
  if (plane === "above") return "#ff6b85";
  if (plane === "below") return "#6ab8ff";
  if (plane === "on") return "#5dff9e";
  return "rgba(255,255,255,0.45)";
}

/** Draw the hands/wrist position dot in the plane-result color. Radius scales with plane closeness (0=on … 3=way off). */
function drawWristDot(c, nx, ny, W, H, color, radiusPx = 10) {
  c.beginPath();
  c.arc(nx * W, ny * H, radiusPx, 0, Math.PI * 2);
  c.fillStyle   = color;
  c.fill();
  c.strokeStyle = "rgba(255,255,255,0.80)";
  c.lineWidth   = 2;
  c.stroke();
}

function render() {
  const r = el.stage.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  const HR = 7; // handle radius

  for (const l of state.lines) {
    drawLineOnCtx(ctx, l, r.width, r.height, l.id === state.selectedId, HR);
  }

  if (state.view === "side") {
    drawLineOnCtx(ctx, state.swingPlaneLine.line, r.width, r.height, false, HR);

    if (state.pose.lastWristNorm) {
      const color = planeResultWristFill(state.pose.planeResult);
      const lv = state.pose.planeLevel;
      const rDot = state.pose.planeResult != null && (lv === 0 || lv === 1 || lv === 2 || lv === 3)
        ? [17, 13, 9, 6][lv]
        : 11;
      drawWristDot(ctx, state.pose.lastWristNorm.x, state.pose.lastWristNorm.y, r.width, r.height, color, rDot);
    }
  }

  renderAssessment();
}

// ── Camera ────────────────────────────────────────────────────────────────────

/**
 * Swap the start/stop button icon and aria-label without touching innerHTML of
 * the whole button (which would wipe the SVG element).
 */
function setStartStopState(running) {
  if (!el.btnStartStop) return;
  el.btnStartStop.setAttribute("aria-label", running ? "Stop camera" : "Start camera");
  el.btnStartStop.textContent = running ? "Stop Camera" : "Start Camera";
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Camera not supported in this browser.");
    return;
  }
  try {
    setStatus("Requesting camera permission…");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    state.stream    = stream;
    el.video.srcObject = stream;
    await el.video.play().catch(() => {});
    state.ready = true;

    el.btnAdd.disabled    = false;
    el.btnReset.disabled  = false;
    el.btnRecord.disabled = false;
    el.fps.disabled       = false;
    if (el.btnRecalibrate) el.btnRecalibrate.disabled = (state.view !== "side");
    setStartStopState(true);
    setStatus(`Live (${state.lines.length} line${state.lines.length === 1 ? "" : "s"})`);
    resizeCanvasToStage();
    render();

    bumpUiActivity();
    setDrawerOpen(true); // reveal controls briefly so user sees live state
    if (!localStorage.getItem(STORAGE_HELP)) el.help.classList.add("show");

    initPose(); // silently no-ops if TF.js didn't load
  } catch (err) {
    const name = err && typeof err === "object" && "name" in err ? String(err.name) : "Error";
    setStatus(`Camera error: ${name}. Use HTTPS and allow camera.`);
  }
}

function hideCountdownOverlay() {
  el.countdown.classList.remove("show");
  el.countdown.setAttribute("aria-hidden", "true");
  if (el.countdownNum) el.countdownNum.textContent = "";
  if (el.countdownHint) {
    el.countdownHint.textContent = "";
    el.countdownHint.hidden = true;
  }
}

function stopCamera() {
  if (!state.stream) return;
  state.pose.recalibrateCountdown = false;
  hideCountdownOverlay();
  for (const t of state.stream.getTracks()) t.stop();
  state.stream = null;
  state.ready  = false;
  el.btnAdd.disabled    = true;
  el.btnReset.disabled  = true;
  el.btnRecord.disabled = true;
  el.btnStopRec.disabled = true;
  el.fps.disabled        = true;
  if (el.btnRecalibrate) el.btnRecalibrate.disabled = true;
  setStartStopState(false);
  setStatus("Camera stopped");
  setHudHidden(false);
  setDrawerOpen(true);
  stopPoseLoop();
  render();
}

// ── Pointer events ────────────────────────────────────────────────────────────

function onPointerDown(e) {
  if (!state.ready) return;
  if (e.button !== undefined && e.button !== 0) return;

  const { nx, ny } = clientToNormalized(e.clientX, e.clientY);
  const hit = hitTest(nx, ny);
  if (!hit) { selectLine(null); return; }

  const baseLine = (() => { const l = state.lines.find((l) => l.id === hit.lineId); return l ? { ...l } : null; })();
  if (!baseLine) return;

  selectLine(hit.lineId);
  state.drag = { lineId: hit.lineId, mode: hit.mode, startNx: nx, startNy: ny, base: baseLine };
  el.canvas.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  if (!state.drag) return;
  const d  = state.drag;
  const { nx, ny } = clientToNormalized(e.clientX, e.clientY);
  const dx = nx - d.startNx, dy = ny - d.startNy;
  const b  = d.base;

  state.lines = state.lines.map((l) => {
    if (l.id !== d.lineId) return l;
    if (d.mode === "end1") return { ...l, x1: clamp01(b.x1 + dx), y1: clamp01(b.y1 + dy) };
    if (d.mode === "end2") return { ...l, x2: clamp01(b.x2 + dx), y2: clamp01(b.y2 + dy) };
    return { ...l, x1: clamp01(b.x1 + dx), y1: clamp01(b.y1 + dy), x2: clamp01(b.x2 + dx), y2: clamp01(b.y2 + dy) };
  });
  render();
}

function onPointerUp(e) {
  if (!state.drag) return;
  saveLinesForView(state.view);
  state.drag = null;
  try { el.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
}

// ── Handedness ────────────────────────────────────────────────────────────────

function setHandedness(h) {
  if (state.handedness === h) return;
  state.handedness = h;
  localStorage.setItem(STORAGE_UI, JSON.stringify({ view: state.view, fps: el.fps?.value || "30", handedness: h }));
  el.btnHandRight.classList.toggle("active", h === "right");
  el.btnHandLeft.classList.toggle("active",  h === "left");
  state.pose.stableFrames = 0;
  state.pose.planeLocked  = false;
  state.pose.planeLockHandsNorm = null;
  state.pose.planeRelockStillSince = null;
}

// ── View toggle ───────────────────────────────────────────────────────────────

function setView(view) {
  if (state.view === view) return;
  if (state.pose.recalibrateCountdown) {
    state.pose.recalibrateCountdown = false;
    hideCountdownOverlay();
  }
  state.view = view;
  localStorage.setItem(STORAGE_UI, JSON.stringify({ view: state.view, fps: el.fps?.value || "30", handedness: state.handedness }));
  el.btnViewFront.classList.toggle("active", view === "front");
  el.btnViewSide.classList.toggle("active",  view === "side");
  if (el.btnRecalibrate) el.btnRecalibrate.disabled = !(state.ready && view === "side");
  loadLinesForView(view);
  selectLine(null);
  resetPoseState();
  setStatus(state.ready ? `Live (${state.lines.length} line${state.lines.length === 1 ? "" : "s"})` : "Tap Start camera");
  render();
}

// ── Recording ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Full-screen numeric countdown (recording start, re-calibrate, etc.).
 * @param {number} seconds
 * @param {{ hint?: string, shouldAbort?: () => boolean }} [opts]
 */
async function showCountdown(seconds, opts = {}) {
  const hint        = opts.hint ?? "";
  const shouldAbort = opts.shouldAbort ?? (() => false);

  el.countdown.classList.add("show");
  el.countdown.setAttribute("aria-hidden", "false");
  if (el.countdownHint) {
    el.countdownHint.textContent = hint;
    el.countdownHint.hidden = !hint;
  }

  try {
    for (let s = seconds; s >= 1; s--) {
      if (shouldAbort()) return;
      if (el.countdownNum) el.countdownNum.textContent = String(s);
      await sleep(1000);
    }
  } finally {
    hideCountdownOverlay();
  }
}

/** Collapse UI, show a short countdown, then unlock the swing-plane line for a fresh address capture. */
async function runRecalibrateCountdown() {
  if (!state.ready || state.view !== "side" || state.recording.active) return;
  if (state.pose.recalibrateCountdown) return;

  state.pose.recalibrateCountdown = true;
  state.ui.lastActiveAt = Date.now();
  setDrawerOpen(false);
  setHudHidden(true);
  el.btnRecalibrate.disabled = true;

  try {
    await showCountdown(5, {
      hint: "Return to your stance — controls stay hidden until the count finishes.",
      shouldAbort: () => !state.ready || !state.pose.recalibrateCountdown,
    });
  } finally {
    state.pose.recalibrateCountdown = false;
    if (el.btnRecalibrate) {
      el.btnRecalibrate.disabled = !(state.ready && state.view === "side");
    }
  }

  if (!state.ready || state.view !== "side") return;

  state.pose.stableFrames = 0;
  state.pose.planeLocked  = false;
  state.pose.planeLockHandsNorm = null;
  state.pose.planeRelockStillSince = null;
  setStatus("Re-calibrating — stand at address…");
  state.ui.lastActiveAt = Date.now();
  setHudHidden(false);
}

function ensureCompositeCanvas() {
  if (state.recording.compositeCanvas && state.recording.compositeCtx) return;
  const c    = document.createElement("canvas");
  const cctx = c.getContext("2d");
  if (!cctx) throw new Error("Composite canvas context unavailable");
  state.recording.compositeCanvas = c;
  state.recording.compositeCtx    = cctx;
}

function drawCompositeFrame() {
  const c    = state.recording.compositeCanvas;
  const cctx = state.recording.compositeCtx;
  if (!c || !cctx) return;
  const r = el.stage.getBoundingClientRect();
  // iOS H.264 wants even dimensions
  let w = Math.max(2, Math.round(r.width)),  h = Math.max(2, Math.round(r.height));
  if (w % 2) w -= 1;
  if (h % 2) h -= 1;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }

  cctx.clearRect(0, 0, w, h);
  drawVideoCover(cctx, el.video, w, h, { mirrorX: true });

  const HR = 7;
  for (const l of state.lines) {
    drawLineOnCtx(cctx, l, w, h, l.id === state.selectedId, HR);
  }

  if (state.view === "side") {
    drawLineOnCtx(cctx, state.swingPlaneLine.line, w, h, state.selectedId === "swingplane", HR);
    if (state.pose.lastWristNorm) {
      const color = planeResultWristFill(state.pose.planeResult);
      const lv = state.pose.planeLevel;
      const rDot = state.pose.planeResult != null && (lv === 0 || lv === 1 || lv === 2 || lv === 3)
        ? [17, 13, 9, 6][lv]
        : 11;
      drawWristDot(cctx, state.pose.lastWristNorm.x, state.pose.lastWristNorm.y, w, h, color, rDot);
    }
  }
}

function startCompositeLoop() {
  const loop = () => { drawCompositeFrame(); state.recording.raf = requestAnimationFrame(loop); };
  loop();
}

function stopCompositeLoop() {
  if (state.recording.raf != null) cancelAnimationFrame(state.recording.raf);
  state.recording.raf = null;
}

function pickMimeType() {
  const candidates = [
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    'video/webm;codecs="vp9,opus"',
    'video/webm;codecs="vp8,opus"',
    "video/webm",
  ];
  for (const t of candidates) { if (MediaRecorder.isTypeSupported(t)) return t; }
  return "";
}

async function startRecording() {
  if (!state.ready || state.recording.active) return;
  ensureCompositeCanvas();
  const fps = Number(el.fps.value) || 30;
  await showCountdown(5);

  state.recording.active = true;
  setHudHidden(true);
  setDrawerOpen(false);
  el.hudBottom?.classList.add("recording");
  el.btnStopFloat.classList.add("show");
  el.btnStopFloat.disabled  = false;
  el.btnStopRec.disabled    = false;
  el.btnRecord.disabled     = true;
  el.btnAdd.disabled        = true;
  el.btnDelete.disabled     = true;
  el.btnReset.disabled      = true;
  el.btnStartStop.disabled  = true;
  el.fps.disabled           = true;
  el.btnViewFront.disabled  = true;
  el.btnViewSide.disabled   = true;
  if (el.btnRecalibrate) el.btnRecalibrate.disabled = true;

  if (state.recording.lastUrl) { URL.revokeObjectURL(state.recording.lastUrl); state.recording.lastUrl = null; }
  state.recording.chunks = [];

  startCompositeLoop();
  const stream   = state.recording.compositeCanvas.captureStream(fps);
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) state.recording.chunks.push(e.data); };
  recorder.onstop = () => {
    stopCompositeLoop();
    for (const t of stream.getTracks()) t.stop();

    const blob = new Blob(state.recording.chunks, { type: recorder.mimeType || "video/webm" });
    const url  = URL.createObjectURL(blob);
    state.recording.lastUrl = url;

    const ext = (recorder.mimeType || "").includes("mp4") ? "mp4" : "webm";
    const a   = document.createElement("a");
    a.href = url; a.download = `golfcam-${state.view}-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
    document.body.appendChild(a); a.click(); a.remove();

    state.recording.active = false;
    el.hudBottom?.classList.remove("recording");
    setHudHidden(false);
    setDrawerOpen(true);
    el.btnStopFloat.classList.remove("show");
    el.btnStopFloat.disabled = true;
    el.btnStopRec.disabled   = true;
    el.btnRecord.disabled    = false;
    el.btnAdd.disabled       = false;
    el.btnReset.disabled     = false;
    el.btnStartStop.disabled = false;
    el.fps.disabled          = false;
    el.btnViewFront.disabled = false;
    el.btnViewSide.disabled  = false;
    el.btnDelete.disabled    = !state.selectedId;
    if (el.btnRecalibrate) el.btnRecalibrate.disabled = !(state.ready && state.view === "side");

    bumpUiActivity();
    setStatus(`Saved (${ext.toUpperCase()})`);
  };

  state.recording.recorder = recorder;
  setStatus("Recording…");
  recorder.start(250);
}

function stopRecording() {
  const r = state.recording.recorder;
  if (!r || r.state === "inactive") return;
  setStatus("Stopping…");
  r.stop();
}

// ── Pose / MoveNet ────────────────────────────────────────────────────────────

/**
 * Convert a MoveNet keypoint (raw video pixel coords) into overlay-canvas
 * normalized coords (0..1), accounting for object-fit:cover crop and the
 * CSS scaleX(-1) mirror applied to the video element.
 */
function movenetToOverlay(kpX, kpY) {
  const vw = el.video.videoWidth  || 1;
  const vh = el.video.videoHeight || 1;
  const r  = el.stage.getBoundingClientRect();
  const destAR = r.width / r.height;
  const srcAR  = vw / vh;

  let sx = 0, sy = 0, sw = vw, sh = vh;
  if (srcAR > destAR) {
    sw = Math.round(vh * destAR); sx = Math.round((vw - sw) / 2);
  } else {
    sh = Math.round(vw / destAR); sy = Math.round((vh - sh) / 2);
  }

  // Mirror X to match CSS scaleX(-1) on the video element
  return {
    nx: clamp01(1 - (kpX - sx) / sw),
    ny: clamp01((kpY - sy) / sh),
  };
}

function resetPoseState() {
  state.pose.wristHistory  = [];
  state.pose.phase         = "address";
  state.pose.prevPhase     = "address";
  state.pose.planeResult   = null;
  state.pose.planeLevel    = null;
  state.pose.lastWristNorm = null;
  state.pose.lastGoodAt    = 0;
  state.pose.addressWristY = null;
  state.pose.addressWristX = null;
  state.pose.stableFrames  = 0;
  state.pose.backswingLog  = [];
  state.pose.downswingLog  = [];
  state.pose.backswingLevelLog = [];
  state.pose.downswingLevelLog = [];
  state.pose.swingCompleted = false;
  state.pose.shoulderNy     = null;
  state.pose.planeLocked    = false;
  state.pose.planeLockHandsNorm = null;
  state.pose.planeRelockStillSince = null;
  state.pose.recalibrateCountdown = false;
  state.pose.sawTopThisSwing = false;
  state.pose.backswingConsecutiveFrames = 0;
  state.pose.swingStartGateNy = null;
  dismissSwingSummary();
}

/**
 * Initialise MoveNet detector. Silently skips if TF.js / pose-detection
 * libraries didn't load (e.g. offline, script error).
 */
async function initPose() {
  if (typeof poseDetection === "undefined" || typeof tf === "undefined") return;
  try {
    await tf.ready();
    if (!state.ready) return; // camera stopped while backend was loading
    state.pose.detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING, enableSmoothing: true }
    );
    if (!state.ready) return; // camera stopped while model weights were downloading
    state.pose.active = true;
    resetPoseState();
    poseLoop();
  } catch (err) {
    console.warn("Pose detection init failed:", err);
  }
}

function stopPoseLoop() {
  state.pose.active = false;
  if (state.pose.rafHandle != null) cancelAnimationFrame(state.pose.rafHandle);
  state.pose.rafHandle     = null;
  state.pose.lastWristNorm = null;
  state.pose.planeResult   = null;
  dismissSwingSummary();
  renderAssessment();
  render();
}

/** rAF loop — runs MoveNet inference every 3rd frame to keep UI smooth. */
function poseLoop() {
  if (!state.pose.active) return;
  state.pose.rafHandle = requestAnimationFrame(async () => {
    state.pose.frameCount++;
    if (state.pose.frameCount % 3 === 0 && !state.pose.inferring) {
      state.pose.inferring = true;
      try { await runPoseInference(); } catch { /* ignore */ }
      state.pose.inferring = false;
    }
    poseLoop();
  });
}

async function runPoseInference() {
  if (!state.pose.detector || !state.ready) return;
  if (!el.video.videoWidth || !el.video.videoHeight) return;

  // Always run inference (not only Side view) so phase resets cleanly on view switch.
  const poses = await state.pose.detector.estimatePoses(el.video, { flipHorizontal: false });
  const now   = Date.now();

  if (!poses || poses.length === 0) {
    if (now - state.pose.lastGoodAt > 600) {
      state.pose.lastWristNorm = null;
      state.pose.planeResult   = null;
      state.pose.frameGuide    = null;
      render(); renderAssessment(); renderFrameGuide();
    }
    return;
  }

  const kps      = poses[0].keypoints;
  const MIN_CONF = 0.35;
  const lw = kps[9], rw = kps[10]; // left_wrist, right_wrist
  const lwOk = lw && lw.score >= MIN_CONF;
  const rwOk = rw && rw.score >= MIN_CONF;

  if (!lwOk && !rwOk) {
    if (now - state.pose.lastGoodAt > 600) {
      state.pose.lastWristNorm = null;
      state.pose.planeResult   = null;
      state.pose.frameGuide    = null;
      render(); renderAssessment(); renderFrameGuide();
    }
    return;
  }

  state.pose.lastGoodAt = now;

  // Hands midpoint in overlay coords
  let handsNorm;
  if (lwOk && rwOk) {
    const lo = movenetToOverlay(lw.x, lw.y);
    const ro = movenetToOverlay(rw.x, rw.y);
    handsNorm = { x: (lo.nx + ro.nx) / 2, y: (lo.ny + ro.ny) / 2 };
  } else {
    const o = movenetToOverlay(lwOk ? lw.x : rw.x, lwOk ? lw.y : rw.y);
    handsNorm = { x: o.nx, y: o.ny };
  }
  state.pose.lastWristNorm = handsNorm;

  // ── Phase detection ───────────────────────────────────────────────────────
  const prevPhase = state.pose.phase;
  detectPhase(handsNorm, now);

  // ── Plane-displacement gate (side view, locked plane) ─────────────────────
  // If hands have moved a meaningful distance upward along the swing plane from
  // the address position, count that as a backswing regardless of Y-only velocity.
  // This covers slow/diagonal takeaways that don't show strong pure vertical speed.
  if (
    state.view === "side"
    && state.pose.planeLocked
    && state.pose.phase === "address"
    && state.pose.addressWristX !== null
    && state.pose.addressWristY !== null
  ) {
    const sp = state.swingPlaneLine.line;
    const pdx = sp.x1 - sp.x2; // plane direction toward top (upward-along-plane)
    const pdy = sp.y1 - sp.y2; // negative (y increases downward)
    const plen = Math.hypot(pdx, pdy);
    if (plen > 0.01) {
      const proj =
        ((handsNorm.x - state.pose.addressWristX) * pdx +
          (handsNorm.y - state.pose.addressWristY) * pdy) /
        plen;
      // 0.04 norm units along the plane ≈ ~2-3 cm real-world at typical camera distance.
      if (proj > 0.04) state.pose.phase = "backswing";
    }
  }

  const newPhase = state.pose.phase;
  state.pose.prevPhase = newPhase;

  if (newPhase === "backswing") state.pose.backswingConsecutiveFrames++;
  else state.pose.backswingConsecutiveFrames = 0;

  // Phase transition bookkeeping
  if (prevPhase !== newPhase) {
    if (prevPhase !== "top" && newPhase === "top") state.pose.sawTopThisSwing = true;

    if (newPhase === "address") {
      // Full swing only: summary + monitor summary message (not live plane flicker).
      if (!state.pose.swingCompleted && isFullSwingForSummary()) {
        triggerSwingSummary();
      }
      // Reset accumulators for the next swing.
      // Clear address reference so the plane-displacement gate re-establishes
      // from the user's actual next address position, not the drifted follow-through.
      state.pose.backswingLog  = [];
      state.pose.downswingLog  = [];
      state.pose.backswingLevelLog = [];
      state.pose.downswingLevelLog = [];
      state.pose.swingCompleted = false;
      state.pose.sawTopThisSwing = false;
      state.pose.addressWristX = null;
      state.pose.addressWristY = null;
      state.pose.wristHistory  = [];
    }
    if (newPhase === "impact" && !state.pose.swingCompleted && isFullSwingForSummary()) {
      triggerSwingSummary();
    }
  }

  // ── Frame-fill guide (side view only) ────────────────────────────────────
  if (state.view === "side") {
    const GUIDE_CONF = 0.30;
    const nose = kps[0];
    const lh = kps[11], rh = kps[12]; // hips
    const noseOk = nose && nose.score >= GUIDE_CONF;
    const hipOk  = (lh && lh.score >= GUIDE_CONF) || (rh && rh.score >= GUIDE_CONF);

    if (!lwOk && !rwOk) {
      state.pose.frameGuide = "raise-club";
    } else if (noseOk) {
      const noseNy = movenetToOverlay(nose.x, nose.y).ny;
      // "Step back" = move away from the lens. Old `noseNy > 0.3` fired when the nose
      // sat *lower* in frame — typical when you are *farther* from the camera (inverted).
      // Only warn when the nose crowds the very top of the frame (likely clipping / too close).
      const stepBack = noseNy < 0.088;
      if (stepBack) {
        state.pose.frameGuide = "step-back";
      } else if (hipOk) {
        const hipNy = (() => {
          const pts = [lh, rh].filter((k) => k && k.score >= GUIDE_CONF);
          const sum = pts.reduce((s, k) => s + movenetToOverlay(k.x, k.y).ny, 0);
          return sum / pts.length;
        })();
        state.pose.frameGuide = hipNy < 0.35 ? "step-closer" : null;
      } else {
        state.pose.frameGuide = null;
      }
    } else {
      state.pose.frameGuide = null;
    }
  } else {
    state.pose.frameGuide = null;
  }

  // ── Stable-frame counter, shoulder tracking + plane line proposal ────────────
  // The line updates while at address until it has settled (planeLocked = true).
  // Once locked it stays fixed during the swing; manual re-calibrate / club change unlocks.
  // After a stance shift (hands drift from lock pose), ~2 s still at address re-unlocks so
  // the line can snap to the new position without tapping re-calibrate.
  const LOCK_FRAMES = 15; // ~1.5 s at 10 pose-fps
  const PLANE_RELOCK_STILL_MS = 2000;
  const PLANE_LOCK_DRIFT_NORM = 0.012; // ~1.2% of frame — small stance / foot change still counts
  const wasPlaneLocked = state.pose.planeLocked;
  if (newPhase === "address") {
    state.pose.stableFrames++;
    if (!state.pose.planeLocked) {
      autoProposePlaneLine(kps);
      if (state.pose.stableFrames >= LOCK_FRAMES) {
        state.pose.planeLocked = true;
        state.pose.planeLockHandsNorm = { x: handsNorm.x, y: handsNorm.y };
        state.pose.planeRelockStillSince = null;
        if (!wasPlaneLocked && state.view === "side") playReadyCue();
      }
    } else if (state.view === "side") {
      const ref = state.pose.planeLockHandsNorm;
      const drift = ref ? Math.hypot(handsNorm.x - ref.x, handsNorm.y - ref.y) : 0;
      if (drift > PLANE_LOCK_DRIFT_NORM) {
        if (state.pose.planeRelockStillSince === null) state.pose.planeRelockStillSince = now;
        else if (now - state.pose.planeRelockStillSince >= PLANE_RELOCK_STILL_MS) {
          state.pose.planeLocked = false;
          state.pose.stableFrames = 0;
          state.pose.planeLockHandsNorm = null;
          state.pose.planeRelockStillSince = null;
          autoProposePlaneLine(kps);
        }
      } else {
        state.pose.planeRelockStillSince = null;
      }
    }

    // Track shoulder height so the assessment gate knows when hands pass shoulder level.
    const ls = kps[5], rs = kps[6];
    const SHOULDER_CONF = 0.35;
    const shoulderPts = [ls, rs].filter((k) => k && k.score >= SHOULDER_CONF);
    if (shoulderPts.length > 0) {
      const avgNy = shoulderPts.reduce((s, k) => s + movenetToOverlay(k.x, k.y).ny, 0) / shoulderPts.length;
      // Slow EMA — shoulders barely move at address, so this stabilises quickly.
      state.pose.shoulderNy = state.pose.shoulderNy === null
        ? avgNy
        : state.pose.shoulderNy * 0.92 + avgNy * 0.08;
    }
  } else {
    state.pose.stableFrames = 0;
    state.pose.planeRelockStillSince = null;
  }

  // Swing start height: midpoint between address hands and shoulders (y increases downward).
  if (newPhase === "address") {
    if (state.pose.addressWristY != null && state.pose.shoulderNy != null) {
      state.pose.swingStartGateNy = (state.pose.addressWristY + state.pose.shoulderNy) / 2;
    } else if (state.pose.addressWristY != null) {
      state.pose.swingStartGateNy = state.pose.addressWristY - 0.055;
    } else {
      state.pose.swingStartGateNy = null;
    }
  }

  // ── Plane assessment (side view) ──
  // At address: assess whenever the plane line is locked (settled) so wrist dot + badge match the line.
  // In motion: gate reduces noise before shoulder / swing gate (Y increases downward → backswing = smaller y).
  const EARLY_UP_EPS = 0.03;
  const EARLY_BACKSWING_FRAMES = 3;
  const handsAboveShoulder = state.pose.shoulderNy === null
    || handsNorm.y < state.pose.shoulderNy;
  const pastSwingGate = state.pose.swingStartGateNy != null
    && handsNorm.y < state.pose.swingStartGateNy - EARLY_UP_EPS * 0.5;
  const earlyTakeawayOk = newPhase === "backswing"
    && state.pose.addressWristY != null
    && handsNorm.y < state.pose.addressWristY - EARLY_UP_EPS
    && state.pose.backswingConsecutiveFrames >= EARLY_BACKSWING_FRAMES;
  // Plane-displacement takeaway: hands have moved along the plane from address.
  const planeTakeawayOk = newPhase === "backswing"
    && state.pose.planeLocked
    && state.pose.addressWristX !== null
    && state.pose.addressWristY !== null
    && (() => {
      const sp = state.swingPlaneLine.line;
      const pdx = sp.x1 - sp.x2;
      const pdy = sp.y1 - sp.y2;
      const plen = Math.hypot(pdx, pdy);
      if (plen < 0.01) return false;
      const proj =
        ((handsNorm.x - state.pose.addressWristX) * pdx +
          (handsNorm.y - state.pose.addressWristY) * pdy) /
        plen;
      return proj > 0.025; // slightly below trigger threshold so logs open early
    })();
  const addressWithLockedPlane = newPhase === "address" && state.pose.planeLocked;

  if (state.view === "side" && state.pose.planeLocked
    && (addressWithLockedPlane || newPhase !== "address")) {
    assessPlane(handsNorm.x, handsNorm.y);
  } else {
    state.pose.planeResult = null;
    state.pose.planeLevel  = null;
  }

  // ── Collect per-swing plane logs (after assessment so result is current) ──
  // Use the same height gate as the original code to ensure hands have genuinely risen.
  // Assessment display (wrist dot, badge) stays ungated; only logging is gated here.
  const allowLog = handsAboveShoulder || pastSwingGate || earlyTakeawayOk || planeTakeawayOk;
  if (state.view === "side" && allowLog && state.pose.planeResult && state.pose.planeLevel !== null) {
    if (newPhase === "backswing" || newPhase === "top") {
      state.pose.backswingLog.push(state.pose.planeResult);
      state.pose.backswingLevelLog.push(state.pose.planeLevel);
    }
    if (newPhase === "downswing" || newPhase === "impact") {
      state.pose.downswingLog.push(state.pose.planeResult);
      state.pose.downswingLevelLog.push(state.pose.planeLevel);
    }
  }

  render();
  renderAssessment();
  renderFrameGuide();
  renderSwingDebug();
  monitorMaybeSendLive();
}

/**
 * Rolling wrist-position window phase detector (overlay-normalized coords).
 * Canvas Y increases downward: upward hand motion = decreasing Y = backswing.
 * Address requires both X and Y to be steady over the window (not only vertical).
 */
function detectPhase(handsNorm, timestamp) {
  const handsX = handsNorm.x;
  const handsY = handsNorm.y;
  const hist = state.pose.wristHistory;
  hist.push({ x: handsX, y: handsY, t: timestamp });
  if (hist.length > 12) hist.shift();
  if (hist.length < 4) return;

  const gate = state.pose.swingStartGateNy;
  const SWING_GATE_HYST = 0.007;
  if (gate != null && state.pose.phase === "address" && handsY < gate - SWING_GATE_HYST) {
    state.pose.phase = "backswing";
    return;
  }

  // Average velocity over last 5 samples (normalized Y / second)
  const recent = hist.slice(-5);
  let totalVel = 0, count = 0;
  for (let i = 1; i < recent.length; i++) {
    const dt = (recent[i].t - recent[i - 1].t) / 1000;
    if (dt > 0 && dt < 1.5) { totalVel += (recent[i].y - recent[i - 1].y) / dt; count++; }
  }
  const avgVel = count > 0 ? totalVel / count : 0;

  // Stability: std dev of X and Y over the full history window
  const allY   = hist.map((h) => h.y);
  const meanY  = allY.reduce((a, b) => a + b, 0) / allY.length;
  const stddevY = Math.sqrt(allY.reduce((acc, y) => acc + (y - meanY) ** 2, 0) / allY.length);
  const allX   = hist.map((h) => h.x);
  const meanX  = allX.reduce((a, b) => a + b, 0) / allX.length;
  const stddevX = Math.sqrt(allX.reduce((acc, x) => acc + (x - meanX) ** 2, 0) / allX.length);

  const VEL_UP   = -0.065; // normalized Y/s — backswing (eased for ~10 pose Hz)
  const VEL_DOWN =  0.065; // normalized Y/s — downswing
  const STABLE   =  0.008; // very low stddev = standing still at address (X and Y)

  const prev = state.pose.phase;

  if (stddevY < STABLE && stddevX < STABLE) {
    if (prev !== "address") state.pose.phase = "address";
    // Track address reference position (both axes) for plane-displacement gate.
    state.pose.addressWristY = state.pose.addressWristY === null
      ? handsY : state.pose.addressWristY * 0.9 + handsY * 0.1;
    state.pose.addressWristX = state.pose.addressWristX === null
      ? handsX : state.pose.addressWristX * 0.9 + handsX * 0.1;
    return;
  }

  if (avgVel < VEL_UP) {
    if (prev === "address" || prev === "backswing") state.pose.phase = "backswing";
  } else if (avgVel > VEL_DOWN) {
    if (prev === "backswing" || prev === "top") {
      state.pose.phase = "downswing";
    } else if (prev === "downswing") {
      // Hands returned near address height = impact/follow-through
      if (state.pose.addressWristY != null && handsY >= state.pose.addressWristY - 0.06) {
        state.pose.phase = "impact";
      }
    }
  } else {
    // Low Y velocity but not vertically+horizontally stable.
    // Backswing→top transition is ok here (hands pausing at peak), BUT require a minimum
    // number of consecutive backswing frames first. This prevents the plane-displacement gate
    // (which fires in 1 frame) from immediately jumping to "top" before any logs can fill.
    if (prev === "backswing" && state.pose.backswingConsecutiveFrames >= 3) {
      state.pose.phase = "top";
    }
  }
}

/**
 * Update the swing-plane line using the selected club's lie angle and the
 * tracked hands (wrist midpoint) position.
 *
 * Geometry (normalized overlay coords, y increases downward):
 *
 *   topY ────── (swing plane extends upward)
 *        ↑  shaft direction
 *      [HANDS]   ← wrist midpoint from pose
 *        ↑
 *   [CLUB HEAD]  ← where the shaft meets GROUND_Y
 *   GROUND_Y ──────────────────────────────
 *
 * Lie angle θ = angle shaft makes with the ground (horizontal).
 * In screen space (y-down), from hands toward club head:
 *   - RH golfer (trail side is LEFT in mirrored video): dx = -cos(θ), dy = +sin(θ)
 *   - LH golfer: dx = +cos(θ), dy = +sin(θ)
 *
 * EMA smoothing (α = 0.25) smooths out wrist jitter without lag.
 * localStorage writes are throttled to every 10 stable frames.
 */
function autoProposePlaneLine(keypoints) {
  const MIN_CONF = 0.35;
  const lw = keypoints[9], rw = keypoints[10]; // wrists
  const lwOk = lw && lw.score >= MIN_CONF;
  const rwOk = rw && rw.score >= MIN_CONF;
  if (!lwOk && !rwOk) return;

  // Hands midpoint in overlay space
  const toO = (kp) => movenetToOverlay(kp.x, kp.y);
  let handsNx, handsNy;
  if (lwOk && rwOk) {
    const lo = toO(lw), ro = toO(rw);
    handsNx = (lo.nx + ro.nx) / 2;
    handsNy = (lo.ny + ro.ny) / 2;
  } else {
    const o = toO(lwOk ? lw : rw);
    handsNx = o.nx; handsNy = o.ny;
  }

  // Estimate ground level from ankle keypoints; fall back to the GROUND_Y constant.
  // Only the Y coordinate is used here — the ankles tell us where the feet are in
  // the frame, which is the actual ground reference, regardless of camera distance.
  const la = keypoints[15], ra = keypoints[16];
  const ANKLE_CONF = 0.30;
  const anklePoints = [la, ra].filter((k) => k && k.score >= ANKLE_CONF);
  const groundNy = anklePoints.length > 0
    ? anklePoints.reduce((s, k) => s + movenetToOverlay(k.x, k.y).ny, 0) / anklePoints.length
    : GROUND_Y;

  // Hands must be above the ground reference; otherwise the frame isn't usable.
  if (handsNy >= groundNy - 0.05) return;

  const club = CLUBS.find((c) => c.id === state.selectedClub) ?? CLUBS[8]; // default 7i
  const θ    = (club.lieAngle + CLUB_LIE_OFFSET) * Math.PI / 180;

  // Horizontal sign: RH → club head is LEFT of hands (trail side after mirror)
  const sign = state.handedness === "right" ? -1 : 1;

  // Unit vector from hands toward club head (downward along shaft)
  const ux = sign * Math.cos(θ);  // horizontal component (left or right)
  const uy = Math.sin(θ);         // vertical component (always downward, +y)

  // Club head: follow shaft from hands down to the ankle-derived ground level
  const tGround   = (groundNy - handsNy) / uy;
  const clubHeadX = clamp01(handsNx + ux * tGround);

  // Top of line: extend shaft upward from hands to topY
  const topY = 0.10;
  const tTop = (handsNy - topY) / uy;
  const topX = clamp01(handsNx - ux * tTop);

  // EMA blend (α = 0.25 → settles in ~4 frames ≈ 0.4 s at 10 pose-fps)
  const EMA = 0.25;
  const cur = state.swingPlaneLine.line;

  if (state.pose.stableFrames <= 1) {
    state.swingPlaneLine.line = { ...cur, x1: topX, y1: topY, x2: clubHeadX, y2: groundNy };
  } else {
    state.swingPlaneLine.line = {
      ...cur,
      x1: cur.x1 + (topX      - cur.x1) * EMA,
      y1: topY,
      x2: cur.x2 + (clubHeadX - cur.x2) * EMA,
      y2: cur.y2 + (groundNy  - cur.y2) * EMA,
    };
  }

  if (state.pose.stableFrames % 10 === 0) saveSwingPlaneLine();
}

/**
 * Assess whether hands are above / on / below the swing-plane line.
 *
 * Uses the 2D signed perpendicular distance (cross product).
 * d > 0  → hands are above the plane line (steeper = "above plane" in golf)
 * d < 0  → hands are below the plane line (flatter  = "below plane")
 */
function assessPlane(handsNormX, handsNormY) {
  const sp  = state.swingPlaneLine.line;
  const dx  = sp.x2 - sp.x1, dy = sp.y2 - sp.y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.01) return;

  const d  = (dx * (handsNormY - sp.y1) - dy * (handsNormX - sp.x1)) / len;
  // Tighter band than before so address / small moves read above vs below more readily.
  const TH = 0.026;

  const abs = Math.abs(d);
  const level = abs <= TH ? 0 : abs <= TH * 2 ? 1 : abs <= TH * 3.5 ? 2 : 3;
  state.pose.planeLevel = /** @type {0|1|2|3} */ (level);
  state.pose.planeResult = d > TH ? "above" : d < -TH ? "below" : "on";
}

// ── Swing summary overlay ─────────────────────────────────────────────────────

/** Compute the most-common result in a log array. */
function dominantResult(log) {
  if (!log || log.length === 0) return null;
  const counts = { above: 0, on: 0, below: 0 };
  for (const r of log) { if (r in counts) counts[r]++; }
  return /** @type {"above"|"on"|"below"} */ (Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
}

/** Compute the most-common closeness level (0..3) in a log array. */
function dominantLevel(log) {
  if (!log || log.length === 0) return null;
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const v of log) {
    const n = Number(v);
    if (n === 0 || n === 1 || n === 2 || n === 3) counts[n]++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  return best === undefined ? null : Number(best);
}

/** Min samples for summary. A real swing at ~10 pose-fps yields 5–10 per half;
 *  4 is safe even for fast swings while blocking 2–3 frame lateral-drift glitches. */
const FULL_SWING_DOWN_SAMPLES = 2;
const FULL_SWING_BACK_SAMPLES = 2;

function isFullSwingForSummary() {
  const d = state.pose.downswingLog.length;
  const b = state.pose.backswingLog.length;
  // sawTopThisSwing is mandatory: a real swing always passes through a velocity
  // reversal at the top. This prevents lateral drift / waggle from qualifying.
  return d >= FULL_SWING_DOWN_SAMPLES
    && b >= FULL_SWING_BACK_SAMPLES
    && state.pose.sawTopThisSwing;
}

function triggerSwingSummary() {
  if (!isFullSwingForSummary()) return;
  if (isMenuShowing()) return;
  state.pose.swingCompleted = true;
  const backswing = dominantResult(state.pose.backswingLog);
  const downswing = dominantResult(state.pose.downswingLog);
  const backswingLevel = dominantLevel(state.pose.backswingLevelLog);
  const downswingLevel = dominantLevel(state.pose.downswingLevelLog);
  monitorSendSummary(backswing, downswing, backswingLevel, downswingLevel);
  showSwingSummary(backswing, downswing, backswingLevel, downswingLevel);
  const worstLevel =
    backswingLevel === 3 || downswingLevel === 3 ? 3
      : backswingLevel === 2 || downswingLevel === 2 ? 2
        : backswingLevel === 1 || downswingLevel === 1 ? 1
          : backswingLevel === 0 || downswingLevel === 0 ? 0
            : null;
  playSwingSummarySound({ worstLevel });
}

/**
 * Show the 5-second post-swing summary overlay.
 * @param {"above"|"on"|"below"|null} backswing
 * @param {"above"|"on"|"below"|null} downswing
 * @param {number|null} backswingLevel
 * @param {number|null} downswingLevel
 */
function showSwingSummary(backswing, downswing, backswingLevel, downswingLevel) {
  if (!el.swingSummary) return;
  if (isMenuShowing()) { dismissSwingSummary(); return; }
  dismissSwingSummary(); // clear any running timer first

  const phaseCard = (title, plane, level) => {
    const has =
      (plane === "above" || plane === "on" || plane === "below")
      && (level === 0 || level === 1 || level === 2 || level === 3);
    const r = plane === "above" || plane === "on" || plane === "below" ? plane : "unknown";
    if (!has) {
      return `<div class="sswPhaseCard unknown">
      <div class="sswPhaseName">${title}</div>
      <div class="sswPhaseIcon unknown">?</div>
      <div class="sswPhaseResult">No data</div>
    </div>`;
    }
    const icon = displayGlyph(plane, level);
    const label = displayPhrase(plane, level);
    const tri = glyphIsTriangle(plane, level);
    const sc = displayScale(level, tri);
    return `<div class="sswPhaseCard ${r}">
      <div class="sswPhaseName">${title}</div>
      <div class="sswPhaseIcon ${r}" style="transform: scale(${sc}); transform-origin: center">${icon}</div>
      <div class="sswPhaseResult">${label}</div>
    </div>`;
  };

  el.swingSummary.innerHTML = `
    <div class="sswCard">
      <div class="sswTitle">Swing Analysis</div>
      <div class="sswRow">
        ${phaseCard("Backswing", backswing, backswingLevel)}
        <div class="sswDivider"></div>
        ${phaseCard("Downswing", downswing, downswingLevel)}
      </div>
      <div class="sswDismiss" id="sswDismissLabel">Tap to dismiss · 5s</div>
    </div>`;

  el.swingSummary.classList.add("show");

  // 5-second countdown, updating the label each second
  let remaining = 5;
  const tick = () => {
    remaining--;
    const label = el.swingSummary?.querySelector("#sswDismissLabel");
    if (label) label.textContent = remaining > 0 ? `Tap to dismiss · ${remaining}s` : "";
    if (remaining <= 0) { dismissSwingSummary(); return; }
    state.pose.summaryTimerHandle = setTimeout(tick, 1000);
  };
  state.pose.summaryTimerHandle = setTimeout(tick, 1000);
}

function dismissSwingSummary() {
  if (state.pose.summaryTimerHandle != null) {
    clearTimeout(state.pose.summaryTimerHandle);
    state.pose.summaryTimerHandle = null;
  }
  if (el.swingSummary) el.swingSummary.classList.remove("show");
}

/** Update the assessment badge and club detection badge DOM elements. */
function renderAssessment() {
  if (!el.assessment) return;

  const summaryOpen = el.swingSummary?.classList.contains("show") ?? false;
  const show = state.view === "side" && state.ready && state.pose.lastWristNorm !== null && !summaryOpen && !isMenuShowing();

  if (!show) {
    el.assessment.classList.remove("show", "above", "on", "below", "planeL0", "planeL1", "planeL2", "planeL3");
    el.clubBadge?.classList.remove("show");
    return;
  }

  // ── Plane assessment ───────────────────────────────────────────────────────
  const phaseLabel = { address: "Address", backswing: "Backswing", top: "Top", downswing: "Downswing", impact: "Impact" }[state.pose.phase] ?? state.pose.phase;
  const lv = state.pose.planeLevel;
  const phrase =
    (lv === 0 || lv === 1 || lv === 2 || lv === 3)
      ? displayPhrase(state.pose.planeResult, lv)
      : "No reading";

  el.assessment.classList.add("show");
  el.assessment.classList.toggle("above", state.pose.planeResult === "above");
  el.assessment.classList.toggle("on",    state.pose.planeResult === "on");
  el.assessment.classList.toggle("below", state.pose.planeResult === "below");
  el.assessment.classList.toggle("planeL0", lv === 0);
  el.assessment.classList.toggle("planeL1", lv === 1);
  el.assessment.classList.toggle("planeL2", lv === 2);
  el.assessment.classList.toggle("planeL3", lv === 3);
  el.assessment.innerHTML =
    `<span class="assessPhase">${phaseLabel}</span>` +
    `<span class="assessPlane">${phrase}</span>`;
}

// ── Swing-detection debug overlay ──────────────────────────────────────────
let _swingDebugOn = false;

/** Toggle the debug overlay on/off (called from the console or a button). */
function toggleSwingDebug() {
  _swingDebugOn = !_swingDebugOn;
  if (el.swingDebug) el.swingDebug.style.display = _swingDebugOn ? "block" : "none";
}
// Expose globally so it can be called from browser console
/** @ts-ignore */
window.toggleSwingDebug = toggleSwingDebug;

/** Render swing detection state into the debug overlay (no-op when hidden). */
function renderSwingDebug() {
  if (!_swingDebugOn || !el.swingDebug) return;
  const p = state.pose;
  const sp = state.swingPlaneLine.line;
  // Recompute plane projection if references are set
  let proj = "—";
  if (p.addressWristX !== null && p.addressWristY !== null && p.lastWristNorm) {
    const pdx = sp.x1 - sp.x2, pdy = sp.y1 - sp.y2;
    const plen = Math.hypot(pdx, pdy);
    if (plen > 0.01) {
      const raw = ((p.lastWristNorm.x - p.addressWristX) * pdx +
                   (p.lastWristNorm.y - p.addressWristY) * pdy) / plen;
      proj = raw.toFixed(3);
    }
  }
  const need = `B≥${FULL_SWING_BACK_SAMPLES} D≥${FULL_SWING_DOWN_SAMPLES}`;
  el.swingDebug.textContent = [
    `Phase:  ${p.phase.padEnd(10)} bCons:${p.backswingConsecutiveFrames}`,
    `Logs:   back=${p.backswingLog.length}  down=${p.downswingLog.length}  (need ${need})`,
    `sawTop: ${p.sawTopThisSwing}   locked:${p.planeLocked}`,
    `addrX:  ${p.addressWristX?.toFixed(3) ?? "null"}  addrY:${p.addressWristY?.toFixed(3) ?? "null"}`,
    `planePrj: ${proj}  (trigger>0.04)`,
    `gate:   ${p.swingStartGateNy?.toFixed(3) ?? "null"}  shoulder:${p.shoulderNy?.toFixed(3) ?? "null"}`,
    `▶ tap console: toggleSwingDebug() to hide`,
  ].join("\n");
}

/** Update the frame-fill guide badge. */
function renderFrameGuide() {
  if (!el.frameGuide) return;
  if (isMenuShowing()) {
    el.frameGuide.classList.remove("show");
    return;
  }
  const guide = state.pose.frameGuide;
  const messages = {
    "step-back":    "STEP BACK\nSo your head and feet fit in frame",
    "step-closer":  "STEP CLOSER\nSo we can see your hips and feet",
    "raise-club":   "RAISE THE CLUB\nSo your hands show in frame",
  };
  if (guide && messages[guide]) {
    el.frameGuide.textContent = messages[guide];
    el.frameGuide.classList.add("show");
  } else {
    el.frameGuide.classList.remove("show");
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init() {
  try {
    const ui = JSON.parse(localStorage.getItem(STORAGE_UI) || "{}");
    if (ui.view === "front" || ui.view === "side")     state.view       = ui.view;
    if (ui.fps  === "30"    || ui.fps  === "60")       el.fps.value     = ui.fps;
    if (ui.handedness === "right" || ui.handedness === "left") state.handedness = ui.handedness;
  } catch { /* ignore */ }

  // Restore selected club from storage
  try {
    const saved = localStorage.getItem(STORAGE_CLUB);
    if (saved && CLUBS.some((c) => c.id === saved)) state.selectedClub = saved;
  } catch { /* ignore */ }

  // Populate club selector from CLUBS array
  if (el.clubSelect) {
    CLUBS.forEach((club) => {
      const opt = document.createElement("option");
      opt.value = club.id;
      opt.textContent = club.label;
      el.clubSelect.appendChild(opt);
    });
    el.clubSelect.value = state.selectedClub;
    el.clubSelect.addEventListener("change", () => {
      state.selectedClub = el.clubSelect.value;
      try { localStorage.setItem(STORAGE_CLUB, state.selectedClub); } catch { /* ignore */ }
      state.pose.stableFrames = 0;
      state.pose.planeLocked  = false;
      state.pose.planeLockHandsNorm = null;
      state.pose.planeRelockStillSince = null;
    });
  }

  loadLinesForView(state.view);
  loadSwingPlaneLine();

  el.btnViewFront.classList.toggle("active", state.view === "front");
  el.btnViewSide.classList.toggle("active",  state.view === "side");
  el.btnHandRight.classList.toggle("active", state.handedness === "right");
  el.btnHandLeft.classList.toggle("active",  state.handedness === "left");
  setStatus("Tap Start camera");

  document.addEventListener(
    "pointerdown",
    () => { void primeSwingPingAudio(); },
    { once: true, capture: true, passive: true }
  );

  // Debug overlay is always on until further notice.
  toggleSwingDebug();

  el.btnStartStop.addEventListener("click",  () => (state.ready ? stopCamera() : startCamera()));
  el.btnAdd.addEventListener("click",        () => addLine());
  el.btnDelete.addEventListener("click",     () => deleteSelected());
  el.btnReset.addEventListener("click",      () => resetAll());
  el.btnViewFront.addEventListener("click",  () => setView("front"));
  el.btnViewSide.addEventListener("click",   () => setView("side"));
  el.btnHandRight.addEventListener("click",  () => setHandedness("right"));
  el.btnHandLeft.addEventListener("click",   () => setHandedness("left"));

  if (el.btnRecalibrate) {
    el.btnRecalibrate.addEventListener("click", () => { void runRecalibrateCountdown(); });
  }

  el.fps.addEventListener("change", () => {
    localStorage.setItem(STORAGE_UI, JSON.stringify({ view: state.view, fps: el.fps.value, handedness: state.handedness }));
  });
  el.btnRecord.addEventListener("click",   () => startRecording());
  el.btnStopRec.addEventListener("click",  () => stopRecording());
  el.btnStopFloat.addEventListener("click",() => stopRecording());

  el.btnDismissHelp.addEventListener("click", () => {
    localStorage.setItem(STORAGE_HELP, "1");
    el.help.classList.remove("show");
    renderAssessment();
    renderFrameGuide();
  });

  // Monitor pairing (iPhone sender)
  if (el.btnMonitorPair) {
    el.btnMonitorPair.addEventListener("click", async () => {
      monitorShowPanel(true);
      // Only generate a fresh offer if we don't already have one ready.
      if (!monitor.offerUrl) {
        try { await monitorNewOffer(); } catch { monitorSetStatus("Failed to generate link — check network."); }
      }
    });
  }
  if (el.btnMonitorClose) {
    el.btnMonitorClose.addEventListener("click", () => monitorShowPanel(false));
  }
  if (el.monitorPanel) {
    // Tap the backdrop to close.
    el.monitorPanel.addEventListener("pointerdown", (e) => {
      if (e.target === el.monitorPanel) monitorShowPanel(false);
    }, { passive: true });
  }
  el.btnMonitorShare?.addEventListener("click",        () => monitorShare().catch((e)           => monitorSetStatus(e instanceof Error ? e.message : "Share failed")));
  el.btnMonitorPasteAnswer?.addEventListener("click", () => monitorPasteAnswer().catch((e)      => monitorSetStatus(e instanceof Error ? e.message : "Paste failed")));
  el.btnMonitorUseAnswer?.addEventListener("click",   () => monitorApplyAnswer(el.monitorAnswerText?.value?.trim() ?? "").catch(() => {}));

  el.canvas.addEventListener("pointerdown",  (e) => { bumpUiActivity(); onPointerDown(e); }, { passive: true });
  el.canvas.addEventListener("pointermove",  (e) => { onPointerMove(e); }, { passive: true });
  el.canvas.addEventListener("pointerup",    (e) => { bumpUiActivity(); onPointerUp(e);   }, { passive: true });
  el.canvas.addEventListener("pointercancel",(e) => { bumpUiActivity(); onPointerUp(e);   }, { passive: true });

  window.addEventListener("resize",             resizeCanvasToStage);
  window.addEventListener("orientationchange",  () => setTimeout(resizeCanvasToStage, 150));
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopCamera(); });

  el.stage.addEventListener("pointerdown", () => bumpUiActivity(), { passive: true });

  // Tap anywhere on the summary overlay to dismiss it early
  if (el.swingSummary) {
    el.swingSummary.addEventListener("pointerdown", () => dismissSwingSummary(), { passive: true });
  }

  // ── Bottom drawer gestures ──────────────────────────────────────────────────
  if (el.hudHandle) {
    let dragStartY  = null;
    let dragDelta   = 0;

    el.hudHandle.addEventListener("touchstart", (e) => {
      dragStartY = e.touches[0].clientY;
      dragDelta  = 0;
      e.preventDefault(); // prevent scroll bleed
    }, { passive: false });

    el.hudHandle.addEventListener("touchmove", (e) => {
      if (dragStartY === null) return;
      dragDelta = dragStartY - e.touches[0].clientY; // positive = swiped up
      e.preventDefault();
    }, { passive: false });

    el.hudHandle.addEventListener("touchend", () => {
      if (dragStartY === null) return;
      const delta = dragDelta;
      dragStartY  = null;
      dragDelta   = 0;
      if (Math.abs(delta) < 8) {
        setDrawerOpen(!state.ui.drawerOpen); // tap → toggle
      } else if (delta > 20) {
        setDrawerOpen(true);                 // swipe up → expand
      } else if (delta < -20) {
        setDrawerOpen(false);                // swipe down → collapse
      }
      bumpUiActivity();
    }, { passive: true });

    // Mouse click (desktop / devtools testing)
    el.hudHandle.addEventListener("click", () => {
      setDrawerOpen(!state.ui.drawerOpen);
      bumpUiActivity();
    });

    // Keyboard (accessibility)
    el.hudHandle.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setDrawerOpen(!state.ui.drawerOpen);
        bumpUiActivity();
      }
    });
  }

  // Open drawer on first load so the user can see the Start camera button
  setDrawerOpen(true);

  setInterval(() => tickUiAutoHide(), 250);

  resizeCanvasToStage();
  render();
}

init();
