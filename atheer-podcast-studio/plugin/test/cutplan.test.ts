import assert from "node:assert/strict";
import { test } from "node:test";
import { type SourceItem, keptIntervals, mapTime, normaliseRanges, planCuts, uniqueSegments } from "../src/core/cutplan.ts";

const F = 10160640000n; // ticks per frame at 25 fps
const f = (n: number) => BigInt(n) * F;

function item(key: string, kind: "video" | "audio", track: number, start: number, end: number, inPoint = 0, extra: Partial<SourceItem> = {}): SourceItem {
  return { key, kind, track, start: f(start), end: f(end), inPoint: f(inPoint), speed: 1, disabled: false, media: key.split(":")[0]!, ...extra };
}

test("ranges are frame-aligned, clamped, sorted and merged", () => {
  const r = normaliseRanges([
    { start: f(50) + 3n, end: f(60) },
    { start: f(10), end: f(20) },
    { start: f(18), end: f(25) }, // overlaps previous
    { start: f(25), end: f(30) }, // touches -> merged
    { start: f(90), end: f(200) }, // clamped to end
    { start: f(40), end: f(40) }, // empty
  ], F, f(100));
  assert.deepEqual(r, [{ start: f(10), end: f(30) }, { start: f(50), end: f(60) }, { start: f(90), end: f(100) }]);
  assert.deepEqual(keptIntervals(r, f(100)), [{ start: 0n, end: f(10) }, { start: f(30), end: f(50) }, { start: f(60), end: f(90) }]);
  assert.equal(mapTime(f(35), r), f(15));
  assert.equal(mapTime(f(55), r), f(30)); // inside a removed range snaps to its start
});

test("the same interval is removed from every camera and mic, keeping sync", () => {
  // Three cameras and two mics, each starting at a different media offset (synced).
  const items = [
    item("wide:1", "video", 0, 0, 100, 500),
    item("host:1", "video", 1, 0, 100, 120),
    item("guest:1", "video", 2, 0, 100, 7),
    item("mic1:1", "audio", 0, 0, 100, 1000),
    item("mic2:1", "audio", 1, 0, 100, 2000),
  ];
  const plan = planCuts(items, { tpf: F, sequenceEnd: f(100), remove: [{ start: f(40), end: f(50) }] });
  assert.equal(plan.removedTicks, f(10));
  assert.equal(plan.newEnd, f(90));
  assert.equal(plan.pieces.length, 10);
  for (const key of ["wide", "host", "guest", "mic1", "mic2"]) {
    const ps = plan.pieces.filter((p) => p.media === key);
    const base = items.find((i) => i.media === key)!.inPoint;
    assert.deepEqual(ps.map((p) => [p.dest, p.srcIn - base, p.srcOut - base]), [
      [0n, 0n, f(40)],
      [f(40), f(50), f(100)],
    ], key);
  }
});

test("items not covering the whole range, gaps and multiple removals", () => {
  const items = [
    item("a:1", "video", 0, 10, 30), // ends inside the second removal
    item("b:1", "video", 0, 35, 80, 100), // starts inside it
  ];
  const plan = planCuts(items, { tpf: F, sequenceEnd: f(80), remove: [{ start: f(0), end: f(5) }, { start: f(20), end: f(40) }] });
  // removed 5 + 20 = 25 frames
  assert.deepEqual(plan.pieces.map((p) => [p.itemKey, p.dest / F, p.srcIn / F, p.srcOut / F]), [
    ["a:1", 5n, 0n, 10n],
    ["b:1", 15n, 105n, 145n],
  ]);
});

test("split points cut items without removing time (Auto Director)", () => {
  const items = [item("host:1", "video", 1, 0, 30), item("mic:1", "audio", 0, 0, 30)];
  const plan = planCuts(items, { tpf: F, sequenceEnd: f(30), splitAt: [f(10), f(20), f(20), f(50)] });
  const video = plan.pieces.filter((p) => p.kind === "video");
  assert.deepEqual(video.map((p) => [p.dest / F, p.srcIn / F, p.srcOut / F]), [[0n, 0n, 10n], [10n, 10n, 20n], [20n, 20n, 30n]]);
  assert.equal(plan.removedTicks, 0n);
});

test("speed-changed clips are reported, never silently cut wrong", () => {
  const plan = planCuts([item("x:1", "video", 0, 0, 10, 0, { speed: 2 })], { tpf: F, sequenceEnd: f(10) });
  assert.equal(plan.pieces.length, 0);
  assert.match(plan.skipped[0]!.reason, /speed 200%/);
});

test("disabled state is carried to the pieces", () => {
  const plan = planCuts([item("x:1", "video", 0, 0, 10, 0, { disabled: true })], { tpf: F, sequenceEnd: f(10), remove: [{ start: f(2), end: f(4) }] });
  assert.ok(plan.pieces.every((p) => p.disabled));
});

test("pieces that use the same media range share one subclip", () => {
  // camera video + camera audio from the same file and same range -> two segments (video, audio)
  const items = [item("cam:v", "video", 0, 0, 10), { ...item("cam:a", "audio", 2, 0, 10), media: "cam" }];
  const plan = planCuts(items, { tpf: F, sequenceEnd: f(10), remove: [{ start: f(4), end: f(6) }] });
  assert.equal(plan.pieces.length, 4);
  assert.equal(uniqueSegments(plan.pieces).length, 4);
  const dup = planCuts([item("cam:1", "video", 0, 0, 10), item("cam:2", "video", 1, 0, 10)], { tpf: F, sequenceEnd: f(10) });
  assert.equal(uniqueSegments(dup.pieces).length, 1);
});

test("a two-hour episode with 600 pauses plans quickly", () => {
  const end = f(25 * 7200);
  const items = [0, 1, 2].map((t) => item(`cam${t}:1`, "video", t, 0, 25 * 7200)).concat(
    [0, 1].map((t) => item(`mic${t}:1`, "audio", t, 0, 25 * 7200)));
  const remove = Array.from({ length: 600 }, (_, i) => ({ start: f(i * 300 + 100), end: f(i * 300 + 140) }));
  const t0 = Date.now();
  const plan = planCuts(items, { tpf: F, sequenceEnd: end, remove });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(plan.pieces.length, 5 * 601);
  assert.equal(plan.removedTicks, f(600 * 40));
});
