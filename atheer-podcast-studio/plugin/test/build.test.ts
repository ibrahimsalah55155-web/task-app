import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { __setHostModulesForTests } from "../src/ppro/api.ts";
import { type BuildItem, buildSyncedSequence, insertionOrder, layout } from "../src/ppro/build.ts";
import { FakeProject, FakeSequence, TPS, buildFake } from "./fakePremiere.ts";

const names = { wide: "Wide Camera", host: "Host Camera", guest: "Guest Camera", guestMic: "Guest Mic",
  hostMic: "Host Mic", extra: "Extra", camAudio: "Camera audio" };

const items: BuildItem[] = [
  { path: "D:/Shoot/CAM_C_wide.mov", role: "wide_cam", seqStart: 3.04 },
  { path: "D:/Shoot/CAM_B_host.mov", role: "host_cam", seqStart: 7.5 },
  { path: "D:/Shoot/CAM_A_guest_1.mov", role: "guest_cam", seqStart: 1.0 },
  { path: "D:/Shoot/CAM_A_guest_2.mov", role: "guest_cam", seqStart: 1800.0 }, // split recording
  { path: "D:/Shoot/TR1.wav", role: "guest_mic", seqStart: 1.75 },
  { path: "D:/Shoot/TR2.wav", role: "host_mic", seqStart: 0 },
  { path: "D:/Shoot/ROOM.wav", role: "extra", seqStart: 2 },
];

let project: FakeProject;

beforeEach(() => {
  const fake = buildFake();
  project = new FakeProject(new FakeSequence("Old", [], [], 10160640000));
  for (const it of items) project.mediaLength[it.path] = TPS * 60;
  __setHostModulesForTests(fake.module, null);
});

test("layout puts every role on its track", () => {
  const l = layout(items);
  const v = (p: string) => l.video.get(items.find((i) => i.path.endsWith(p))!);
  const a = (p: string) => l.audio.get(items.find((i) => i.path.endsWith(p))!);
  assert.deepEqual([v("wide.mov"), v("host.mov"), v("guest_1.mov"), v("guest_2.mov")], [0, 1, 2, 2]);
  assert.deepEqual([a("TR1.wav"), a("TR2.wav"), a("ROOM.wav")], [0, 1, 2]);
  assert.deepEqual(l.camAudioTracks, [3, 4, 5]);
  assert.deepEqual(insertionOrder(items).map((i) => i.role),
    ["guest_mic", "host_mic", "extra", "wide_cam", "host_cam", "guest_cam", "guest_cam"]);
});

test("build creates a synced, named sequence with muted camera audio", async () => {
  const seq = await buildSyncedSequence(project as never, { name: "PODCAST_01_SYNC", items, trackNames: names }) as unknown as FakeSequence;
  assert.deepEqual(seq.video.map((t) => t.name), ["Wide Camera", "Host Camera", "Guest Camera"]);
  assert.deepEqual(seq.audio.map((t) => t.name),
    ["Guest Mic", "Host Mic", "Extra 1", "Wide Camera · Camera audio", "Host Camera · Camera audio", "Guest Camera · Camera audio"]);
  const start = (tracks: typeof seq.video, i: number) => tracks[i]!.items.map((x) => x.start / TPS);
  assert.deepEqual(start(seq.video, 0), [3.04]);
  assert.deepEqual(start(seq.video, 2), [1, 1800]);
  assert.deepEqual(start(seq.audio, 0), [1.75]);
  assert.deepEqual(start(seq.audio, 1), [0]);
  assert.deepEqual(seq.audio.map((t) => t.muted), [false, false, false, true, true, true]);
  // the sequence was emptied before building: no leftover clip from createSequenceFromMedia at 0 on V1
  assert.equal(seq.video[0]!.items.length, 1);
  assert.equal(project.opened, seq);
});

test("cameras only (no Wide, no separate mics): no empty tracks, camera audio audible and named per camera", async () => {
  const only: BuildItem[] = [
    { path: "D:/Shoot/Robert.mp4", role: "guest_cam", seqStart: 0 },
    { path: "D:/Shoot/Iman.mp4", role: "guest_cam", seqStart: 0.4 },
    { path: "D:/Shoot/MrBeast.mp4", role: "host_cam", seqStart: 1.2 },
  ];
  for (const it of only) project.mediaLength[it.path] = TPS * 60;
  const l = layout(only);
  assert.deepEqual(only.map((i) => l.video.get(i)), [1, 1, 0]);
  assert.deepEqual(only.map((i) => l.audio.get(i)), [1, 1, 0]);
  const seq = await buildSyncedSequence(project as never, { name: "PODCAST_02_SYNC", items: only, trackNames: names }) as unknown as FakeSequence;
  assert.deepEqual(seq.video.map((t) => t.name), ["Host Camera", "Guest Camera"]);
  assert.deepEqual(seq.audio.map((t) => t.name), ["Host Camera · Camera audio", "Guest Camera · Camera audio"]);
  assert.deepEqual(seq.audio.map((t) => t.muted), [false, false]);
  assert.equal(seq.video[1]!.items.length, 2);
});
