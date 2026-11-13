/**
 * Import files and find the resulting project items reliably.
 *
 * Seen in Premiere 26.5: importFiles() returns true, but the new items are not (yet) in the
 * bin we asked for. So: wait for them, search the whole project (by media path, then by
 * file name), and move them into the intended bin afterwards.
 */
import type { ClipProjectItem, FolderItem, Project, ProjectItem } from "@adobe/premierepro";
import { errorMessage, logger } from "../core/log.ts";
import { ppro } from "./api.ts";
import { finishTransaction } from "./transaction.ts";

const log = logger("import");
const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
const base = (p: string) => norm(p).split("/").pop() ?? "";
const stem = (p: string) => base(p).replace(/\.[^.]+$/, "");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Found { clip: ClipProjectItem; item: ProjectItem; parent: FolderItem }

async function walk(folder: FolderItem, visit: (item: ProjectItem, parent: FolderItem) => Promise<void>, depth = 0): Promise<void> {
  const P = ppro();
  for (const item of await folder.getItems()) {
    await visit(item, folder);
    if (depth > 12) continue;
    try {
      const sub = P.FolderItem.cast(item);
      if (sub && item.name) await walk(sub, visit, depth + 1);
    } catch {
      /* not a bin */
    }
  }
}

/** Every clip in the project for each wanted path (media path first, file name as fallback). */
async function locate(project: Project, paths: string[], taken: Set<ProjectItem>): Promise<Map<string, Found>> {
  const P = ppro();
  const byPath = new Map(paths.map((p) => [norm(p), p]));
  const out = new Map<string, Found>();
  const byName: { item: ProjectItem; clip: ClipProjectItem; parent: FolderItem }[] = [];
  await walk(await project.getRootItem(), async (item, parent) => {
    if (taken.has(item)) return;
    let clip: ClipProjectItem | null = null;
    try {
      clip = P.ClipProjectItem.cast(item);
    } catch {
      return;
    }
    if (!clip) return;
    let media = "";
    try {
      media = await clip.getMediaFilePath();
    } catch {
      /* some items have no path */
    }
    const want = media ? byPath.get(norm(media)) : undefined;
    if (want && !out.has(want)) out.set(want, { clip, item, parent });
    else byName.push({ item, clip, parent });
  });
  for (const p of paths) {
    if (out.has(p)) continue;
    const hit = byName.find((x) => !taken.has(x.item) && (norm(x.item.name) === base(p) || norm(x.item.name) === stem(p)));
    if (hit) {
      out.set(p, hit);
      taken.add(hit.item);
    }
  }
  return out;
}

export async function importAndFind(project: Project, paths: string[], bin: FolderItem,
                                    opts: { timeoutMs?: number; reuse?: boolean } = {}): Promise<Map<string, ClipProjectItem>> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const taken = new Set<ProjectItem>();
  let found = opts.reuse === false ? new Map<string, Found>() : await locate(project, paths, taken);
  const missing = paths.filter((p) => !found.has(p));
  if (missing.length) {
    const ok = await project.importFiles(missing, true, bin as unknown as ProjectItem, false);
    if (!ok) throw new Error(`Premiere could not import ${missing.length} file(s), e.g. ${missing[0]}`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      found = await locate(project, paths, new Set());
      if (paths.every((p) => found.has(p)) || Date.now() > deadline) break;
      await sleep(400);
    }
  }
  const still = paths.filter((p) => !found.has(p));
  if (still.length) {
    throw new Error(`${still.length} of ${paths.length} imported file(s) cannot be found in the project (first: ${still[0]}).`);
  }
  // Tidy: imported items that landed elsewhere go into the intended bin.
  const strays = [...found.values()].filter((f) => f.parent !== bin && !sameBin(f.parent, bin));
  if (strays.length) {
    try {
      const undo = "MAG: File imported items";
      let committed = false;
      project.lockedAccess(() => {
        const actions = strays.map((f) => f.parent.createMoveItemAction(f.item, bin));
        committed = project.executeTransaction((compound) => {
          for (const a of actions) compound.addAction(a);
        }, undo);
      });
      finishTransaction(committed, undo, strays.length);
    } catch (e) {
      log.debug(`could not move imported items into the bin: ${errorMessage(e)}`);
    }
  }
  return new Map([...found].map(([p, f]) => [p, f.clip]));
}

function sameBin(a: FolderItem, b: FolderItem): boolean {
  try {
    const ia = (a as unknown as { getId?: () => string }).getId?.();
    const ib = (b as unknown as { getId?: () => string }).getId?.();
    return !!ia && ia === ib;
  } catch {
    return false;
  }
}
