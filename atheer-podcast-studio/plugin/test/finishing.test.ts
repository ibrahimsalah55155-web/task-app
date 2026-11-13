import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { __setHostModulesForTests } from "../src/ppro/api.ts";
import {
  clipsUsingFile, ensureLumetri, exportFrame, freeVideoTrack, insertMogrt, lumetriParams, mogrtFields, nestForMulticam,
  probeSequence, setLumetri, setMogrtText, srtToCaptionTrack, swapMedia,
} from "../src/ppro/finishing.ts";
import { FakeClip, type FakeComponent, FakeFolder, FakeProject, FakeSequence, FakeTrack, FakeTrackItem, TPS, buildFake } from "./fakePremiere.ts";

let fake: ReturnType<typeof buildFake>;
let project: FakeProject;
let seq: FakeSequence;
const F = 10160640000; // 25 fps

beforeEach(() => {
  fake = buildFake();
  const mic = new FakeClip("Guest Mic.wav", "C:\\Shoot\\Guest Mic.wav");
  const sub = new FakeClip("Guest Mic.wav A 00:00:10:00 [X-1]", "C:\\Shoot\\Guest Mic.wav");
  const cam = new FakeClip("HOST.mov", "C:\\Shoot\\HOST.mov");
  seq = new FakeSequence("PODCAST_01", [new FakeTrack("Host Camera", [new FakeTrackItem(cam, 0, 60 * TPS, 0)])],
    [new FakeTrack("Guest Mic", [new FakeTrackItem(mic, 0, 60 * TPS, 0)])], F);
  seq.end = 0;
  project = new FakeProject(seq);
  const bin = new FakeFolder("Footage");
  bin.items.push(mic, sub, cam);
  project.root.items.push(bin);
  __setHostModulesForTests(fake.module, null);
});

test("voice clean-up swaps every clip of the mic file (master + cut pieces) and back", async () => {
  assert.equal((await clipsUsingFile(project as never, "c:/shoot/guest mic.wav")).length, 2);
  const r = await swapMedia(project as never, [{ from: "C:\\Shoot\\Guest Mic.wav", to: "C:\\Proj\\MAG Clean Audio\\Guest Mic_MAG_clean_standard.wav" }]);
  assert.equal(r[0]!.clips, 2);
  assert.deepEqual(r[0]!.failed, []);
  assert.equal((await clipsUsingFile(project as never, "C:\\Shoot\\Guest Mic.wav")).length, 0);
  const back = await swapMedia(project as never, [{ from: "C:\\Proj\\MAG Clean Audio\\Guest Mic_MAG_clean_standard.wav", to: "C:\\Shoot\\Guest Mic.wav" }]);
  assert.equal(back[0]!.clips, 2);
  // Video files are never swapped (the picture would go offline).
  const v = await swapMedia(project as never, [{ from: "C:\\Shoot\\HOST.mov", to: "C:\\x.wav" }]);
  assert.equal(v[0]!.clips, 0);
  assert.match(v[0]!.failed[0]!, /audio-only/);
});

test("Lumetri is added once to the master clip, its Basic sliders are found and set, undoably", async () => {
  const [cam] = await clipsUsingFile(project as never, "C:\\Shoot\\HOST.mov");
  const comp = await ensureLumetri(project as never, cam!);
  const again = await ensureLumetri(project as never, cam!);
  assert.equal(comp, again);
  assert.equal((cam as unknown as FakeClip).chain.comps.filter((c) => c.matchName === "AE.ADBE Lumetri").length, 1);
  const params = lumetriParams(comp);
  assert.deepEqual(Object.keys(params).sort(), ["contrast", "exposure", "saturation", "temperature", "tint"]);
  const missing = await setLumetri(project as never, comp, { exposure: 0.4, temperature: -12, tint: 5, contrast: 8, saturation: 115 });
  assert.deepEqual(missing, []);
  const fc = comp as unknown as FakeComponent;
  const val = (n: string) => fc.params.find((p) => p.displayName === n)!.value;
  assert.equal(val("Exposure"), 0.4);
  assert.equal(val("Temperature"), -12);
  // "Saturation" appears twice in Lumetri (Basic, then Creative): only the first is driven.
  assert.deepEqual(fc.params.filter((p) => p.displayName === "Saturation").map((p) => p.value), [115, 100]);
  assert.ok(project.undoStack.filter((u) => u.includes("Lumetri")).length >= 2);
});

test("colour probe: a one-camera sequence renders frames and is deleted afterwards", async () => {
  const [cam] = await clipsUsingFile(project as never, "C:\\Shoot\\HOST.mov");
  const probe = await probeSequence(project as never, cam!, "MAG colour probe Host");
  const path = await exportFrame(probe, 12.5, "C:\\Proj\\MAG Colour", "probe_1.png", 480, 270);
  assert.equal(path, "C:\\Proj\\MAG Colour\\probe_1.png");
  const frames = (fake.module.Exporter as { frames: { ticks: number }[] }).frames;
  assert.equal(frames.at(-1)!.ticks, 12.5 * TPS);
  await project.deleteSequence(probe as never);
  assert.ok(project.deleted.includes("MAG colour probe Host"));
});

test("multicam: the synced sequence is nested as one clip in a new sequence that opens", async () => {
  const r = await nestForMulticam(project as never, seq as never);
  assert.equal(r.name, "PODCAST_01_MULTICAM");
  assert.equal(project.opened?.name, "PODCAST_01_MULTICAM");
  const nested = project.sequences.find((s) => s.name === "PODCAST_01_MULTICAM")!;
  assert.equal(nested.video[0]!.items.length, 1);
});

test("SRT: on a caption track when Premiere accepts it", async () => {
  project.captionInsert = "caption-track";
  const r = await srtToCaptionTrack(project as never, seq as never, "C:\\Proj\\MAG Captions\\PODCAST_01.srt");
  assert.deepEqual(r, { onTimeline: true, inBin: true });
  assert.equal(seq.captionTracks, 1);
  assert.equal(seq.video.length, 1, "no video track touched");
});

test("SRT: if Premiere puts it on a video track, it is taken off again and stays in the bin", async () => {
  project.captionInsert = "video-track";
  const before = JSON.stringify(seq.video[0]!.items.map((i) => [i.start, i.end]));
  const r = await srtToCaptionTrack(project as never, seq as never, "C:\\Proj\\MAG Captions\\PODCAST_01.srt");
  assert.deepEqual(r, { onTimeline: false, inBin: true });
  assert.equal(JSON.stringify(seq.video[0]!.items.map((i) => [i.start, i.end])), before, "camera track untouched");
  assert.equal(seq.video[1]?.items.length ?? 0, 0, "stray caption clip removed");
  project.captionInsert = "refuse";
  const r2 = await srtToCaptionTrack(project as never, seq as never, "C:\\Proj\\MAG Captions\\B.srt");
  assert.deepEqual(r2, { onTimeline: false, inBin: true });
});

test("MOGRT: inserted on a free track at the playhead; JSON and plain text fields are edited and read back", async () => {
  seq.playhead = 10 * TPS;
  const track = await freeVideoTrack(seq as never, 10, 5);
  assert.equal(track, 1, "V1 is busy at 10 s");
  const item = await insertMogrt(project as never, seq as never, "/T/Lower Third.mogrt", 10, track);
  assert.ok(item);
  assert.equal(seq.video[1]!.items[0]!.start, 10 * TPS);
  const fields = await mogrtFields(item!);
  assert.deepEqual(fields.map((f) => [f.name, f.text, f.json]), [["Name", "Your Name", true], ["Role", "Your role", false]]);
  assert.equal(await setMogrtText(project as never, fields[0]!, "د. أحمد سامي"), true);
  assert.equal(await setMogrtText(project as never, fields[1]!, "ضيف الحلقة"), true);
  const after = await mogrtFields(item!);
  assert.deepEqual(after.map((f) => f.text), ["د. أحمد سامي", "ضيف الحلقة"]);
  assert.match(after[0]!.raw, /fontEditValue/, "other template settings kept");
  // A template that ignores the new value is reported, not assumed.
  (fields[1]!.param as unknown as { rejectStrings: boolean }).rejectStrings = true;
  assert.equal(await setMogrtText(project as never, fields[1]!, "x"), false);
});
