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
  createMoveItemAction(item: FakeFolder | FakeClip | FakeSeqItem, newParent: FakeFolder) {
    requireLock("createMoveItemAction");
    return new Action(`move:${item.name}`, () => {
      const from = item.parent ?? this;
      from.items = from.items.filter((i) => i !== item);
      newParent.items.push(item as FakeClip);
      item.parent = newParent;
    });
  }
  parent: FakeFolder | null = null;
}

let idCounter = 0;

export class FakeSeqItem {
  name: string;
  parent: FakeFolder | null = null;
  constructor(name: string) {
    this.name = name;
  }
  createSetNameAction(name: string) {
    requireLock("createSetNameAction");
    return new Action(`rename:${name}`, () => (this.name = name));
  }
  getParentBin() {
    return this.parent ?? fakeRoot!;
  }
}

let fakeRoot: FakeFolder | null = null;

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
  readonly id = `clip-${++idCounter}`;
  parent: FakeFolder | null = null;
  sub: { from: FakeClip; inT: number; outT: number; video: boolean; audio: boolean } | null = null;
  lengthTicks = 0; // for imported files (graphics)
  relinkedTo: string | null = null;
  async canChangeMediaPath() {
    return true;
  }
  async changeMediaFilePath(p: string) {
    this.path = p;
    this.relinkedTo = p;
    return true;
  }
  async refreshMedia() {
    return true;
  }
  getId() {
    return this.id;
  }
  createSubClipAction(name: string, start: FakeTickTime, end: FakeTickTime, _hard: boolean,
                      opts: { takeVideo?: boolean; takeAudio?: boolean } = {}) {
    requireLock("createSubClipAction");
    return new Action(`subclip:${name}`, () => {
      const c = new FakeClip(name, this.path);
      c.sub = { from: this, inT: start.ticksNumber, outT: end.ticksNumber, video: opts.takeVideo ?? true, audio: opts.takeAudio ?? true };
      c.parent = fakeRoot;
      fakeRoot!.items.push(c); // Premiere's default destination is not documented; the engine must find it anywhere
    });
  }
}

export class FakeTrackItem {
  readonly clip: FakeClip | null;
  start: number;
  end: number;
  inPoint: number;
  speed = 1;
  disabled = false;
  constructor(clip: FakeClip | null, start = 0, end = 0, inPoint = 0) {
    this.clip = clip;
    this.start = start;
    this.end = end;
    this.inPoint = inPoint;
  }
  async getProjectItem() {
    return this.clip;
  }
  async getStartTime() {
    return new FakeTickTime(this.start);
  }
  async getEndTime() {
    return new FakeTickTime(this.end);
  }
  async getInPoint() {
    return new FakeTickTime(this.inPoint);
  }
  async getSpeed() {
    return this.speed;
  }
  async isDisabled() {
    return this.disabled;
  }
  createSetDisabledAction(d: boolean) {
    requireLock("createSetDisabledAction");
    return new Action(`disable:${d}`, () => (this.disabled = d));
  }
}

export class FakeTrack {
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
  frameW = 1920;
  frameH = 1080;
  async getFrameSize() {
    return { width: this.frameW, height: this.frameH };
  }
  async getEndTime() {
    return new FakeTickTime(this.end);
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
  inPoint = 0;
  outPoint = 0;
  end = TPS * 3600 + 8475667200 * 12;
  item: FakeSeqItem | null = null;
  project: FakeProject | null = null;
  async getInPoint() {
    return new FakeTickTime(this.inPoint);
  }
  async getOutPoint() {
    return new FakeTickTime(this.outPoint);
  }
  async getProjectItem() {
    if (!this.item) this.item = new FakeSeqItem(this.name);
    return this.item;
  }
  createCloneAction() {
    requireLock("createCloneAction");
    return new Action(`clone:${this.name}`, () => {
      const copy = (t: FakeTrack) => new FakeTrack(t.name, t.items.map((i) => {
        const c = new FakeTrackItem(i.clip, i.start, i.end, i.inPoint);
        c.disabled = i.disabled;
        return c;
      }));
      const clone = new FakeSequence(`${this.name} Copy`, this.video.map(copy), this.audio.map(copy), this.fpsTicks);
      clone.end = this.end;
      clone.frameW = this.frameW;
      clone.frameH = this.frameH;
      clone.guid = { toString: () => `guid-${++idCounter}` };
      clone.project = this.project;
      this.project!.sequences.push(clone);
    });
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
  opened: FakeSequence | null = null;
  constructor(seq: FakeSequence | null) {
    this.sequences = seq ? [seq] : [];
    this.active = seq;
    if (seq) seq.project = this;
    fakeRoot = this.root;
  }
  imports: string[] = [];
  importLengthTicks = TPS * 6;
  async importFiles(paths: string[], _suppress: boolean, bin: FakeFolder) {
    for (const p of paths) {
      this.imports.push(p);
      const c = new FakeClip(p.split(/[\\/]/).pop()!, p);
      c.lengthTicks = this.importLengthTicks;
      c.parent = bin;
      bin.items.push(c);
    }
    return true;
  }
  async openSequence(seq: FakeSequence) {
    this.opened = seq;
    return true;
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
    TickTime: { TIME_ZERO: new FakeTickTime(0), createWithTicks: (t: string) => new FakeTickTime(Number(t)) },
    SequenceEditor: { getEditor: (seq: FakeSequence) => fakeEditor(seq) },
    TrackItemSelection: {
      createEmptySelection(cb: (sel: { items: FakeTrackItem[]; addItem(i: FakeTrackItem): boolean }) => void) {
        const sel = { items: [] as FakeTrackItem[], addItem(i: FakeTrackItem) { this.items.push(i); return true; } };
        cb(sel);
        return true;
      },
    },
    Transcript: { hasTranscript: () => false, transcribeClipProjectItem: async () => true },
    EventManager: { addGlobalEventListener: () => undefined },
    Constants: {
      TrackItemType: { CLIP: "CLIP" },
      MediaType: { ANY: "ANY" },
      SequenceEvent: { ACTIVATED: "seqActivated", CLOSED: "seqClosed" },
      ProjectEvent: { OPENED: "projOpened", CLOSED: "projClosed", ACTIVATED: "projActivated" },
    },
  };
  return { module, project, sequence: seq };
}

/** Overwrite semantics: the new clip replaces whatever overlaps it on that track. */
export const editorFaults = { wrongLength: false };

function overwrite(track: FakeTrack, item: FakeTrackItem) {
  const kept: FakeTrackItem[] = [];
  for (const it of track.items) {
    if (it.end <= item.start || it.start >= item.end) kept.push(it);
    else {
      if (it.start < item.start) kept.push(Object.assign(new FakeTrackItem(it.clip, it.start, item.start, it.inPoint)));
      if (it.end > item.end) kept.push(new FakeTrackItem(it.clip, item.end, it.end, it.inPoint + (item.end - it.start)));
    }
  }
  kept.push(item);
  track.items = kept.sort((a, b) => a.start - b.start);
}

function fakeEditor(seq: FakeSequence) {
  return {
    createOverwriteItemAction(clip: FakeClip, time: FakeTickTime, v: number, a: number) {
      requireLock("createOverwriteItemAction");
      return new Action(`overwrite:${clip.name}`, () => {
        if (!clip.sub) {
          overwrite(seq.video[v]!, new FakeTrackItem(clip, time.ticksNumber, time.ticksNumber + clip.lengthTicks, 0));
          return;
        }
        const sub = clip.sub;
        let len = sub.outT - sub.inT;
        if (editorFaults.wrongLength) len -= seq.fpsTicks;
        if (sub.video) overwrite(seq.video[v]!, new FakeTrackItem(clip, time.ticksNumber, time.ticksNumber + len, 0));
        if (sub.audio) overwrite(seq.audio[a]!, new FakeTrackItem(clip, time.ticksNumber, time.ticksNumber + len, 0));
      });
    },
    createInsertProjectItemAction(clip: FakeClip, time: FakeTickTime, v: number, _a: number, limitShift: boolean) {
      requireLock("createInsertProjectItemAction");
      if (!limitShift) throw new Error("graphics insert must not shift other tracks");
      return new Action(`insert:${clip.name}`, () => {
        while (seq.video.length <= v) seq.video.push(new FakeTrack(`Video ${seq.video.length + 1}`, []));
        overwrite(seq.video[v]!, new FakeTrackItem(clip, time.ticksNumber, time.ticksNumber + clip.lengthTicks, 0));
      });
    },
    createRemoveItemsAction(sel: { items: FakeTrackItem[] }, ripple: boolean) {
      requireLock("createRemoveItemsAction");
      if (ripple) throw new Error("engine must not ripple-delete");
      const victims = new Set(sel.items);
      return new Action(`remove:${victims.size}`, () => {
        for (const t of [...seq.video, ...seq.audio]) t.items = t.items.filter((i) => !victims.has(i));
      });
    },
  };
}
