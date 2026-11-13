/**
 * Closed-loop colour matching with Lumetri.
 *
 * Lumetri's Basic Correction sliders have no published mapping to measurable
 * colour. Instead of guessing, each slider is paired with the statistic it
 * mostly moves, and the panel iterates: set sliders -> Premiere renders a
 * frame -> the engine measures it -> update the sliders with the slope actually
 * observed on this footage (secant method). Pure and testable.
 */

export interface ColorStats { L: number; Lstd: number; a: number; b: number; chroma: number }
export type LumetriKey = "exposure" | "temperature" | "tint" | "contrast" | "saturation";
export type LumetriValues = Record<LumetriKey, number>;

/** Which measurement each slider drives, a first guess of the slope (slider units per stat unit), and the range. */
export const SLIDERS: Record<LumetriKey, { stat: keyof ColorStats; gain: number; min: number; max: number; neutral: number }> = {
  exposure: { stat: "L", gain: 1 / 16, min: -2, max: 2, neutral: 0 },
  temperature: { stat: "b", gain: 3, min: -60, max: 60, neutral: 0 },
  tint: { stat: "a", gain: 3, min: -60, max: 60, neutral: 0 },
  contrast: { stat: "Lstd", gain: 6, min: -60, max: 60, neutral: 0 },
  saturation: { stat: "chroma", gain: 4, min: 40, max: 180, neutral: 100 },
};
export const KEYS = Object.keys(SLIDERS) as LumetriKey[];

export const neutral = (): LumetriValues =>
  Object.fromEntries(KEYS.map((k) => [k, SLIDERS[k].neutral])) as LumetriValues;

export function error(cur: ColorStats, target: ColorStats): number {
  return Math.hypot(target.L - cur.L, target.a - cur.a, target.b - cur.b);
}

export interface SolverState {
  values: LumetriValues;
  gains: Record<LumetriKey, number>;
  last: { values: LumetriValues; stats: ColorStats } | null;
}

export function startSolver(): SolverState {
  return { values: neutral(), gains: Object.fromEntries(KEYS.map((k) => [k, SLIDERS[k].gain])) as Record<LumetriKey, number>, last: null };
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Given what the frame looks like with `state.values`, return the next slider values. */
export function step(state: SolverState, measured: ColorStats, target: ColorStats): SolverState {
  const gains = { ...state.gains };
  if (state.last) {
    for (const k of KEYS) {
      const s = SLIDERS[k];
      const dv = state.values[k] - state.last.values[k];
      const ds = measured[s.stat] - state.last.stats[s.stat];
      if (Math.abs(dv) > 1e-6 && Math.abs(ds) > 0.25) {
        // Observed slope on this footage. Keep it within 1/8x..8x of the first guess; the sign may flip.
        const g = dv / ds;
        const mag = clamp(Math.abs(g), s.gain / 8, s.gain * 8);
        gains[k] = Math.sign(g) * mag;
      }
    }
  }
  const values = { ...state.values };
  for (const k of KEYS) {
    const s = SLIDERS[k];
    const d = target[s.stat] - measured[s.stat];
    values[k] = clamp(values[k] + gains[k] * d, s.min, s.max);
  }
  return { values, gains, last: { values: state.values, stats: measured } };
}

export function good(cur: ColorStats, target: ColorStats): boolean {
  return error(cur, target) < 2.5 && Math.abs(target.Lstd - cur.Lstd) < 2 && Math.abs(target.chroma - cur.chroma) < 3;
}
