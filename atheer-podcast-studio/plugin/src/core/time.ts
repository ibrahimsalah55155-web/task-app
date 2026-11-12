/**
 * Exact time math for Premiere timelines.
 *
 * Premiere measures time in ticks: 254,016,000,000 per second. Every common
 * frame rate (23.976, 24, 25, 29.97, 30, 50, 59.94, 60) has a whole number of
 * ticks per frame, so frame-aligned edits can be computed exactly with BigInt.
 * Floating-point seconds are only used at the edges (display, companion JSON).
 */

export const TICKS_PER_SECOND = 254_016_000_000n;

export interface Rational {
  num: number;
  den: number;
}

export type Rounding = "floor" | "nearest" | "ceil";

export function parseTicks(ticks: string | number | bigint): bigint {
  if (typeof ticks === "bigint") return ticks;
  if (typeof ticks === "number") {
    if (!Number.isFinite(ticks)) throw new RangeError(`invalid ticks: ${ticks}`);
    return BigInt(Math.round(ticks));
  }
  const s = ticks.trim();
  if (!/^-?\d+$/.test(s)) throw new RangeError(`invalid ticks: ${ticks}`);
  return BigInt(s);
}

/** Ticks per frame for an exact frame rate, e.g. {30000, 1001} -> 8475667200n. */
export function ticksPerFrame(fps: Rational): bigint {
  if (fps.num <= 0 || fps.den <= 0) throw new RangeError("frame rate must be positive");
  const n = TICKS_PER_SECOND * BigInt(fps.den);
  const d = BigInt(fps.num);
  if (n % d !== 0n) throw new RangeError(`${fps.num}/${fps.den} fps has no whole ticks per frame`);
  return n / d;
}

/** Inverse of ticksPerFrame. Recognises the NTSC family exactly. */
export function frameRateFromTicksPerFrame(tpf: bigint | number | string): Rational {
  const t = parseTicks(tpf as string);
  if (t <= 0n) throw new RangeError("ticks per frame must be positive");
  for (const den of [1, 1001]) {
    const num = (TICKS_PER_SECOND * BigInt(den)) / t;
    if ((TICKS_PER_SECOND * BigInt(den)) % t === 0n && ticksPerFrame({ num: Number(num), den }) === t) {
      return { num: Number(num), den };
    }
  }
  // Unusual rate: express as an exact fraction ticks/second over ticks/frame.
  const g = gcd(TICKS_PER_SECOND, t);
  return { num: Number(TICKS_PER_SECOND / g), den: Number(t / g) };
}

export function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}

function divRound(n: bigint, d: bigint, rounding: Rounding): bigint {
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  const negative = (n < 0n) !== (d < 0n);
  switch (rounding) {
    case "floor":
      return negative ? q - 1n : q;
    case "ceil":
      return negative ? q : q + 1n;
    case "nearest": {
      const twice = (r < 0n ? -r : r) * 2n;
      const ad = d < 0n ? -d : d;
      if (twice < ad) return q;
      // ties round away from zero
      return negative ? q - 1n : q + 1n;
    }
  }
}

export function ticksToFrames(ticks: bigint, tpf: bigint, rounding: Rounding = "nearest"): bigint {
  return divRound(ticks, tpf, rounding);
}

export function framesToTicks(frames: bigint | number, tpf: bigint): bigint {
  return BigInt(frames) * tpf;
}

/** Snap a tick position to the frame grid. */
export function alignTicks(ticks: bigint, tpf: bigint, rounding: Rounding = "nearest"): bigint {
  return ticksToFrames(ticks, tpf, rounding) * tpf;
}

export function secondsToTicks(seconds: number): bigint {
  if (!Number.isFinite(seconds)) throw new RangeError(`invalid seconds: ${seconds}`);
  // Split to keep precision for multi-hour recordings (float ticks exceed 2^53 after ~9.8h).
  const whole = Math.trunc(seconds);
  const frac = seconds - whole;
  return BigInt(whole) * TICKS_PER_SECOND + BigInt(Math.round(frac * Number(TICKS_PER_SECOND)));
}

export function ticksToSeconds(ticks: bigint): number {
  const whole = ticks / TICKS_PER_SECOND;
  const rest = ticks % TICKS_PER_SECOND;
  return Number(whole) + Number(rest) / Number(TICKS_PER_SECOND);
}

/** Drop-frame applies to 29.97 and 59.94 only. */
export function supportsDropFrame(fps: Rational): boolean {
  return fps.den === 1001 && (fps.num === 30000 || fps.num === 60000);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/**
 * SMPTE timecode for a frame count. Drop-frame (";" separator) skips frame
 * numbers 0 and 1 (0-3 at 59.94) every minute except every tenth minute.
 */
export function framesToTimecode(frame: number, fps: Rational, dropFrame = false): string {
  if (!Number.isInteger(frame)) throw new RangeError("frame must be an integer");
  const negative = frame < 0;
  let f = Math.abs(frame);
  const nominal = Math.round(fps.num / fps.den);
  const df = dropFrame && supportsDropFrame(fps);
  if (df) {
    const dropped = nominal === 60 ? 4 : 2;
    const perMinute = nominal * 60 - dropped;
    const per10 = perMinute * 10 + dropped;
    const tens = Math.floor(f / per10);
    const rem = f % per10;
    f += dropped * 9 * tens + (rem > dropped ? dropped * Math.floor((rem - dropped) / perMinute) : 0);
  }
  const ff = f % nominal;
  const totalSeconds = Math.floor(f / nominal);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  const sep = df ? ";" : ":";
  return `${negative ? "-" : ""}${pad(hh)}:${pad(mm)}:${pad(ss)}${sep}${pad(ff)}`;
}

export function ticksToTimecode(ticks: bigint, fps: Rational, dropFrame = false): string {
  const frames = ticksToFrames(ticks, ticksPerFrame(fps), "floor");
  return framesToTimecode(Number(frames), fps, dropFrame);
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function formatFps(fps: Rational | null | undefined): string {
  if (!fps) return "—";
  const v = fps.num / fps.den;
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, "");
}
