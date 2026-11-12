/**
 * In-memory stand-in for the `premierepro` module.
 *
 * It is NOT Premiere. It exists to test this plugin's own logic and to enforce
 * the documented 26.3 rules: create*Action only while lockedAccess is held,
 * executeTransaction only inside lockedAccess, synchronous callbacks.
 */

export const TPS = 254016000000;

let locked = false;
export const journal: string[] = [];

function requireLock(what: string) {
  if (!locked) throw new Error(`${what} called outside lockedAccess`);
}

class Action {
  readonly label: string;
  readonly apply: () => void;
  constructor(label: string, apply: () => void) {
    this.label = label;
    this.apply = apply;
  }
}

export class FakeTickTime {
  readonly ticksNumber: number;
  constructor(ticks: number) {
    this.ticksNumber = ticks;
  }
  get ticks() {
    return String(this.ticksNumber);
  }
  get seconds() {
    return this.ticksNumber / TPS;
  }
}

export class FakeFolder {
  name: string;
  readonly type = "BIN";
  items: (FakeFolder | FakeClip)[] = [];
  constructor(name: string) {
    this.name = name;
  }
  async getItems() {
    return [...this.items];
  }
  createBinAction(name: string, _makeUnique: boolean) {
    requireLock("createBinAction");
    return new Action(`bin:${name}`, () => this.items.push(new FakeFolder(name)));
  }
}

export class FakeClip {
  name: string;
  readonly type = "CLIP";
  path: string;
  offline: boolean;
  sequence: boolean;
  constructor(name: string, path: string, opts: { offline?: boolean; sequence?: boolean } = {}) {
    this.name = name;
    this.path = path;
    this.offline = opts.offline ?? false;
    this.sequence = opts.sequence ?? false;
  }
  async getMediaFilePath() {
    return this.path;
  }
  async isOffline() {
    return this.offline;
  }
  async isSequence() {
    return this.sequence;
  }
}

class FakeTrackItem {
  readonly clip: FakeClip | null;
  constructor(clip: FakeClip | null) {
    this.clip = clip;
  }
  async getProjectItem() {
    return this.clip;
  }
}

class FakeTrack {
  name: string;
  items: FakeTrackItem[];
  constructor(name: string, items: FakeTrackItem[]) {
    this.name = name;
    this.items = items;
  }
  getTrackItems(type: unknown, _includeEmpty: boolean) {
    if (type !== "CLIP") throw new Error("expected Constants.TrackItemType.CLIP");
    return this.items;
  }
  async isMuted() {
    return false;
  }
}

export class FakeMarkers {
  list: { name: string; start: number; comment: string }[] = [];
  createAddMarkerAction(name: string, _type: string, start: FakeTickTime, _dur: FakeTickTime, comment: string) {
    requireLock("createAddMarkerAction");
    return new Action(`marker:${name}`, () => this.list.push({ name, start: start.ticksNumber, comment }));
  }
}

export class FakeSequence {
  name: string;
  guid = { toString: () => "seq-guid-1" };
  video: FakeTrack[];
  audio: FakeTrack[];
  fpsTicks: number;
  markers = new FakeMarkers();
  playhead: number;
  constructor(name: string, video: FakeTrack[], audio: FakeTrack[], fpsTicks: number, playhead = 0) {
    this.name = name;
    this.video = video;
    this.audio = audio;
    this.fpsTicks = fpsTicks;
    this.playhead = playhead;
  }
  async getSettings() {
    return { getVideoFrameRate: () => ({ ticksPerFrame: this.fpsTicks, value: TPS / this.fpsTicks }) };
  }
  async getTimebase() {
    return String(this.fpsTicks);
  }
  async getFrameSize() {
    return { width: 1920, height: 1080 };
  }
  async getEndTime() {
    return new FakeTickTime(TPS * 3600 + this.fpsTicks * 12);
  }
  async getPlayerPosition() {
    return new FakeTickTime(this.playhead);
  }
  async getVideoTrackCount() {
    return this.video.length;
  }
  async getAudioTrackCount() {
    return this.audio.length;
  }
  async getVideoTrack(i: number) {
    return this.video[i];
  }
  async getAudioTrack(i: number) {
    return this.audio[i];
  }
  async getCaptionTrackCount() {
    return 0;
  }
}

export class FakeProject {
  name = "Episode 12.prproj";
  path = "/Projects/Episode 12.prproj";
  root = new FakeFolder("root");
  sequences: FakeSequence[];
  active: FakeSequence | null;
  undoStack: string[] = [];
  rejectNext = false;
  constructor(seq: FakeSequence | null) {
    this.sequences = seq ? [seq] : [];
    this.active = seq;
  }
  async getRootItem() {
    return this.root;
  }
  async getSequences() {
    return this.sequences;
  }
  async getActiveSequence() {
    return this.active;
  }
  lockedAccess(cb: () => void) {
    if (locked) throw new Error("nested lockedAccess");
    locked = true;
    try {
      const r = cb() as unknown;
      if (r instanceof Promise) throw new Error("lockedAccess callback must be synchronous");
    } finally {
      locked = false;
    }
  }
  executeTransaction(cb: (c: { addAction(a: Action): boolean }) => void, undo: string) {
    requireLock("executeTransaction");
    const actions: Action[] = [];
    const r = cb({ addAction: (a) => (actions.push(a), true) }) as unknown;
    if (r instanceof Promise) throw new Error("executeTransaction callback must be synchronous");
    if (this.rejectNext) {
      this.rejectNext = false;
      return false;
    }
    actions.forEach((a) => a.apply());
    this.undoStack.push(undo);
    journal.push(`${undo}: ${actions.map((a) => a.label).join(", ")}`);
    return true;
  }
}

export interface Fake {
  module: Record<string, unknown>;
  project: FakeProject;
  sequence: FakeSequence;
}

export function buildFake(): Fake {
  const cams = {
    wide: new FakeClip("WIDE.mov", "/Media/CAM_A/WIDE.mov"),
    host: new FakeClip("HOST.mov", "/Media/CAM_B/HOST.mov"),
    guest: new FakeClip("GUEST.mov", "/Media/CAM_C/GUEST.mov", { offline: true }),
    mic1: new FakeClip("TR1.wav", "/Media/ZOOM/TR1.wav"),
    mic2: new FakeClip("TR2.wav", "/Media/ZOOM/TR2.wav"),
    nested: new FakeClip("Nested", "", { sequence: true }),
  };
  const seq = new FakeSequence(
    "PODCAST_01",
    [
      new FakeTrack("WIDE", [new FakeTrackItem(cams.wide), new FakeTrackItem(cams.wide)]),
      new FakeTrack("HOST", [new FakeTrackItem(cams.host)]),
      new FakeTrack("GUEST", [new FakeTrackItem(cams.guest), new FakeTrackItem(cams.nested), new FakeTrackItem(null)]),
    ],
    [
      new FakeTrack("Guest mic", [new FakeTrackItem(cams.mic1)]),
      new FakeTrack("Host mic", [new FakeTrackItem(cams.mic2), new FakeTrackItem(cams.wide)]),
    ],
    8475667200, // 29.97
    8475667200 * 1800, // 00:01:00;02 in DF, 00:01:00:00 in NDF
  );
  const project = new FakeProject(seq);
  const module = {
    Project: { getActiveProject: async () => project },
    ClipProjectItem: { cast: (x: unknown) => x },
    FolderItem: {
      cast: (x: unknown) => {
        if (!(x instanceof FakeFolder)) throw new Error("not a folder");
        return x;
      },
    },
    Markers: { getMarkers: async (s: FakeSequence) => s.markers },
    TickTime: { TIME_ZERO: new FakeTickTime(0) },
    SequenceEditor: { getEditor: () => ({}) },
    Transcript: { hasTranscript: () => false, transcribeClipProjectItem: async () => true },
    EventManager: { addGlobalEventListener: () => undefined },
    Constants: {
      TrackItemType: { CLIP: "CLIP" },
      SequenceEvent: { ACTIVATED: "seqActivated", CLOSED: "seqClosed" },
      ProjectEvent: { OPENED: "projOpened", CLOSED: "projClosed", ACTIVATED: "projActivated" },
    },
  };
  return { module, project, sequence: seq };
}
