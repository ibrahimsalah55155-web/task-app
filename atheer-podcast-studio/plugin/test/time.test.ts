import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TICKS_PER_SECOND, alignTicks, formatDuration, formatFps, frameRateFromTicksPerFrame, framesToTimecode,
  parseTicks, secondsToTicks, ticksPerFrame, ticksToFrames, ticksToSeconds, ticksToTimecode,
} from "../src/core/time.ts";
import { atLeast, compareVersions, parseVersion } from "../src/core/version.ts";

const RATES: [number, number, bigint][] = [
  [24000, 1001, 10594584000n],
  [24, 1, 10584000000n],
  [25, 1, 10160640000n],
  [30000, 1001, 8475667200n],
  [30, 1, 8467200000n],
  [50, 1, 5080320000n],
  [60000, 1001, 4237833600n],
  [60, 1, 4233600000n],
];

test("ticks per frame is exact for every broadcast rate and round-trips", () => {
  for (const [num, den, tpf] of RATES) {
    assert.equal(ticksPerFrame({ num, den }), tpf, `${num}/${den}`);
    assert.deepEqual(frameRateFromTicksPerFrame(tpf), { num, den });
    assert.deepEqual(frameRateFromTicksPerFrame(String(tpf)), { num, den });
  }
});

test("rounding policies", () => {
  const tpf = 10160640000n; // 25 fps
  const t = tpf * 10n + tpf / 2n; // exactly half a frame past frame 10
  assert.equal(ticksToFrames(t, tpf, "floor"), 10n);
  assert.equal(ticksToFrames(t, tpf, "ceil"), 11n);
  assert.equal(ticksToFrames(t, tpf, "nearest"), 11n);
  assert.equal(ticksToFrames(t - 1n, tpf, "nearest"), 10n);
  assert.equal(ticksToFrames(-t, tpf, "floor"), -11n);
  assert.equal(alignTicks(tpf * 3n + 5n, tpf), tpf * 3n);
});

test("seconds conversions keep precision on long recordings", () => {
  const tenHours = 10 * 3600 + 0.5;
  const ticks = secondsToTicks(tenHours);
  assert.equal(ticks, 36000n * TICKS_PER_SECOND + TICKS_PER_SECOND / 2n);
  assert.equal(ticksToSeconds(ticks), tenHours);
  assert.throws(() => secondsToTicks(Number.NaN));
});

test("parseTicks validates input", () => {
  assert.equal(parseTicks("254016000000"), TICKS_PER_SECOND);
  assert.throws(() => parseTicks("12.5"));
  assert.throws(() => parseTicks("abc"));
});

test("non-drop and drop-frame timecode", () => {
  const ntsc = { num: 30000, den: 1001 };
  assert.equal(framesToTimecode(0, { num: 25, den: 1 }), "00:00:00:00");
  assert.equal(framesToTimecode(90000, { num: 25, den: 1 }), "01:00:00:00");
  assert.equal(framesToTimecode(1800, ntsc), "00:01:00:00");
  assert.equal(framesToTimecode(1800, ntsc, true), "00:01:00;02");
  assert.equal(framesToTimecode(1799, ntsc, true), "00:00:59;29");
  assert.equal(framesToTimecode(17982, ntsc, true), "00:10:00;00");
  assert.equal(framesToTimecode(107892, ntsc, true), "01:00:00;00");
  assert.equal(framesToTimecode(3600, { num: 60000, den: 1001 }, true), "00:01:00;04");
  // drop-frame is ignored for rates that do not support it
  assert.equal(framesToTimecode(1500, { num: 25, den: 1 }, true), "00:01:00:00");
  assert.equal(ticksToTimecode(8475667200n * 1800n, ntsc), "00:01:00:00");
});

test("display helpers", () => {
  assert.equal(formatDuration(3725), "1:02:05");
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(null), "—");
  assert.equal(formatFps({ num: 30000, den: 1001 }), "29.97");
  assert.equal(formatFps({ num: 24000, den: 1001 }), "23.976");
  assert.equal(formatFps({ num: 25, den: 1 }), "25");
});

test("version comparison", () => {
  assert.deepEqual(parseVersion("27.0.0-beta.22"), [27, 0, 0]);
  assert.deepEqual(parseVersion("26.3"), [26, 3, 0]);
  assert.equal(parseVersion("x"), null);
  assert.equal(compareVersions([26, 5, 1], [26, 10, 0]), -1);
  assert.ok(atLeast("26.5.1", "26.3"));
  assert.ok(!atLeast("26.2.0", "26.3"));
  assert.ok(!atLeast(undefined, "25.6"));
});
