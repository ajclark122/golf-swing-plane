/**
 * Shared swing-plane presentation for iPhone + iPad monitor.
 *
 * Level bands (from assessPlane, unchanged): 0 = tightest, 1 = near, 2 = moderate, 3 = far.
 *
 * Glyph rules:
 *   L0–L1 → ● (close, slight above/below still reads as dot)
 *   L2–L3 → ▲ / ▽ from plane ("on" at L2/3 → ●)
 *
 * Scale (monitor / summary icon): smaller when close, larger when far (triangles slightly boosted).
 *
 * Sanity (plane, level) → phrase / glyph:
 *   (on,0)     → On Plane, ●
 *   (above,1)  → Near Plane — Above, ●
 *   (below,2)  → Below Plane, ▽
 *   (above,3)  → Significantly Above Plane, ▲
 */

/** @typedef {"above"|"on"|"below"|null} Plane */
/** @typedef {0|1|2|3|null} Level */

/**
 * @param {Plane} plane
 * @param {Level} level
 * @returns {boolean}
 */
export function glyphIsTriangle(plane, level) {
  if (level !== 2 && level !== 3) return false;
  return plane === "above" || plane === "below";
}

/**
 * @param {Plane} plane
 * @param {Level} level
 * @returns {string}
 */
export function displayGlyph(plane, level) {
  if (level !== 0 && level !== 1 && level !== 2 && level !== 3) return "—";
  if (level === 0 || level === 1) return "●";
  if (plane === "above") return "▲";
  if (plane === "below") return "▽";
  if (plane === "on") return "●";
  return "—";
}

/**
 * Single-line English for HUD / monitor meta (no phase prefix).
 * @param {Plane} plane
 * @param {Level} level
 * @returns {string}
 */
export function displayPhrase(plane, level) {
  if (level !== 0 && level !== 1 && level !== 2 && level !== 3) return "No reading";

  if (level === 0) return "On Plane";

  if (level === 1) {
    if (plane === "above") return "Near Plane — Above";
    if (plane === "below") return "Near Plane — Below";
    if (plane === "on") return "Near Plane";
    return "Near Plane";
  }

  if (level === 2) {
    if (plane === "above") return "Above Plane";
    if (plane === "below") return "Below Plane";
    if (plane === "on") return "Off Plane";
    return "No reading";
  }

  if (level === 3) {
    if (plane === "above") return "Significantly Above Plane";
    if (plane === "below") return "Significantly Below Plane";
    if (plane === "on") return "Significantly Off Plane";
    return "No reading";
  }

  return "No reading";
}

/**
 * CSS transform scale: small when close, large when far.
 * @param {Level} level
 * @param {boolean} asTriangle
 * @returns {number}
 */
export function displayScale(level, asTriangle) {
  if (level !== 0 && level !== 1 && level !== 2 && level !== 3) return 1;

  let s = level === 0 ? 0.54 : level === 1 ? 0.72 : level === 2 ? 1.10 : 1.44;
  if (!asTriangle) s *= 0.92;
  if (asTriangle && level >= 2) s *= 1.05;
  return Math.round(s * 1000) / 1000;
}

/**
 * @param {Plane} plane
 * @param {Level} level
 * @returns {string}
 */
export function displayColor(plane, level) {
  if (level !== 0 && level !== 1 && level !== 2 && level !== 3) {
    return "rgba(255,255,255,0.92)";
  }

  if (level === 0) return "#5dff9e";

  if (level === 1) {
    if (plane === "above") return "#ff9eb0";
    if (plane === "below") return "#9ed4ff";
    if (plane === "on") return "#5dff9e";
    return "rgba(255,255,255,0.88)";
  }

  if (plane === "above") return "#ff6b85";
  if (plane === "below") return "#6ab8ff";
  if (plane === "on") return "#5dff9e";
  return "rgba(255,255,255,0.92)";
}
