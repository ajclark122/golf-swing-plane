/**
 * Single-file, framework-free iPhone camera + draggable line overlay.
 * Designed for touch: drag endpoints to rotate/resize, drag body to move.
 */

const STORAGE_KEY = "golfcam.lines.v1";

/** @typedef {{id:string,x1:number,y1:number,x2:number,y2:number,color:string,width:number}} Line */

const state = {
  stream: null,
  lines: /** @type {Line[]} */ ([]),
  selectedId: /** @type {string|null} */ (null),
  drag: /** @type {null|{lineId:string,mode:"end1"|"end2"|"body",startNx:number,startNy:number,base:Line}} */ (null),
  ready: false,
};

const el = {
  stage: /** @type {HTMLDivElement} */ (document.getElementById("stage")),
  video: /** @type {HTMLVideoElement} */ (document.getElementById("video")),
  canvas: /** @type {HTMLCanvasElement} */ (document.getElementById("overlay")),
  status: /** @type {HTMLDivElement} */ (document.getElementById("status")),
  btnStart: /** @type {HTMLButtonElement} */ (document.getElementById("btnStart")),
  btnAdd: /** @type {HTMLButtonElement} */ (document.getElementById("btnAdd")),
  btnDelete: /** @type {HTMLButtonElement} */ (document.getElementById("btnDelete")),
  btnReset: /** @type {HTMLButtonElement} */ (document.getElementById("btnReset")),
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

function loadLines() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
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

function saveLines() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.lines));
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
    x1: 0.25,
    y1: 0.3,
    x2: 0.75,
    y2: 0.7,
    color: "#ffffff",
    width: 3,
  };
  state.lines = [...state.lines, line];
  saveLines();
  selectLine(line.id);
  setStatus(`Lines: ${state.lines.length}`);
}

function deleteSelected() {
  if (!state.selectedId) return;
  state.lines = state.lines.filter((l) => l.id !== state.selectedId);
  state.selectedId = null;
  saveLines();
  el.btnDelete.disabled = true;
  setStatus(`Lines: ${state.lines.length}`);
  render();
}

function resetAll() {
  state.lines = [];
  state.selectedId = null;
  state.drag = null;
  saveLines();
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
    el.btnStart.disabled = true;
    setStatus(`Live (${state.lines.length} line${state.lines.length === 1 ? "" : "s"})`);
    resizeCanvasToStage();
    render();

    if (!localStorage.getItem("golfcam.helpDismissed")) {
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
  el.btnStart.disabled = false;
  setStatus("Camera stopped");
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
  saveLines();
  state.drag = null;
  try {
    el.canvas.releasePointerCapture(e.pointerId);
  } catch {
    // ignore
  }
}

function init() {
  loadLines();
  setStatus("Tap Start camera");

  el.btnStart.addEventListener("click", () => startCamera());
  el.btnAdd.addEventListener("click", () => addLine());
  el.btnDelete.addEventListener("click", () => deleteSelected());
  el.btnReset.addEventListener("click", () => resetAll());

  el.btnDismissHelp.addEventListener("click", () => {
    localStorage.setItem("golfcam.helpDismissed", "1");
    el.help.classList.remove("show");
  });

  // Pointer events unify touch/mouse.
  el.canvas.addEventListener("pointerdown", onPointerDown, { passive: true });
  el.canvas.addEventListener("pointermove", onPointerMove, { passive: true });
  el.canvas.addEventListener("pointerup", onPointerUp, { passive: true });
  el.canvas.addEventListener("pointercancel", onPointerUp, { passive: true });

  window.addEventListener("resize", resizeCanvasToStage);
  window.addEventListener("orientationchange", () => setTimeout(resizeCanvasToStage, 150));

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopCamera();
  });

  resizeCanvasToStage();
  render();
}

init();

