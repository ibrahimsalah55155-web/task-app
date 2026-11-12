import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { __setHostModulesForTests } from "../src/ppro/api.ts";
import { ROOT_BIN } from "../src/ppro/edits.ts";
import { GRAPHICS_BIN, chooseTrack, insertGraphicAtPlayhead, relinkGraphic } from "../src/ppro/graphics.ts";
import { FakeClip, FakeFolder, FakeProject, FakeSequence, FakeTrack, FakeTrackItem, TPS, buildFake } from "./fakePremiere.ts";

const sec = (s: number) => BigInt(Math.round(s * TPS));

test("graphic goes above every busy track, never onto a clip", () => {
  const busy = [[{ start: sec(0), end: sec(100) }], [{ start: sec(0), end: sec(100) }], [{ start: sec(50), end: sec(60) }], []];
  assert.deepEqual(chooseTrack(busy, { start: sec(10), end: sec(16) }), { index: 2, isNew: false });
  assert.deepEqual(chooseTrack(busy, { start: sec(55), end: sec(61) }), { index: 3, isNew: false });
  assert.deepEqual(chooseTrack(busy.slice(0, 3), { start: sec(55), end: sec(61) }), { index: 3, isNew: true });
  // an empty track BELOW a busy one is not used: the graphic would be hidden
  const gap = [[{ start: sec(0), end: sec(100) }], [], [{ start: sec(0), end: sec(100) }]];
  assert.deepEqual(chooseTrack(gap, { start: sec(1), end: sec(2) }), { index: 3, isNew: true });
});

let project: FakeProject;
let seq: FakeSequence;

beforeEach(() => {
  const fake = buildFake();
  const cam = new FakeClip("CAM.mov", "/Media/CAM.mov");
  seq = new FakeSequence("EP", [
    new FakeTrack("Wide Camera", [new FakeTrackItem(cam, 0, TPS * 100, 0)]),
    new FakeTrack("Host Camera", [new FakeTrackItem(cam, 0, TPS * 100, 0)]),
    new FakeTrack("Guest Camera", [new FakeTrackItem(cam, 0, TPS * 100, 0)]),
  ], [], 10160640000, TPS * 30);
  project = new FakeProject(seq);
  __setHostModulesForTests(fake.module, null);
});

test("insert imports once into the Graphics bin and creates a track above the cameras", async () => {
  const r = await insertGraphicAtPlayhead(project as never, seq as never, "C:\\Proj\\MAG Graphics\\MAG_lower_third_x.mov", 6);
  assert.deepEqual([r.trackIndex, r.newTrack], [3, true]);
  assert.equal(seq.video.length, 4);
  const placed = seq.video[3]!.items[0]!;
  assert.equal(placed.start, TPS * 30);
  assert.equal(placed.end, TPS * 36);
  for (const t of seq.video.slice(0, 3)) assert.equal(t.items.length, 1, "camera clips untouched");
  const app = project.root.items.find((i) => i instanceof FakeFolder && i.name === ROOT_BIN) as FakeFolder;
  const gbin = app.items.find((i) => i.name === GRAPHICS_BIN) as FakeFolder;
  assert.equal(gbin.items.length, 1);

  // second graphic at a later time reuses the now-free V4; same file is not imported twice
  seq.playhead = TPS * 50;
  const r2 = await insertGraphicAtPlayhead(project as never, seq as never, "c:/proj/mag graphics/MAG_lower_third_x.mov", 6);
  assert.deepEqual([r2.trackIndex, r2.newTrack], [3, false]);
  assert.equal(project.imports.length, 1);
  assert.equal(seq.video[3]!.items.length, 2);
  assert.deepEqual(project.undoStack.slice(-2), ["MAG: Insert graphic", "MAG: Insert graphic"]);
});

test("overlapping graphics stack instead of replacing each other", async () => {
  await insertGraphicAtPlayhead(project as never, seq as never, "/g/a.mov", 6);
  seq.playhead = TPS * 33; // overlaps the first graphic
  const r = await insertGraphicAtPlayhead(project as never, seq as never, "/g/b.mov", 6);
  assert.deepEqual([r.trackIndex, r.newTrack], [4, true]);
  assert.equal(seq.video[3]!.items.length, 1);
});

test("editing text relinks the placed graphic to the new render", async () => {
  await insertGraphicAtPlayhead(project as never, seq as never, "/g/old.mov", 6);
  await relinkGraphic(project as never, "/g/old.mov", "/g/new.mov");
  assert.equal(seq.video[3]!.items[0]!.clip!.relinkedTo, "/g/new.mov");
});
