/**
 * Deterministic post-swing copy and sample-dot HTML (no LLM).
 * Phrasing stays conservative — same intent as plane-display phrases.
 */

/** @typedef {"above"|"on"|"below"|null} Plane */
/** @typedef {0|1|2|3|null} Lev */

/**
 * @param {Plane} plane
 * @returns {plane is "above"|"on"|"below"}
 */
function okPlane(plane) {
  return plane === "above" || plane === "on" || plane === "below";
}

/**
 * @param {number|null} lv
 * @returns {lv is 0|1|2|3}
 */
function okLv(lv) {
  return lv === 0 || lv === 1 || lv === 2 || lv === 3;
}

/**
 * @param {Plane} plane
 * @param {Lev} lv
 * @param {"Backswing"|"Downswing"} label
 */
function focusLine(plane, lv, label) {
  const L = label;
  if (lv === 0) return `${L} tracked the shaft plane closely.`;
  if (lv === 1) {
    if (plane === "on") return `${L} stayed near the shaft plane.`;
    if (plane === "above") return `${L} stayed slightly above the shaft plane.`;
    return `${L} stayed slightly below the shaft plane.`;
  }
  if (lv === 2) {
    if (plane === "above") return `${L} spent noticeable time above the plane.`;
    if (plane === "below") return `${L} spent noticeable time below the plane.`;
    return `${L} showed moderate separation from the plane.`;
  }
  if (plane === "above") return `${L} was well above the plane for much of the motion.`;
  if (plane === "below") return `${L} was well below the plane for much of the motion.`;
  return `${L} showed large separation from the plane.`;
}

/**
 * @param {Plane} back
 * @param {Plane} down
 * @param {Lev} backLv
 * @param {Lev} downLv
 * @returns {string|null}
 */
function comparisonSecondLine(back, down, backLv, downLv) {
  const hb = okPlane(back) && okLv(backLv);
  const hd = okPlane(down) && okLv(downLv);
  if (!hb || !hd) return null;

  if (back === "above" && down === "below") {
    return "Plane side shifted from above in the backswing to below in the downswing — worth checking transition.";
  }
  if (back === "below" && down === "above") {
    return "Plane side shifted from below in the backswing to above in the downswing — worth checking transition.";
  }
  if (back === down) {
    const diff = Math.abs(/** @type {number} */(backLv) - /** @type {number} */(downLv));
    if (diff >= 2) return "Backswing and downswing differed in how far you moved off plane.";
    return null;
  }
  if (back === "on" && down !== "on" && (downLv === 2 || downLv === 3)) {
    return "Closer to plane in the backswing than through the downswing.";
  }
  if (down === "on" && back !== "on" && (backLv === 2 || backLv === 3)) {
    return "Downswing settled nearer the plane than the backswing.";
  }
  if (back !== "on" && down !== "on" && back !== down) {
    return "Backswing and downswing favored different sides of the plane.";
  }
  return null;
}

/**
 * Deterministic 1–2 line takeaway from dominant half-plane summaries.
 * @param {Plane} back
 * @param {Plane} down
 * @param {number|null} backLv
 * @param {number|null} downLv
 * @returns {string[]}
 */
export function swingTakeawayLines(back, down, backLv, downLv) {
  const hasDown = okPlane(down) && okLv(downLv);
  const hasBack = okPlane(back) && okLv(backLv);

  if (!hasDown && !hasBack) {
    return ["Not enough plane samples to summarize this swing."];
  }

  /** @type {string[]} */
  const lines = [];

  if (hasDown) {
    lines.push(focusLine(down, downLv, "Downswing"));
  } else {
    lines.push(focusLine(back, backLv, "Backswing"));
  }

  if (lines.length < 2 && hasDown && hasBack) {
    const second = comparisonSecondLine(back, down, backLv, downLv);
    if (second) lines.push(second);
  }

  return lines.slice(0, 2);
}

/**
 * HTML for one phase's sample dots (newest toward the right).
 * @param {string[]} log
 * @param {number} maxDots
 * @returns {string}
 */
export function htmlPlaneDotStrip(log, maxDots = 24) {
  if (!Array.isArray(log) || log.length === 0) {
    return `<span class="sswDotNone">—</span>`;
  }
  const total = log.length;
  const n = Math.min(maxDots, total);
  const slice = log.slice(total - n);
  /** @type {string[]} */
  const parts = [];
  if (total > maxDots) {
    parts.push(`<span class="sswDotMore" title="Earlier samples omitted">…</span>`);
  }
  for (const r of slice) {
    let cls = "sswDot on";
    if (r === "above") cls = "sswDot above";
    else if (r === "below") cls = "sswDot below";
    parts.push(`<span class="${cls}"></span>`);
  }
  return `<div class="sswDots" role="presentation">${parts.join("")}</div>`;
}

/**
 * Back + down sample rows for the summary card.
 * @param {string[]} backLog
 * @param {string[]} downLog
 * @param {number} [maxDots]
 * @returns {string}
 */
export function htmlSwingSampleStrips(backLog, downLog, maxDots = 24) {
  return `
    <div class="sswStripBlock" role="presentation">
      <div class="sswStripRow">
        <span class="sswStripTitle">Back</span>
        ${htmlPlaneDotStrip(backLog, maxDots)}
      </div>
      <div class="sswStripRow">
        <span class="sswStripTitle">Down</span>
        ${htmlPlaneDotStrip(downLog, maxDots)}
      </div>
    </div>`;
}
