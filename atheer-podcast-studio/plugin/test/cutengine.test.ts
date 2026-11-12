import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { __setHostModulesForTests } from "../src/ppro/api.ts";
import { SEGMENTS_BIN, buildCutSequence, sequenceInOut } from "../src/ppro/cutengine.ts";
import { ROOT_BIN } from "../src/ppro/edits.ts";
import {
  FakeClip, FakeFolder, FakeProject, FakeSequence, FakeTrack, FakeTrackItem, buildFake, editorFaults,
} from "./fakePremiere.ts";

const F = 10160640000; // 25 fps
const sec = (s: number) => s * 25 * F;
let project: FakeProject;
let source: FakeSequence;

function podcast() {
  const cam = (n: string) => new FakeClip(`${n}.mov`, `/Media/${n}.mov`);
  const wide = cam("WIDE"), host = cam("HOST"), guest = cam("GUEST");
  const mic1 = new FakeClip("TR1.wav", "/Media/TR1.wav"), mic2 = new FakeClip("TR2.wav", "/Media/TR2.wav");
  const len = sec(60);
  // Synced: each source has its own media offset (in point).
  const seq = new FakeSequence("PODCAST_01", [
    new FakeTrack("Wide Camera", [new FakeTrackItem(wide, 0, len, sec(3))]),
    new FakeTrack("Host Camera", [new FakeTrackItem(host, 0, len, sec(1))]),
    new FakeTrack("Guest Camera", [new FakeTrackItem(guest, 0, len, sec(7))]),
  ], [
    new FakeTrack("Guest Mic", [new FakeTrackItem(mic1, 0, len, sec(10))]),
    new FakeTrack("Host Mic", [new FakeTrackItem(mic2, 0, len, sec(12))]),
  ], F);
  seq.end = len;
  return seq;
}

beforeEach(() => {
  const fake = buildFake();
  source = podcast();
  project = new FakeProject(source);
  __setHostModulesForTests(fake.module, null);
  editorFaults.wrongLength = false;
});

const snapshot = (s: FakeSequence) => JSON.stringify([...s.video, ...s.audio].map((t) => t.items.map((i) => [i.start, i.end, i.inPoint, i.clip?.id])));

test("removing In→Out builds a verified, synced copy and leaves the original alone", async () => {
  const original = snapshot(source);
  source.inPoint = sec(20);
  source.outPoint = sec(25);
  const range = await sequenceInOut(source as never);
  assert.ok(range);
  const steps: string[] = [];
  const r = await buildCutSequence(project as never, source as never, {
    remove: [range], newName: "PODCAST_01_CUT_TEST", onProgress: (s) => steps.push(s),
  });

  assert.equal(snapshot(source), original, "source sequence must not change");
  assert.deepEqual(r.mismatches, []);
  assert.equal(r.verified, 10); // 5 tracks x 2 pieces
  assert.equal(r.subclips, 10);
  assert.equal(steps.at(-1), "done");

  const out = project.sequences.find((s) => s !== source)!;
  assert.equal(out.item?.name, "PODCAST_01_CUT_TEST");
  assert.equal(project.opened, out);
  // every track: [0,20s) then [20s,55s); total 55 s
  for (const t of [...out.video, ...out.audio]) {
    assert.deepEqual(t.items.map((i) => [i.start / F, i.end / F]), [[0, 500], [500, 1375]], t.name);
    const second = t.items[1]!.clip!.sub!;
    const first = t.items[0]!.clip!.sub!;
    assert.equal(second.inT - first.inT, sec(25), `${t.name}: media jumps exactly 25 s, so sync holds`);
  }
  // subclips filed under the plugin bins
  const root = project.root.items.find((i) => i instanceof FakeFolder && i.name === ROOT_BIN) as FakeFolder;
  const segRoot = root.items.find((i) => i.name === SEGMENTS_BIN) as FakeFolder;
  const segBin = segRoot.items.find((i) => i.name === "PODCAST_01_CUT_TEST") as FakeFolder;
  assert.equal(segBin.items.length, 10);
  assert.ok(project.root.items.every((i) => !(i instanceof FakeClip && i.sub)), "no stray subclips left in the root bin");
  assert.ok(project.undoStack.every((u) => u.startsWith("MAG:")));
});

test("video-only and audio-only subclips: camera audio is never duplicated", async () => {
  source.inPoint = sec(5);
  source.outPoint = sec(6);
  await buildCutSequence(project as never, source as never, { remove: [(await sequenceInOut(source as never))!], newName: "X" });
  const out = project.sequences.find((s) => s !== source)!;
  for (const t of out.video) for (const i of t.items) assert.deepEqual([i.clip!.sub!.video, i.clip!.sub!.audio], [true, false]);
  for (const t of out.audio) for (const i of t.items) assert.deepEqual([i.clip!.sub!.video, i.clip!.sub!.audio], [false, true]);
});

test("disabled clips stay disabled in the copy", async () => {
  source.video[2]!.items[0]!.disabled = true;
  await buildCutSequence(project as never, source as never, { remove: [{ start: BigInt(sec(10)), end: BigInt(sec(12)) }], newName: "Y" });
  const out = project.sequences.find((s) => s !== source)!;
  assert.ok(out.video[2]!.items.every((i) => i.disabled));
  assert.ok(out.video[0]!.items.every((i) => !i.disabled));
});

test("split points (Auto Director) keep duration and cut every camera at the same frames", async () => {
  const r = await buildCutSequence(project as never, source as never, {
    splitAt: [BigInt(sec(10)), BigInt(sec(30))], newName: "PODCAST_01_DIRECTOR",
  });
  assert.equal(r.plan.removedTicks, 0n);
  const out = project.sequences.find((s) => s !== source)!;
  for (const t of out.video) assert.deepEqual(t.items.map((i) => i.start / F), [0, 250, 750]);
});

test("verification catches a Premiere placement that differs from the plan", async () => {
  editorFaults.wrongLength = true;
  const r = await buildCutSequence(project as never, source as never, { remove: [{ start: BigInt(sec(1)), end: BigInt(sec(2)) }], newName: "Z" });
  assert.ok(r.mismatches.length > 0);
  assert.match(r.mismatches[0]!, /length/);
});

test("In/Out not set means no test range", async () => {
  assert.equal(await sequenceInOut(source as never), null);
});

test("speed-changed clips stop the run before anything is changed", async () => {
  source.video[0]!.items[0]!.speed = 2;
  await assert.rejects(buildCutSequence(project as never, source as never, { remove: [{ start: 0n, end: BigInt(sec(1)) }], newName: "S" }), /speed/);
  assert.equal(project.undoStack.length, 0);
});
