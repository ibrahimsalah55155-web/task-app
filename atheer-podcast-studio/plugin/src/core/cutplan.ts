/**
 * Cut planner: the replacement for a razor tool.
 *
 * Premiere 26.x/27.x has no razor/split API. Instead of splitting clips in
 * place, the plugin computes the exact list of pieces the edited timeline must
 * contain and builds them in a new sequence. This module is pure math (no
 * Premiere calls) so every cut decision is testable and frame-exact.
 *
 * Model
 *  - Times are BigInt ticks (254,016,000,000 per second).
 *  - A source item occupies [start, end) on the sequence and plays its media
 *    from `inPoint` onward at speed 1.
 *  - `remove` ranges are deleted from ALL tracks (ripple), so sync is kept.
 *  - `splitAt` points cut items without removing time (Auto Director).
 */
import { type Rounding, alignTicks } from "./time.ts";

export interface SourceItem {
  key: string;
  kind: "video" | "audio";
  track: number;
  start: bigint;
  end: bigint;
  inPoint: bigint;
  speed: number;
  disabled: boolean;
  media: string; // identity of the project item (used to group subclips)
}

export interface Range {
  start: bigint;
  end: bigint;
}

export interface Piece {
  itemKey: string;
  media: string;
  kind: "video" | "audio";
  track: number;
  dest: bigint; // start on the new sequence
  srcIn: bigint; // media time
  srcOut: bigint; // media time (exclusive)
  disabled: boolean;
}

export interface CutPlan {
  pieces: Piece[];
  removed: Range[]; // normalised ranges actually removed (sequence time of the source)
  removedTicks: bigint;
  newEnd: bigint;
  skipped: { itemKey: string; reason: string }[];
}

export interface PlanOptions {
  tpf: bigint; // ticks per frame of the sequence
  sequenceEnd: bigint;
  remove?: Range[];
  splitAt?: bigint[];
  rounding?: Rounding;
}

/** Frame-align, clamp, sort and merge ranges. Empty ranges are dropped. */
export function normaliseRanges(ranges: Range[], tpf: bigint, end: bigint, rounding: Rounding = "nearest"): Range[] {
  const aligned = ranges
    .map((r) => ({
      start: alignTicks(r.start < r.end ? r.start : r.end, tpf, rounding),
      end: alignTicks(r.start < r.end ? r.end : r.start, tpf, rounding),
    }))
    .map((r) => ({ start: r.start < 0n ? 0n : r.start, end: r.end > end ? end : r.end }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const out: Range[] = [];
  for (const r of aligned) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) {
      if (r.end > last.end) last.end = r.end;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** Sequence-time intervals that survive the removal. */
export function keptIntervals(removed: Range[], end: bigint): Range[] {
  const kept: Range[] = [];
  let cursor = 0n;
  for (const r of removed) {
    if (r.start > cursor) kept.push({ start: cursor, end: r.start });
    cursor = r.end > cursor ? r.end : cursor;
  }
  if (cursor < end) kept.push({ start: cursor, end });
  return kept;
}

/** New-sequence time for an old-sequence time that is not inside a removed range. */
export function mapTime(t: bigint, removed: Range[]): bigint {
  let shift = 0n;
  for (const r of removed) {
    if (r.end <= t) shift += r.end - r.start;
    else if (r.start < t) shift += t - r.start; // inside a removed range: snaps to its start
    else break;
  }
  return t - shift;
}

export function planCuts(items: SourceItem[], opts: PlanOptions): CutPlan {
  const { tpf, sequenceEnd } = opts;
  const removed = normaliseRanges(opts.remove ?? [], tpf, sequenceEnd, opts.rounding);
  const kept = keptIntervals(removed, sequenceEnd);
  const splits = [...new Set((opts.splitAt ?? []).map((t) => alignTicks(t, tpf, opts.rounding ?? "nearest")))]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const pieces: Piece[] = [];
  const skipped: CutPlan["skipped"] = [];

  for (const item of items) {
    if (item.end <= item.start) continue;
    if (item.speed !== 1) {
      skipped.push({ itemKey: item.key, reason: `speed ${item.speed * 100}% is not supported yet` });
      continue;
    }
    for (const k of kept) {
      const a = item.start > k.start ? item.start : k.start;
      const b = item.end < k.end ? item.end : k.end;
      if (b <= a) continue;
      // Split the surviving part at the requested points.
      const bounds = [a, ...splits.filter((s) => s > a && s < b), b];
      for (let i = 0; i < bounds.length - 1; i++) {
        const p0 = bounds[i]!;
        const p1 = bounds[i + 1]!;
        pieces.push({
          itemKey: item.key,
          media: item.media,
          kind: item.kind,
          track: item.track,
          dest: mapTime(p0, removed),
          srcIn: item.inPoint + (p0 - item.start),
          srcOut: item.inPoint + (p1 - item.start),
          disabled: item.disabled,
        });
      }
    }
  }

  pieces.sort((x, y) =>
    x.kind !== y.kind ? (x.kind === "video" ? -1 : 1) : x.track !== y.track ? x.track - y.track : x.dest < y.dest ? -1 : x.dest > y.dest ? 1 : 0);
  const removedTicks = removed.reduce((s, r) => s + (r.end - r.start), 0n);
  return { pieces, removed, removedTicks, newEnd: sequenceEnd - removedTicks, skipped };
}

/** Distinct media segments needed (one subclip each), shared by pieces that use the same range. */
export function uniqueSegments(pieces: Piece[]): { id: string; media: string; kind: "video" | "audio"; srcIn: bigint; srcOut: bigint }[] {
  const seen = new Map<string, { id: string; media: string; kind: "video" | "audio"; srcIn: bigint; srcOut: bigint }>();
  for (const p of pieces) {
    const id = `${p.media}|${p.kind}|${p.srcIn}|${p.srcOut}`;
    if (!seen.has(id)) seen.set(id, { id, media: p.media, kind: p.kind, srcIn: p.srcIn, srcOut: p.srcOut });
  }
  return [...seen.values()];
}

export function segmentId(p: Piece): string {
  return `${p.media}|${p.kind}|${p.srcIn}|${p.srcOut}`;
}
