/**
 * Single-file, framework-free iPhone camera + draggable line overlay.
 * Designed for touch: drag endpoints to rotate/resize, drag body to move.
 */

const STORAGE_KEY_FRONT = "golfcam.lines.front.v1";
const STORAGE_KEY_SIDE = "golfcam.lines.side.v1";
const STORAGE_UI = "golfcam.ui.v1";
const STORAGE_HELP = "golfcam.helpDismissed";

/** @typedef {{id:string,x1:number,y1:number,x2:number,y2:number,color:string,width:number}} Line */

const state = {
  stream: null,
  lines: /** @type {Line[]} */ ([]),
  selectedId: /** @type {string|null} */ (null),
  drag: /** @type {null|{lineId:string,mode:"end1"|"end2"|"body",startNx:number,startNy:number,base:Line}} */ (null),
  ready: false,
  view: /** @type {"front"|"side"} */ ("front"),
  recording: {
    active: false,
    recorder: /** @type {MediaRecorder|null} */ (null),
    chunks: /** @type {BlobPart[]} */ ([]),
    compositeCanvas: /** @type {HTMLCanvasElement|null} */ (null),
    compositeCtx: /** @type {CanvasRenderingContext2D|null} */ (null),
    raf: /** @type {number|null} */ (null),
    lastUrl: /** @type {string|null} */ (null),
  },
  ui: {
    hidden: false,
    lastActiveAt: Date.now(),
    idleMs: 2000,
  },
};

const el = {
  stage: /** @type {HTMLDivElement} */ (document.getElementById("stage")),
  video: /** @type {HTMLVideoElement} */ (document.getElementById("video")),
  canvas: /** @type {HTMLCanvasElement} */ (document.getElementById("overlay")),
  status: /** @type {HTMLDivElement} */ (document.getElementById("status")),
  hudTop: /** @type {HTMLDivElement} */ (document.querySelector(".hud.top")),
  hudBottom: /** @type {HTMLDivElement} */ (document.querySelector(".hud.bottom")),
  btnStartStop: /** @type {HTMLButtonElement} */ (document.getElementById("btnStartStop")),
  btnViewFront: /** @type {HTMLButtonElement} */ (document.getElementById("btnViewFront")),
  btnViewSide: /** @type {HTMLButtonElement} */ (document.getElementById("btnViewSide")),
  btnAdd: /** @type {HTMLButtonElement} */ (document.getElementById("btnAdd")),
  btnDelete: /** @type {HTMLButtonElement} */ (document.getElementById("btnDelete")),
  btnReset: /** @type {HTMLButtonElement} */ (document.getElementById("btnReset")),
  fps: /** @type {HTMLSelectElement} */ (document.getElementById("fps")),
  btnRecord: /** @type {HTMLButtonElement} */ (document.getElementById("btnRecord")),
  btnStopRec: /** @type {HTMLButtonElement} */ (document.getElementById("btnStopRec")),
  btnStopFloat: /** @type {HTMLButtonElement} */ (document.getElementById("btnStopFloat")),
  countdown: /** @type {HTMLDivElement} */ (document.getElementById("countdown")),
  help: /** @type {HTMLDivElement} */ (document.getElementById("help")),
  btnDismissHelp: /** @type {HTMLButtonElement} */ (document.getElementById("btnDismissHelp")),
};

const ctx = el.canvas.getContext("2d", { alpha: true });
if (!ctx) throw new Error("Canvas 2D context unavailable");

function setStatus(msg) {
  el.status.textContent = msg;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function storageKeyForView(view) {
  return view === "side" ? STORAGE_KEY_SIDE : STORAGE_KEY_FRONT;
}

function defaultLinesForView(view) {
  /** @type {Line} */
  const base = { id: uid(), x1: 0.5, y1: 0.2, x2: 0.5, y2: 0.85, color: "#ffffff", width: 3 };
  if (view === "front") {
    // Vertical centered
    return [base];
  }
  // Side: right-hander default slant is top-right -> bottom-left ("/" on screen)
  return [
    {
      ...base,
      id: uid(),
      x1: 0.78,
      y1: 0.25,
      x2: 0.28,
      y2: 0.75,
    },
  ];
}

function loadLinesForView(view) {
  try {
    const raw = localStorage.getItem(storageKeyForView(view));
    if (!raw) {
      state.lines = defaultLinesForView(view);
      saveLinesForView(view);
      return;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    state.lines = parsed
      .filter((l) => l && typeof l.id === "string")
      .map((l) => ({
        id: String(l.id),
        x1: clamp01(Number(l.x1)),
        y1: clamp01(Number(l.y1)),
        x2: clamp01(Number(l.x2)),
        y2: clamp01(Number(l.y2)),
        color: typeof l.color === "string" ? l.color : "#ffffff",
        width: Number.isFinite(Number(l.width)) ? Number(l.width) : 3,
      }));
  } catch {
    // ignore
  }
}

function saveLinesForView(view) {
  try {
    localStorage.setItem(storageKeyForView(view), JSON.stringify(state.lines));
  } catch {
    // ignore
  }
}

function selectLine(id) {
  state.selectedId = id;
  el.btnDelete.disabled = !id;
  render();
}

function addLine() {
  /** @type {Line} */
  const line = {
    id: uid(),
    // Default depends on view: front vertical; side slanted "/"
    ...(state.view === "front"
      ? { x1: 0.5, y1: 0.2, x2: 0.5, y2: 0.85 }
      : { x1: 0.78, y1: 0.25, x2: 0.28, y2: 0.75 }),
    color: "#ffffff",
    width: 3,
  };
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
  state.selectedId = null;
  state.drag = null;
  saveLinesForView(state.view);
  el.btnDelete.disabled = true;
  setStatus("Reset");
  render();
}

function getCanvasBox() {
  const r = el.canvas.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function clientToNormalized(clientX, clientY) {
  const { left, top, width, height } = getCanvasBox();
  const nx = (clientX - left) / Math.max(1, width);
  const ny = (clientY - top) / Math.max(1, height);
  return { nx: clamp01(nx), ny: clamp01(ny) };
}

function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function pointToSegmentDistance2(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const abLen2 = abx * abx + aby * aby || 1e-9;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLen2));
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  return dist2(px, py, cx, cy);
}

function hitTest(nx, ny) {
  const box = getCanvasBox();
  const px = nx * box.width;
  const py = ny * box.height;

  const handleRadiusPx = 18;
  const lineThresholdPx = 14;
  const handleR2 = handleRadiusPx * handleRadiusPx;
  const lineT2 = lineThresholdPx * lineThresholdPx;

  for (let i = state.lines.length - 1; i >= 0; i--) {
    const l = state.lines[i];
    const ax = l.x1 * box.width;
    const ay = l.y1 * box.height;
    const bx = l.x2 * box.width;
    const by = l.y2 * box.height;

    if (dist2(px, py, ax, ay) <= handleR2) return { lineId: l.id, mode: "end1" };
    if (dist2(px, py, bx, by) <= handleR2) return { lineId: l.id, mode: "end2" };
    if (pointToSegmentDistance2(px, py, ax, ay, bx, by) <= lineT2) return { lineId: l.id, mode: "body" };
  }

  return null;
}

function resizeCanvasToStage() {
  const r = el.stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  el.canvas.width = Math.max(1, Math.round(r.width * dpr));
  el.canvas.height = Math.max(1, Math.round(r.height * dpr));
  el.canvas.style.width = `${r.width}px`;
  el.canvas.style.height = `${r.height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

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
  if (state.recording.active) return;
  if (!state.ready) return;
  const idleFor = Date.now() - state.ui.lastActiveAt;
  if (idleFor >= state.ui.idleMs) setHudHidden(true);
}

function render() {
  const r = el.stage.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);

  const handleRadius = 7;
  for (const l of state.lines) {
    const selected = l.id === state.selectedId;
    const lineWidth = selected ? l.width + 1.5 : l.width;
    const stroke = selected ? "#ffd44d" : l.color;

    const x1 = l.x1 * r.width;
    const y1 = l.y1 * r.height;
    const x2 = l.x2 * r.width;
    const y2 = l.y2 * r.height;

    ctx.lineCap = "round";
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    if (selected) {
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.lineWidth = 2;

      for (const [x, y] of [
        [x1, y1],
        [x2, y2],
      ]) {
        ctx.beginPath();
        ctx.arc(x, y, handleRadius + 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, handleRadius, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Camera not supported in this browser.");
    return;
  }

  try {
    setStatus("Requesting camera permission…");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    state.stream = stream;
    el.video.srcObject = stream;
    await el.video.play().catch(() => {});
    state.ready = true;

    el.btnAdd.disabled = false;
    el.btnReset.disabled = false;
    el.btnRecord.disabled = false;
    el.fps.disabled = false;
    el.btnStartStop.textContent = "Stop camera";
    setStatus(`Live (${state.lines.length} line${state.lines.length === 1 ? "" : "s"})`);
    resizeCanvasToStage();
    render();

    bumpUiActivity();
    if (!localStorage.getItem(STORAGE_HELP)) {
      el.help.classList.add("show");
    }
  } catch (err) {
    const name = err && typeof err === "object" && "name" in err ? String(err.name) : "Error";
    setStatus(`Camera error: ${name}. Use HTTPS and allow camera.`);
  }
}

function stopCamera() {
  if (!state.stream) return;
  for (const t of state.stream.getTracks()) t.stop();
  state.stream = null;
  state.ready = false;
  el.btnAdd.disabled = true;
  el.btnReset.disabled = true;
  el.btnRecord.disabled = true;
  el.btnStopRec.disabled = true;
  el.fps.disabled = true;
  el.btnStartStop.textContent = "Start camera";
  setStatus("Camera stopped");
  setHudHidden(false);
  render();
}

function onPointerDown(e) {
  if (!state.ready) return;
  if (e.button !== undefined && e.button !== 0) return;

  const { nx, ny } = clientToNormalized(e.clientX, e.clientY);
  const hit = hitTest(nx, ny);
  if (!hit) {
    selectLine(null);
    return;
  }

  const baseLine = state.lines.find((l) => l.id === hit.lineId);
  if (!baseLine) return;

  selectLine(hit.lineId);
  state.drag = {
    lineId: hit.lineId,
    mode: hit.mode,
    startNx: nx,
    startNy: ny,
    base: { ...baseLine },
  };

  el.canvas.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  if (!state.drag) return;
  const d = state.drag;
  const { nx, ny } = clientToNormalized(e.clientX, e.clientY);
  const dx = nx - d.startNx;
  const dy = ny - d.startNy;

  state.lines = state.lines.map((l) => {
    if (l.id !== d.lineId) return l;
    const b = d.base;

    if (d.mode === "end1") {
      return { ...l, x1: clamp01(b.x1 + dx), y1: clamp01(b.y1 + dy) };
    }
    if (d.mode === "end2") {
      return { ...l, x2: clamp01(b.x2 + dx), y2: clamp01(b.y2 + dy) };
    }
    // body
    return {
      ...l,
      x1: clamp01(b.x1 + dx),
      y1: clamp01(b.y1 + dy),
      x2: clamp01(b.x2 + dx),
      y2: clamp01(b.y2 + dy),
    };
  });

  render();
}

function onPointerUp(e) {
  if (!state.drag) return;
  saveLinesForView(state.view);
  state.drag = null;
  try {
    el.canvas.releasePointerCapture(e.pointerId);
  } catch {
    // ignore
  }
}

function setView(view) {
  if (state.view === view) return;
  state.view = view;
  localStorage.setItem(
    STORAGE_UI,
    JSON.stringify({ view: state.view, fps: el.fps?.value || "30" })
  );
  el.btnViewFront.classList.toggle("active", view === "front");
  el.btnViewSide.classList.toggle("active", view === "side");
  loadLinesForView(view);
  selectLine(null);
  setStatus(state.ready ? `Live (${state.lines.length} line${state.lines.length === 1 ? "" : "s"})` : "Tap Start camera");
  render();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
  const c = document.createElement("canvas");
  const cctx = c.getContext("2d");
  if (!cctx) throw new Error("Composite canvas context unavailable");
  state.recording.compositeCanvas = c;
  state.recording.compositeCtx = cctx;
}

function drawCompositeFrame() {
  const c = state.recording.compositeCanvas;
  const cctx = state.recording.compositeCtx;
  if (!c || !cctx) return;
  const r = el.stage.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }

  cctx.clearRect(0, 0, w, h);
  // Mirror to match what user sees (video element is mirrored in CSS)
  cctx.save();
  cctx.translate(w, 0);
  cctx.scale(-1, 1);
  cctx.drawImage(el.video, 0, 0, w, h);
  cctx.restore();

  // Draw the same overlay lines
  const handleRadius = 7;
  for (const l of state.lines) {
    const selected = l.id === state.selectedId;
    const lineWidth = selected ? l.width + 1.5 : l.width;
    const stroke = selected ? "#ffd44d" : l.color;
    const x1 = l.x1 * w;
    const y1 = l.y1 * h;
    const x2 = l.x2 * w;
    const y2 = l.y2 * h;
    cctx.lineCap = "round";
    cctx.strokeStyle = stroke;
    cctx.lineWidth = lineWidth;
    cctx.beginPath();
    cctx.moveTo(x1, y1);
    cctx.lineTo(x2, y2);
    cctx.stroke();
    if (selected) {
      cctx.fillStyle = "rgba(0,0,0,0.35)";
      cctx.strokeStyle = "rgba(255,255,255,0.92)";
      cctx.lineWidth = 2;
      for (const [x, y] of [
        [x1, y1],
        [x2, y2],
      ]) {
        cctx.beginPath();
        cctx.arc(x, y, handleRadius + 3, 0, Math.PI * 2);
        cctx.fill();
        cctx.beginPath();
        cctx.arc(x, y, handleRadius, 0, Math.PI * 2);
        cctx.stroke();
      }
    }
  }
}

function startCompositeLoop() {
  const loop = () => {
    drawCompositeFrame();
    state.recording.raf = requestAnimationFrame(loop);
  };
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
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

async function startRecording() {
  if (!state.ready || state.recording.active) return;
  ensureCompositeCanvas();
  const fps = Number(el.fps.value) || 30;
  await showCountdown(5);

  // Hide controls while recording (keep minimal stop button enabled)
  state.recording.active = true;
  setHudHidden(true);
  el.btnStopFloat.classList.add("show");
  el.btnStopFloat.disabled = false;
  el.btnStopRec.disabled = false;
  el.btnRecord.disabled = true;
  el.btnAdd.disabled = true;
  el.btnDelete.disabled = true;
  el.btnReset.disabled = true;
  el.btnStartStop.disabled = true;
  el.fps.disabled = true;
  el.btnViewFront.disabled = true;
  el.btnViewSide.disabled = true;

  if (state.recording.lastUrl) {
    URL.revokeObjectURL(state.recording.lastUrl);
    state.recording.lastUrl = null;
  }
  state.recording.chunks = [];

  startCompositeLoop();
  const stream = state.recording.compositeCanvas.captureStream(fps);
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) state.recording.chunks.push(e.data);
  };
  recorder.onstop = () => {
    stopCompositeLoop();
    for (const t of stream.getTracks()) t.stop();

    const blob = new Blob(state.recording.chunks, { type: recorder.mimeType || "video/webm" });
    const url = URL.createObjectURL(blob);
    state.recording.lastUrl = url;

    const ext = (recorder.mimeType || "").includes("mp4") ? "mp4" : "webm";
    const a = document.createElement("a");
    a.href = url;
    a.download = `golfcam-${state.view}-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();

    // Restore UI
    state.recording.active = false;
    setHudHidden(false);
    el.btnStopFloat.classList.remove("show");
    el.btnStopFloat.disabled = true;
    el.btnStopRec.disabled = true;
    el.btnRecord.disabled = false;
    el.btnAdd.disabled = false;
    el.btnReset.disabled = false;
    el.btnStartStop.disabled = false;
    el.fps.disabled = false;
    el.btnViewFront.disabled = false;
    el.btnViewSide.disabled = false;
    el.btnDelete.disabled = !state.selectedId;

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

function init() {
  try {
    const ui = JSON.parse(localStorage.getItem(STORAGE_UI) || "{}");
    if (ui && (ui.view === "front" || ui.view === "side")) state.view = ui.view;
    if (ui && (ui.fps === "30" || ui.fps === "60")) el.fps.value = ui.fps;
  } catch {
    // ignore
  }

  loadLinesForView(state.view);
  el.btnViewFront.classList.toggle("active", state.view === "front");
  el.btnViewSide.classList.toggle("active", state.view === "side");
  setStatus("Tap Start camera");

  el.btnStartStop.addEventListener("click", () => (state.ready ? stopCamera() : startCamera()));
  el.btnAdd.addEventListener("click", () => addLine());
  el.btnDelete.addEventListener("click", () => deleteSelected());
  el.btnReset.addEventListener("click", () => resetAll());
  el.btnViewFront.addEventListener("click", () => setView("front"));
  el.btnViewSide.addEventListener("click", () => setView("side"));
  el.fps.addEventListener("change", () => {
    localStorage.setItem(STORAGE_UI, JSON.stringify({ view: state.view, fps: el.fps.value }));
  });
  el.btnRecord.addEventListener("click", () => startRecording());
  el.btnStopRec.addEventListener("click", () => stopRecording());
  el.btnStopFloat.addEventListener("click", () => stopRecording());

  el.btnDismissHelp.addEventListener("click", () => {
    localStorage.setItem(STORAGE_HELP, "1");
    el.help.classList.remove("show");
  });

  // Pointer events unify touch/mouse.
  el.canvas.addEventListener("pointerdown", (e) => { bumpUiActivity(); onPointerDown(e); }, { passive: true });
  el.canvas.addEventListener("pointermove", (e) => { bumpUiActivity(); onPointerMove(e); }, { passive: true });
  el.canvas.addEventListener("pointerup", (e) => { bumpUiActivity(); onPointerUp(e); }, { passive: true });
  el.canvas.addEventListener("pointercancel", (e) => { bumpUiActivity(); onPointerUp(e); }, { passive: true });

  window.addEventListener("resize", resizeCanvasToStage);
  window.addEventListener("orientationchange", () => setTimeout(resizeCanvasToStage, 150));

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopCamera();
  });

  // Tap anywhere to reveal controls if hidden
  el.stage.addEventListener("pointerdown", () => bumpUiActivity(), { passive: true });
  setInterval(() => tickUiAutoHide(), 250);

  resizeCanvasToStage();
  render();
}

init();

