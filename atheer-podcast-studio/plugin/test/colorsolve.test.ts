import assert from "node:assert/strict";
import { test } from "node:test";
import { type ColorStats, type LumetriValues, good, error, startSolver, step } from "../src/core/colorsolve.ts";

/** A stand-in for "Premiere renders the frame with these Lumetri values": unknown scales and some cross-talk. */
function premiere(base: ColorStats, v: LumetriValues, k: { exp: number; temp: number; tint: number; con: number; sat: number }): ColorStats {
  const L = base.L + k.exp * v.exposure * (1 - base.L / 120) + 0.04 * v.contrast;
  return {
    L,
    Lstd: base.Lstd * (1 + k.con * v.contrast),
    a: base.a + k.tint * v.tint + 0.05 * v.temperature,
    b: base.b + k.temp * v.temperature - 0.03 * v.tint,
    chroma: base.chroma * (v.saturation / 100) + 0.02 * Math.abs(v.temperature),
  };
}

const target: ColorStats = { L: 55, Lstd: 22, a: 2, b: 8, chroma: 20 };

for (const [name, cam, k] of [
  ["dark, magenta, flat camera", { L: 47, Lstd: 18, a: 9, b: -4, chroma: 15 }, { exp: 22, temp: 0.4, tint: 0.5, con: 0.006, sat: 1 }],
  ["bright, green, punchy camera", { L: 63, Lstd: 27, a: -6, b: 15, chroma: 27 }, { exp: 12, temp: 0.25, tint: 0.2, con: 0.01, sat: 1 }],
  ["tint slider works the other way", { L: 50, Lstd: 20, a: 7, b: 3, chroma: 18 }, { exp: 16, temp: 0.33, tint: -0.4, con: 0.008, sat: 1 }],
] as const) {
  test(`colour solver converges: ${name}`, () => {
    let s = startSolver();
    let cur = premiere(cam, s.values, k);
    const start = error(cur, target);
    let rounds = 0;
    while (!good(cur, target) && rounds < 6) {
      s = step(s, cur, target);
      cur = premiere(cam, s.values, k);
      rounds++;
    }
    assert.ok(good(cur, target), `after ${rounds} rounds error ${error(cur, target).toFixed(2)} (start ${start.toFixed(2)}), ${JSON.stringify(cur)}`);
    assert.ok(rounds <= 6);
  });
}

test("solver keeps sliders inside Lumetri's sensible range", () => {
  let s = startSolver();
  const cam = { L: 10, Lstd: 3, a: 40, b: -40, chroma: 2 };
  for (let i = 0; i < 4; i++) s = step(s, cam, target); // a camera that never responds
  assert.ok(s.values.exposure <= 2 && s.values.saturation <= 180 && Math.abs(s.values.tint) <= 60);
});
