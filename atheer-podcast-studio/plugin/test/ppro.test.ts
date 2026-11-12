import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { __setHostModulesForTests } from "../src/ppro/api.ts";
import { capability, detectCapabilities } from "../src/ppro/capabilities.ts";
import { CHILD_BINS, ROOT_BIN, addMarkerAtPlayhead, ensureProjectBins } from "../src/ppro/edits.ts";
import { readProjectSnapshot } from "../src/ppro/project.ts";
import { TransactionError } from "../src/ppro/transaction.ts";
import { type Fake, FakeClip, FakeFolder, buildFake } from "./fakePremiere.ts";

let fake: Fake;

beforeEach(() => {
  fake = buildFake();
  __setHostModulesForTests(fake.module, {
    name: "premierepro", version: "26.5.1", uiLocale: "en_US", uxpVersion: "9.1.0", pluginVersion: "0.1.0", os: "test",
  });
});

test("snapshot labels tracks by API index and de-duplicates media", async () => {
  const snap = await readProjectSnapshot();
  const seq = snap?.activeSequence;
  assert.ok(seq);
  assert.equal(seq.name, "PODCAST_01");
  assert.deepEqual(seq.fps, { num: 30000, den: 1001 });
  assert.equal(seq.width, 1920);
  assert.equal(seq.playheadTimecode, "00:01:00:00");
  assert.deepEqual(seq.videoTracks.map((t) => [t.label, t.name, t.clipCount]),
    [["V1", "WIDE", 2], ["V2", "HOST", 1], ["V3", "GUEST", 3]]);
  assert.deepEqual(seq.audioTracks.map((t) => t.label), ["A1", "A2"]);

  const byName = Object.fromEntries(seq.media.map((m) => [m.name, m]));
  assert.equal(seq.media.length, 5);
  assert.equal(byName["WIDE.mov"]?.clipCount, 3);
  assert.deepEqual(byName["WIDE.mov"]?.tracks, ["V1", "A2"]);
  assert.equal(byName["GUEST.mov"]?.offline, true);
  assert.equal(seq.skippedItems, 2); // nested sequence + item without project item
});

test("no active sequence is reported, not invented", async () => {
  fake.project.active = null;
  const snap = await readProjectSnapshot();
  assert.equal(snap?.activeSequence, null);
  assert.equal(snap?.sequenceCount, 1);
});

test("bins are created under the lock, idempotently, as undoable steps", async () => {
  // A clip with the root bin's name must not be mistaken for the bin.
  fake.project.root.items.push(new FakeClip(ROOT_BIN, "/Media/ATHEER PODCAST STUDIO.mov"));
  const first = await ensureProjectBins(fake.project as never);
  assert.equal(first.created.length, 1 + CHILD_BINS.length);
  assert.equal(first.undoSteps, 2);
  assert.deepEqual(fake.project.undoStack, ["MAG: Create project bins", "MAG: Create project bins"]);
  const root = fake.project.root.items.find((i) => i instanceof FakeFolder && i.name === ROOT_BIN) as FakeFolder;
  assert.deepEqual(root.items.map((i) => i.name), [...CHILD_BINS]);

  const second = await ensureProjectBins(fake.project as never);
  assert.equal(second.created.length, 0);
  assert.equal(second.undoSteps, 0);
  assert.equal(fake.project.undoStack.length, 2);
});

test("only missing child bins are added", async () => {
  const root = new FakeFolder(ROOT_BIN);
  root.items.push(new FakeFolder("01 Footage"));
  fake.project.root.items.push(root);
  const r = await ensureProjectBins(fake.project as never);
  assert.equal(r.undoSteps, 1);
  assert.equal(r.created.length, CHILD_BINS.length - 1);
});

test("marker goes to the playhead in one undo step", async () => {
  await addMarkerAtPlayhead(fake.project as never, "ATHEER check", "hello");
  assert.deepEqual(fake.sequence.markers.list, [{ name: "ATHEER check", start: 8475667200 * 1800, comment: "hello" }]);
  assert.deepEqual(fake.project.undoStack, ["MAG: Add marker"]);
});

test("a rejected transaction raises and changes nothing", async () => {
  fake.project.rejectNext = true;
  await assert.rejects(addMarkerAtPlayhead(fake.project as never, "x", "y"), TransactionError);
  assert.equal(fake.sequence.markers.list.length, 0);
  assert.equal(fake.project.undoStack.length, 0);
});

test("marker needs an open sequence", async () => {
  fake.project.active = null;
  await assert.rejects(addMarkerAtPlayhead(fake.project as never, "x", "y"), /Open a sequence/);
});

test("capabilities follow documented minimum versions and runtime presence", () => {
  const at265 = detectCapabilities("26.5.1");
  assert.ok(capability(at265, "transactions"));
  assert.ok(capability(at265, "renameTracks"));
  assert.ok(capability(at265, "transcribe"));
  assert.equal(at265.find((c) => c.id === "mogrtText")?.status, "requires_newer_premiere");

  const at262 = detectCapabilities("26.2.0");
  assert.equal(at262.find((c) => c.id === "renameTracks")?.status, "requires_newer_premiere");
  assert.ok(capability(at262, "sequenceFrameRate"));

  // Documented for 27.0 but absent at runtime -> flagged, never assumed.
  const at27 = detectCapabilities("27.0.0");
  assert.equal(at27.find((c) => c.id === "mogrtText")?.status, "missing_at_runtime");
});
