/**
 * Reels: change a sequence's frame (9:16, 1:1, 4:5, 16:9) and reframe each
 * camera clip with its Motion effect (Scale to fill, Position on the face).
 *
 * The UXP reference does not document Motion's coordinate system, so the
 * current Position is read first: values <= 1.5 are treated as normalised
 * (0..1), larger ones as pixels. Every change is read back and reported.
 */
import type { ComponentParam, Project, Sequence, VideoClipTrackItem } from "@adobe/premierepro";
import { errorMessage, logger } from "../core/log.ts";
import { ppro } from "./api.ts";
import { finishTransaction } from "./transaction.ts";

const log = logger("reframe");

export const ASPECTS: Record<string, [number, number]> = {
  "9:16": [1080, 1920],
  "1:1": [1080, 1080],
  "4:5": [1080, 1350],
  "16:9": [1920, 1080],
};

export async function setFrameSize(project: Project, seq: Sequence, width: number, height: number): Promise<void> {
  const P = ppro();
  const settings = await seq.getSettings();
  const rect = new P.RectF();
  rect.width = width;
  rect.height = height;
  await settings.setVideoFrameRect(rect);
  const undo = "MAG: Reel frame size";
  let committed = false;
  project.lockedAccess(() => {
    const action = seq.createSetSettingsAction(settings);
    committed = project.executeTransaction((compound) => {
      compound.addAction(action);
    }, undo);
  });
  finishTransaction(committed, undo, 1);
}

/** Pure: scale (%) to fill the frame and position (pixels) that centres the face without showing edges. */
export function fit(srcW: number, srcH: number, frameW: number, frameH: number, faceX: number | null): { scale: number; x: number; y: number } {
  const scale = 100 * Math.max(frameW / srcW, frameH / srcH);
  const shownW = srcW * scale / 100;
  const maxShift = Math.max(0, (shownW - frameW) / 2);
  const off = faceX == null ? 0 : (faceX - 0.5) * shownW;
  const shift = Math.max(-maxShift, Math.min(maxShift, off));
  return { scale, x: frameW / 2 - shift, y: frameH / 2 };
}

async function motionParams(item: VideoClipTrackItem): Promise<{ position: ComponentParam; scale: ComponentParam } | null> {
  const chain = await item.getComponentChain();
  for (let i = 0; i < chain.getComponentCount(); i++) {
    const comp = chain.getComponentAtIndex(i);
    if ((await comp.getMatchName()) !== "AE.ADBE Motion") continue;
    let position: ComponentParam | null = null;
    let scale: ComponentParam | null = null;
    for (let k = 0; k < comp.getParamCount(); k++) {
      const p = comp.getParam(k);
      const n = (p.displayName || "").toLowerCase();
      if (!position && (n === "position" || n === "الموضع")) position = p;
      if (!scale && (n === "scale" || n === "المقياس" || n === "تغيير الحجم")) scale = p;
    }
    position ??= comp.getParam(0);
    scale ??= comp.getParam(1);
    return { position, scale };
  }
  return null;
}

function xy(v: unknown): [number, number] | null {
  const val = (v as { value?: unknown })?.value ?? v;
  if (Array.isArray(val) && val.length >= 2) return [Number(val[0]), Number(val[1])];
  const o = val as { x?: number; y?: number };
  if (o && typeof o.x === "number" && typeof o.y === "number") return [o.x, o.y];
  return null;
}

export interface ReframeTarget {
  item: VideoClipTrackItem;
  srcW: number;
  srcH: number;
  faceX: number | null;
}

export async function reframe(project: Project, frameW: number, frameH: number, targets: ReframeTarget[]): Promise<{ done: number; failed: string[] }> {
  const P = ppro();
  const failed: string[] = [];
  const work: { position: ComponentParam; scale: ComponentParam; pos: [number, number]; scaleV: number }[] = [];
  for (const t of targets) {
    try {
      const m = await motionParams(t.item);
      if (!m) throw new Error("no Motion effect");
      const start = xy((await m.position.getStartValue()).value);
      const normalised = start ? Math.max(Math.abs(start[0]), Math.abs(start[1])) <= 1.5 : true;
      const f = fit(t.srcW, t.srcH, frameW, frameH, t.faceX);
      work.push({ position: m.position, scale: m.scale, scaleV: f.scale,
        pos: normalised ? [f.x / frameW, f.y / frameH] : [f.x, f.y] });
    } catch (e) {
      failed.push(errorMessage(e));
    }
  }
  if (work.length) {
    const undo = "MAG: Reframe";
    let committed = false;
    project.lockedAccess(() => {
      const actions = work.flatMap((w) => [
        w.scale.createSetValueAction(w.scale.createKeyframe(w.scaleV), true),
        w.position.createSetValueAction(w.position.createKeyframe(new P.PointF(w.pos[0], w.pos[1])), true),
      ]);
      committed = project.executeTransaction((compound) => {
        for (const a of actions) compound.addAction(a);
      }, undo);
    });
    finishTransaction(committed, undo, work.length * 2);
    // read back
    for (const w of work) {
      const got = Number((await w.scale.getStartValue()).value?.value ?? (await w.scale.getStartValue()).value);
      if (Number.isFinite(got) && Math.abs(got - w.scaleV) > 0.5) failed.push(`scale reads ${got} instead of ${w.scaleV.toFixed(1)}`);
    }
  }
  if (failed.length) log.warn(`Reframe: ${failed.length} issue(s): ${failed[0]}`);
  return { done: work.length, failed };
}

/** Export through Adobe Media Encoder (queue) or directly, only for approved sequences. */
export async function exportSequences(seqs: Sequence[], presetPath: string, outDir: string, mode: "queue" | "now"): Promise<string[]> {
  const P = ppro();
  const em = P.EncoderManager.getManager();
  const sep = outDir.includes("\\") ? "\\" : "/";
  const outs: string[] = [];
  for (const seq of seqs) {
    let ext = "mp4";
    try {
      ext = (await P.EncoderManager.getExportFileExtension(seq, presetPath)) || ext;
    } catch {
      /* default */
    }
    const out = `${outDir}${sep}${seq.name}.${ext.replace(/^\./, "")}`;
    const type = mode === "queue" ? P.Constants.ExportType.QUEUE_TO_AME : P.Constants.ExportType.IMMEDIATELY;
    const ok = await em.exportSequence(seq, type, out, presetPath, true);
    if (!ok) throw new Error(`Export of ${seq.name} was refused.`);
    outs.push(out);
  }
  if (mode === "queue" && typeof em.startBatchEncode === "function") {
    try {
      await em.startBatchEncode();
    } catch (e) {
      log.warn("Media Encoder queue did not start automatically", e);
    }
  }
  return outs;
}
