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

    const tone = (start, freq, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
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
