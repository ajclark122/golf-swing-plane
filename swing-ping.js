/**
 * Short success chime when a swing summary completes (Web Audio API).
 * iOS/Safari: call `primeSwingPingAudio()` once from a user gesture so playback is allowed.
 */

/** @type {AudioContext|null} */
let sharedCtx = null;
let lastPlayAt = 0;
const MIN_INTERVAL_MS = 400;

function getOrCreateContext() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedCtx) sharedCtx = new Ctor();
  return sharedCtx;
}

/** Warm / unlock audio after tap (call once from pointerdown). */
export async function primeSwingPingAudio() {
  const ctx = getOrCreateContext();
  if (!ctx) return;
  if (ctx.state === "suspended") await ctx.resume();
}

/**
 * Two-tone “ping” (soft, short). No-ops if Web Audio unavailable or debounced.
 */
export function playSwingPing() {
  try {
    const now = Date.now();
    if (now - lastPlayAt < MIN_INTERVAL_MS) return;

    const ctx = getOrCreateContext();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();

    const t0 = ctx.currentTime;
    const vol = 0.11;

    const tone = (start, freq, duration, type = "sine") => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(vol, start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + duration + 0.02);
    };

    tone(t0, 880, 0.1);
    tone(t0 + 0.09, 1174, 0.12);

    lastPlayAt = now;
  } catch {
    /* ignore */
  }
}

/**
 * “Boo-boo” alert: two short, lower beeps for off-plane (triangle) outcomes.
 */
export function playSwingOffBoo() {
  try {
    const now = Date.now();
    if (now - lastPlayAt < MIN_INTERVAL_MS) return;

    const ctx = getOrCreateContext();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();

    const t0 = ctx.currentTime;
    const vol = 0.12;

    const beep = (start, freq, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(vol, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + duration + 0.02);
    };

    beep(t0, 220, 0.11);
    beep(t0 + 0.16, 196, 0.11);

    lastPlayAt = now;
  } catch {
    /* ignore */
  }
}

/**
 * “Way off” alert: harsher/lower double-beep.
 */
export function playSwingWayOffBoo() {
  try {
    const now = Date.now();
    if (now - lastPlayAt < MIN_INTERVAL_MS) return;

    const ctx = getOrCreateContext();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();

    const t0 = ctx.currentTime;
    const vol = 0.14;

    const beep = (start, freq, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(vol, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + duration + 0.02);
    };

    beep(t0, 164, 0.13);
    beep(t0 + 0.17, 146, 0.13);

    lastPlayAt = now;
  } catch {
    /* ignore */
  }
}

/**
 * Convenience: choose summary sound by worst level.\n
 * @param {{ worstLevel: 0|1|2|3|null }} args
 */
export function playSwingSummarySound({ worstLevel }) {
  if (worstLevel === 3) playSwingWayOffBoo();
  else if (worstLevel === 2) playSwingOffBoo();
  else playSwingPing();
}

/**
 * “Ready” cue when the plane line locks at address.
 * Short rising chirp (distinct from summary sounds).
 */
export function playReadyCue() {
  try {
    const now = Date.now();
    if (now - lastPlayAt < 250) return;

    const ctx = getOrCreateContext();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();

    const t0 = ctx.currentTime;
    const vol = 0.085;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(660, t0);
    osc.frequency.exponentialRampToValueAtTime(1320, t0 + 0.12);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.18);

    lastPlayAt = now;
  } catch {
    /* ignore */
  }
}
