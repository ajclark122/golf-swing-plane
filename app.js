/**
 * Single-file, framework-free iPhone camera + draggable line overlay.
 * Designed for touch: drag endpoints to rotate/resize, drag body to move.
 *
 * v2 additions:
 *  - Dedicated amber swing-plane line (Side view, auto-proposed at address via MoveNet)
 *  - Pose-based phase detection (address / backswing / top / downswing / impact)
 *  - Above / on / below plane assessment with colored wrist dot + HUD badge
 */

const STORAGE_KEY_FRONT  = "golfcam.lines.front.v1";
const STORAGE_KEY_SIDE   = "golfcam.lines.side.v1";
const STORAGE_SWING_PLANE = "golfcam.swingplane.side.v1";
const STORAGE_UI   = "golfcam.ui.v1";
const STORAGE_HELP = "golfcam.helpDismissed";

/** Color used for the dedicated swing-plane line. */
const SWING_PLANE_COLOR = "#ffd44d";

/** @typedef {{id:string,x1:number,y1:number,x2:number,y2:number,color:string,width:number}} Line */

const state = {
  stream:     /** @type {MediaStream|null} */ (null),
  lines:      /** @type {Line[]} */ ([]),
  selectedId: /** @type {string|null} */ (null),
  drag: /** @type {null|{lineId:string,mode:"end1"|"end2"|"body",startNx:number,startNy:number,base:Line}} */ (null),
  ready: false,
  view: /** @type {"front"|"side"} */ ("front"),

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
    lastActiveAt: Date.now(),
    idleMs:       2000,
  },

  /**
   * Dedicated amber swing-plane line (Side view only).
   * Auto-proposed from pose at address; draggable by user.
   * dirty=true once the user has manually repositioned it.
   */
  swingPlaneLine: {
    line:  /** @type {Line} */ ({ id: "swingplane", x1: 0.70, y1: 0.25, x2: 0.35, y2: 0.72, color: SWING_PLANE_COLOR, width: 3 }),
    dirty: false,
  },

  /** MoveNet pose tracking. */
  pose: {
    detector:      /** @type {any|null} */ (null),
    active:        false,
    rafHandle:     /** @type {number|null} */ (null),
    frameCount:    0,
    inferring:     false,
    wristHistory:  /** @type {{y:number,t:number}[]} */ ([]),
    phase:         /** @type {"address"|"backswing"|"top"|"downswing"|"impact"} */ ("address"),
    prevPhase:     /** @type {"address"|"backswing"|"top"|"downswing"|"impact"} */ ("address"),
    planeResult:   /** @type {"above"|"on"|"below"|null} */ (null),
    lastWristNorm: /** @type {{x:number,y:number}|null} */ (null),
    lastGoodAt:    0,
    addressWristY: /** @type {number|null} */ (null),
    stableFrames:  0,
    // Per-swing accumulator — stores plane readings during each phase
    backswingLog:  /** @type {string[]} */ ([]),
    downswingLog:  /** @type {string[]} */ ([]),
    swingCompleted: false,
    summaryTimerHandle: /** @type {ReturnType<typeof setTimeout>|null} */ (null),
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
  fps:            /** @type {HTMLSelectElement} */ (document.getElementById("fps")),
  btnRecord:      /** @type {HTMLButtonElement} */ (document.getElementById("btnRecord")),
  btnStopRec:     /** @type {HTMLButtonElement} */ (document.getElementById("btnStopRec")),
  btnStopFloat:   /** @type {HTMLButtonElement} */ (document.getElementById("btnStopFloat")),
  countdown:      /** @type {HTMLDivElement}    */ (document.getElementById("countdown")),
  help:           /** @type {HTMLDivElement}    */ (document.getElementById("help")),
  btnDismissHelp: /** @type {HTMLButtonElement} */ (document.getElementById("btnDismissHelp")),
  assessment:     /** @type {HTMLDivElement}    */ (document.getElementById("assessment")),
  swingSummary:   /** @type {HTMLDivElement}    */ (document.getElementById("swingSummary")),
};

const ctx = el.canvas.getContext("2d", { alpha: true });
if (!ctx) throw new Error("Canvas 2D context unavailable");

// ── Utilities ─────────────────────────────────────────────────────────────────

function setStatus(msg) { el.status.textContent = msg; }

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function uid() { return Math.random().toString(16).slice(2) + Date.now().toString(16); }

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
        state.swingPlaneLine.dirty = !!p.dirty;
        return;
      }
    }
  } catch { /* ignore */ }
  state.swingPlaneLine.line  = defaultSwingPlaneLine();
  state.swingPlaneLine.dirty = false;
}

function saveSwingPlaneLine() {
  try {
    localStorage.setItem(STORAGE_SWING_PLANE, JSON.stringify({
      ...state.swingPlaneLine.line,
      dirty: state.swingPlaneLine.dirty,
    }));
  } catch { /* ignore */ }
}

// ── Selection / line management ───────────────────────────────────────────────

function selectLine(id) {
  state.selectedId = id;
  el.btnDelete.disabled      = !id || id === "swingplane"; // swing-plane line cannot be deleted
  if (el.btnRecalibrate) el.btnRecalibrate.disabled = (id !== "swingplane");
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
  if (!state.selectedId || state.selectedId === "swingplane") return;
  state.lines = state.lines.filter((l) => l.id !== state.selectedId);
  state.selectedId = null;
  saveLinesForView(state.view);
  el.btnDelete.disabled = true;
  setStatus(`Lines: ${state.lines.length}`);
  render();
}

function resetAll() {
  state.lines = defaultLinesForView(state.view);
  state.swingPlaneLine.line  = defaultSwingPlaneLine();
  state.swingPlaneLine.dirty = false;
  state.selectedId = null;
  state.drag       = null;
  saveLinesForView(state.view);
  saveSwingPlaneLine();
  el.btnDelete.disabled = true;
  if (el.btnRecalibrate) el.btnRecalibrate.disabled = true;
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
 * Hit-test a point (nx, ny) against all draggable lines.
 * In Side view the swing-plane line is checked first (rendered on top).
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

  // Swing-plane line takes priority in Side view (it's rendered on top)
  if (state.view === "side") {
    const hit = checkLine(state.swingPlaneLine.line);
    if (hit) return hit;
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

function setHudHidden(hidden) {
  state.ui.hidden = hidden;
  el.hudTop?.classList.toggle("hidden", hidden);
  el.hudBottom?.classList.toggle("hidden", hidden);
}

function bumpUiActivity() {
  state.ui.lastActiveAt = Date.now();
  if (state.ui.hidden && !state.recording.active) setHudHidden(false);
}

function tickUiAutoHide() {
  if (state.recording.active || !state.ready) return;
  if (Date.now() - state.ui.lastActiveAt >= state.ui.idleMs) setHudHidden(true);
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

/** Draw the hands/wrist position dot in the plane-result color. */
function drawWristDot(c, nx, ny, W, H, color) {
  c.beginPath();
  c.arc(nx * W, ny * H, 10, 0, Math.PI * 2);
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
    drawLineOnCtx(ctx, state.swingPlaneLine.line, r.width, r.height, state.selectedId === "swingplane", HR);

    if (state.pose.lastWristNorm) {
      const color = state.pose.planeResult === "above" ? "#ff6b85"
        : state.pose.planeResult === "below" ? "#6ab8ff"
        : "#5dff9e";
      drawWristDot(ctx, state.pose.lastWristNorm.x, state.pose.lastWristNorm.y, r.width, r.height, color);
    }
  }

  renderAssessment();
}

// ── Camera ────────────────────────────────────────────────────────────────────

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
    el.btnStartStop.textContent = "Stop camera";
    setStatus(`Live (${state.lines.length} line${state.lines.length === 1 ? "" : "s"})`);
    resizeCanvasToStage();
    render();

    bumpUiActivity();
    if (!localStorage.getItem(STORAGE_HELP)) el.help.classList.add("show");

    initPose(); // silently no-ops if TF.js didn't load
  } catch (err) {
    const name = err && typeof err === "object" && "name" in err ? String(err.name) : "Error";
    setStatus(`Camera error: ${name}. Use HTTPS and allow camera.`);
  }
}

function stopCamera() {
  if (!state.stream) return;
  for (const t of state.stream.getTracks()) t.stop();
  state.stream = null;
  state.ready  = false;
  el.btnAdd.disabled    = true;
  el.btnReset.disabled  = true;
  el.btnRecord.disabled = true;
  el.btnStopRec.disabled = true;
  el.fps.disabled        = true;
  el.btnStartStop.textContent = "Start camera";
  setStatus("Camera stopped");
  setHudHidden(false);
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

  const baseLine = hit.lineId === "swingplane"
    ? { ...state.swingPlaneLine.line }
    : (() => { const l = state.lines.find((l) => l.id === hit.lineId); return l ? { ...l } : null; })();
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

  if (d.lineId === "swingplane") {
    const update = d.mode === "end1" ? { x1: clamp01(b.x1 + dx), y1: clamp01(b.y1 + dy) }
      : d.mode === "end2"            ? { x2: clamp01(b.x2 + dx), y2: clamp01(b.y2 + dy) }
      : { x1: clamp01(b.x1 + dx), y1: clamp01(b.y1 + dy), x2: clamp01(b.x2 + dx), y2: clamp01(b.y2 + dy) };
    state.swingPlaneLine.line = { ...state.swingPlaneLine.line, ...update };
    render();
    return;
  }

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
  if (state.drag.lineId === "swingplane") {
    state.swingPlaneLine.dirty = true;
    saveSwingPlaneLine();
  } else {
    saveLinesForView(state.view);
  }
  state.drag = null;
  try { el.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
}

// ── View toggle ───────────────────────────────────────────────────────────────

function setView(view) {
  if (state.view === view) return;
  state.view = view;
  localStorage.setItem(STORAGE_UI, JSON.stringify({ view: state.view, fps: el.fps?.value || "30" }));
  el.btnViewFront.classList.toggle("active", view === "front");
  el.btnViewSide.classList.toggle("active",  view === "side");
  loadLinesForView(view);
  selectLine(null);
  resetPoseState();
  setStatus(state.ready ? `Live (${state.lines.length} line${state.lines.length === 1 ? "" : "s"})` : "Tap Start camera");
  render();
}

// ── Recording ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function showCountdown(seconds) {
  el.countdown.classList.add("show");
  el.countdown.setAttribute("aria-hidden", "false");
  for (let s = seconds; s >= 1; s--) {
    el.countdown.textContent = String(s);
    await sleep(1000);
  }
  el.countdown.textContent = "";
  el.countdown.classList.remove("show");
  el.countdown.setAttribute("aria-hidden", "true");
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
      const color = state.pose.planeResult === "above" ? "#ff6b85"
        : state.pose.planeResult === "below" ? "#6ab8ff"
        : "#5dff9e";
      drawWristDot(cctx, state.pose.lastWristNorm.x, state.pose.lastWristNorm.y, w, h, color);
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
    setHudHidden(false);
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
    el.btnDelete.disabled    = !state.selectedId || state.selectedId === "swingplane";
    if (el.btnRecalibrate) el.btnRecalibrate.disabled = state.selectedId !== "swingplane";

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
  state.pose.lastWristNorm = null;
  state.pose.lastGoodAt    = 0;
  state.pose.addressWristY = null;
  state.pose.stableFrames  = 0;
  state.pose.backswingLog  = [];
  state.pose.downswingLog  = [];
  state.pose.swingCompleted = false;
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
      render(); renderAssessment();
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
      render(); renderAssessment();
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
  detectPhase(handsNorm.y, now);
  const newPhase = state.pose.phase;
  state.pose.prevPhase = newPhase;

  // Phase transition bookkeeping
  if (prevPhase !== newPhase) {
    if (newPhase === "address") {
      // Returning to rest after a swing — trigger summary if downswing was captured
      if (!state.pose.swingCompleted && state.pose.downswingLog.length >= 3) {
        triggerSwingSummary();
      }
      // Reset accumulators for the next swing
      state.pose.backswingLog  = [];
      state.pose.downswingLog  = [];
      state.pose.swingCompleted = false;
    }
    if (newPhase === "impact" && !state.pose.swingCompleted) {
      triggerSwingSummary();
    }
  }

  // ── Stable-frame counter + continuous EMA auto-proposal ──────────────────
  if (newPhase === "address") {
    state.pose.stableFrames++;
    autoProposePlaneLine(kps); // every frame; EMA-smoothed inside the function
  } else {
    state.pose.stableFrames = 0;
  }

  // ── Plane assessment (Side view only, active phases only) ─────────────────
  if (state.view === "side" && newPhase !== "address") {
    assessPlane(handsNorm.x, handsNorm.y);
  } else {
    state.pose.planeResult = null;
  }

  // ── Collect per-swing plane logs (after assessment so result is current) ──
  if (state.view === "side" && state.pose.planeResult) {
    if (newPhase === "backswing") state.pose.backswingLog.push(state.pose.planeResult);
    if (newPhase === "downswing") state.pose.downswingLog.push(state.pose.planeResult);
  }

  render();
  renderAssessment();
}

/**
 * Rolling wrist-Y window phase detector.
 * Canvas Y increases downward: upward hand motion = decreasing Y = backswing.
 */
function detectPhase(handsY, timestamp) {
  const hist = state.pose.wristHistory;
  hist.push({ y: handsY, t: timestamp });
  if (hist.length > 12) hist.shift();
  if (hist.length < 4) return;

  // Average velocity over last 5 samples (normalized Y / second)
  const recent = hist.slice(-5);
  let totalVel = 0, count = 0;
  for (let i = 1; i < recent.length; i++) {
    const dt = (recent[i].t - recent[i - 1].t) / 1000;
    if (dt > 0 && dt < 1.5) { totalVel += (recent[i].y - recent[i - 1].y) / dt; count++; }
  }
  const avgVel = count > 0 ? totalVel / count : 0;

  // Stability: std dev of full history window
  const allY   = hist.map((h) => h.y);
  const mean   = allY.reduce((a, b) => a + b, 0) / allY.length;
  const stddev = Math.sqrt(allY.reduce((acc, y) => acc + (y - mean) ** 2, 0) / allY.length);

  const VEL_UP   = -0.10; // normalized Y/s — moving up fast enough to flag backswing
  const VEL_DOWN =  0.10; // normalized Y/s — moving down fast enough to flag downswing
  const STABLE   =  0.008; // very low stddev = standing still at address

  const prev = state.pose.phase;

  if (stddev < STABLE) {
    if (prev !== "address") state.pose.phase = "address";
    // Smooth exponential update of the reference address Y
    state.pose.addressWristY = state.pose.addressWristY === null
      ? handsY
      : state.pose.addressWristY * 0.9 + handsY * 0.1;
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
    // Low velocity, unstable = transition / top of backswing
    if (prev === "backswing") state.pose.phase = "top";
  }
}

/**
 * Auto-propose the swing-plane line from forearm geometry while at address.
 * Called every inference frame when phase === "address" and dirty === false.
 *
 * Geometry:
 *  - Direction: elbow→wrist (forearm vector) — better club shaft proxy than shoulder→wrist
 *  - Upper bound: projected to Y = 0.12 (top of useful frame)
 *  - Lower bound: ankle height + 2% (≈ ball/ground level) if ankles visible, else Y = 0.85
 *
 * EMA smoothing (α = 0.25) prevents jitter; updates settle in ~4 frames (~0.4 s at 10 pose-fps).
 * localStorage writes are throttled to every 10 stable frames to avoid excessive I/O.
 */
function autoProposePlaneLine(keypoints) {
  if (state.swingPlaneLine.dirty) return;

  const MIN_CONF   = 0.40;
  const ANKLE_CONF = 0.35;

  const le = keypoints[7],  re = keypoints[8];  // left/right elbow
  const lw = keypoints[9],  rw = keypoints[10]; // left/right wrist
  const la = keypoints[15], ra = keypoints[16]; // left/right ankle

  const leOk = le && le.score >= MIN_CONF,   reOk = re && re.score >= MIN_CONF;
  const lwOk = lw && lw.score >= MIN_CONF,   rwOk = rw && rw.score >= MIN_CONF;
  const laOk = la && la.score >= ANKLE_CONF, raOk = ra && ra.score >= ANKLE_CONF;

  if ((!lwOk && !rwOk) || (!leOk && !reOk)) return;

  const toO  = (kp) => movenetToOverlay(kp.x, kp.y);
  const midO = (a, b) => {
    if (a && b) return { x: (toO(a).nx + toO(b).nx) / 2, y: (toO(a).ny + toO(b).ny) / 2 };
    const o = toO(a || b); return { x: o.nx, y: o.ny };
  };

  const handsO = midO(lwOk ? lw : null, rwOk ? rw : null);
  const elbowO = midO(leOk ? le : null, reOk ? re : null);

  // Forearm unit vector: elbow → wrist (roughly collinear with club shaft at address)
  const dx  = handsO.x - elbowO.x;
  const dy  = handsO.y - elbowO.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux  = dx / len;
  const uy  = dy / len;

  if (Math.abs(uy) < 0.01) return; // forearm nearly horizontal — can't project usefully

  // Lower anchor: ankle height + small offset ≈ ball/ground level; fallback to fixed Y
  let bottomY = 0.85;
  if (laOk || raOk) {
    const ankleO = midO(laOk ? la : null, raOk ? ra : null);
    bottomY = clamp01(ankleO.y + 0.02);
  }
  const topY = 0.12;

  // t such that handsO.y + t*uy = targetY
  const t1 = (topY    - handsO.y) / uy;
  const t2 = (bottomY - handsO.y) / uy;

  const newX1 = clamp01(handsO.x + t1 * ux);
  const newX2 = clamp01(handsO.x + t2 * ux);

  // EMA smoothing — α=0.25 converges in ~4 frames at 10 pose-fps (≈ 0.4 s)
  const EMA = 0.25;
  const cur = state.swingPlaneLine.line;

  if (state.pose.stableFrames <= 1) {
    // First frame back at address: snap directly so there's no blending artifact
    state.swingPlaneLine.line = { ...cur, x1: newX1, y1: topY, x2: newX2, y2: bottomY };
  } else {
    state.swingPlaneLine.line = {
      ...cur,
      x1: cur.x1 + (newX1 - cur.x1) * EMA,
      y1: topY,
      x2: cur.x2 + (newX2 - cur.x2) * EMA,
      y2: bottomY,
    };
  }

  // Throttle localStorage writes — every 10 stable frames is plenty
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
  const TH = 0.04; // 4% of normalized width ≈ ~1-2 cm at typical camera distance

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

function triggerSwingSummary() {
  // Require at least a few readings in each phase to avoid noise
  if (state.pose.backswingLog.length < 3 && state.pose.downswingLog.length < 3) return;
  state.pose.swingCompleted = true;
  showSwingSummary(
    dominantResult(state.pose.backswingLog),
    dominantResult(state.pose.downswingLog)
  );
}

/**
 * Show the 5-second post-swing summary overlay.
 * @param {"above"|"on"|"below"|null} backswing
 * @param {"above"|"on"|"below"|null} downswing
 */
function showSwingSummary(backswing, downswing) {
  if (!el.swingSummary) return;
  dismissSwingSummary(); // clear any running timer first

  const meta = {
    above:   { icon: "▲", label: "Above Plane" },
    on:      { icon: "●", label: "On Plane"    },
    below:   { icon: "▽", label: "Below Plane" },
  };

  const phaseCard = (title, result) => {
    const r = result && meta[result] ? result : "unknown";
    const m = meta[r] ?? { icon: "?", label: "No data" };
    return `<div class="sswPhaseCard ${r}">
      <div class="sswPhaseName">${title}</div>
      <div class="sswPhaseIcon ${r}">${m.icon}</div>
      <div class="sswPhaseResult">${m.label}</div>
    </div>`;
  };

  el.swingSummary.innerHTML = `
    <div class="sswCard">
      <div class="sswTitle">Swing Analysis</div>
      <div class="sswRow">
        ${phaseCard("Backswing", backswing)}
        <div class="sswDivider"></div>
        ${phaseCard("Downswing", downswing)}
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

/** Update the assessment badge DOM element. */
function renderAssessment() {
  if (!el.assessment) return;

  const summaryOpen = el.swingSummary?.classList.contains("show") ?? false;
  const show = state.view === "side" && state.ready && state.pose.lastWristNorm !== null && !summaryOpen;
  if (!show) {
    el.assessment.classList.remove("show", "above", "on", "below");
    return;
  }

  const phaseLabel = { address: "Address", backswing: "Backswing", top: "Top", downswing: "Downswing", impact: "Impact" }[state.pose.phase] ?? state.pose.phase;
  const planeLabel = { above: "▲ Above", on: "● On plane", below: "▼ Below" }[state.pose.planeResult] ?? "—";

  el.assessment.classList.add("show");
  el.assessment.classList.toggle("above", state.pose.planeResult === "above");
  el.assessment.classList.toggle("on",    state.pose.planeResult === "on");
  el.assessment.classList.toggle("below", state.pose.planeResult === "below");
  el.assessment.innerHTML =
    `<span class="assessPhase">${phaseLabel}</span><span class="assessPlane">${planeLabel}</span>`;
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init() {
  try {
    const ui = JSON.parse(localStorage.getItem(STORAGE_UI) || "{}");
    if (ui.view === "front" || ui.view === "side") state.view = ui.view;
    if (ui.fps  === "30"    || ui.fps  === "60")   el.fps.value = ui.fps;
  } catch { /* ignore */ }

  loadLinesForView(state.view);
  loadSwingPlaneLine();

  el.btnViewFront.classList.toggle("active", state.view === "front");
  el.btnViewSide.classList.toggle("active",  state.view === "side");
  setStatus("Tap Start camera");

  el.btnStartStop.addEventListener("click",  () => (state.ready ? stopCamera() : startCamera()));
  el.btnAdd.addEventListener("click",        () => addLine());
  el.btnDelete.addEventListener("click",     () => deleteSelected());
  el.btnReset.addEventListener("click",      () => resetAll());
  el.btnViewFront.addEventListener("click",  () => setView("front"));
  el.btnViewSide.addEventListener("click",   () => setView("side"));

  if (el.btnRecalibrate) {
    el.btnRecalibrate.addEventListener("click", () => {
      state.swingPlaneLine.dirty  = false;
      state.pose.stableFrames     = 0;
      saveSwingPlaneLine();
      setStatus("Re-calibrating — stand at address…");
    });
  }

  el.fps.addEventListener("change", () => {
    localStorage.setItem(STORAGE_UI, JSON.stringify({ view: state.view, fps: el.fps.value }));
  });
  el.btnRecord.addEventListener("click",   () => startRecording());
  el.btnStopRec.addEventListener("click",  () => stopRecording());
  el.btnStopFloat.addEventListener("click",() => stopRecording());

  el.btnDismissHelp.addEventListener("click", () => {
    localStorage.setItem(STORAGE_HELP, "1");
    el.help.classList.remove("show");
  });

  el.canvas.addEventListener("pointerdown",  (e) => { bumpUiActivity(); onPointerDown(e); }, { passive: true });
  el.canvas.addEventListener("pointermove",  (e) => { bumpUiActivity(); onPointerMove(e); }, { passive: true });
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

  setInterval(() => tickUiAutoHide(), 250);

  resizeCanvasToStage();
  render();
}

init();
