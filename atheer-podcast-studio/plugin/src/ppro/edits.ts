/**
 * Phase 1 write operations. Small, undoable, and useful later:
 *  - the project bin structure every later module imports into;
 *  - a marker at the playhead, which proves the timeline transaction path.
 */
import type { FolderItem, Project } from "@adobe/premierepro";
import { logger } from "../core/log.ts";
import { ppro } from "./api.ts";
import { type TransactionResult, finishTransaction } from "./transaction.ts";

const BINS_UNDO = "MAG: Create project bins";

const log = logger("edits");

export const ROOT_BIN = "Multimedia & AI Group";
export const CHILD_BINS = [
  "01 Footage",
  "02 Audio",
  "03 Sequences",
  "04 Reels",
  "05 Captions",
  "06 Graphics",
] as const;

export async function findChildBin(parent: FolderItem, name: string): Promise<FolderItem | null> {
  const P = ppro();
  // Constants.ProjectItemType is documented from 27.0. On 26.x a clip and a bin
  // can share a name, so a candidate only counts if it behaves like a bin.
  const constants = P.Constants as unknown as { ProjectItemType?: { BIN?: unknown } };
  const BIN = constants.ProjectItemType?.BIN;
  for (const item of await parent.getItems()) {
    if (item.name !== name) continue;
    if (BIN !== undefined && item.type !== BIN) continue;
    try {
      const folder = P.FolderItem.cast(item);
      if (!folder) continue;
      await folder.getItems();
      return folder;
    } catch {
      /* not a bin */
    }
  }
  return null;
}

export interface BinResult {
  created: string[];
  existing: string[];
  undoSteps: number;
}

/**
 * Idempotent: running it twice creates nothing the second time.
 * Two undo steps when the root bin is new (the child bins need its handle).
 */
export async function ensureProjectBins(project: Project): Promise<BinResult> {
  const root = await project.getRootItem();
  const result: BinResult = { created: [], existing: [], undoSteps: 0 };

  let parent = await findChildBin(root, ROOT_BIN);
  if (!parent) {
    let committed = false;
    project.lockedAccess(() => {
      const action = root.createBinAction(ROOT_BIN, false);
      committed = project.executeTransaction((compound) => {
        compound.addAction(action);
      }, BINS_UNDO);
    });
    finishTransaction(committed, BINS_UNDO, 1);
    result.undoSteps++;
    result.created.push(ROOT_BIN);
    parent = await findChildBin(root, ROOT_BIN);
    if (!parent) throw new Error(`Created "${ROOT_BIN}" but could not find it afterwards.`);
  } else {
    result.existing.push(ROOT_BIN);
  }

  const missing: string[] = [];
  for (const name of CHILD_BINS) {
    if (await findChildBin(parent, name)) result.existing.push(`${ROOT_BIN}/${name}`);
    else missing.push(name);
  }
  if (missing.length) {
    const folder = parent;
    let committed = false;
    project.lockedAccess(() => {
      const actions = missing.map((name) => folder.createBinAction(name, false));
      committed = project.executeTransaction((compound) => {
        for (const action of actions) compound.addAction(action);
      }, BINS_UNDO);
    });
    finishTransaction(committed, BINS_UNDO, missing.length);
    result.undoSteps++;
    result.created.push(...missing.map((n) => `${ROOT_BIN}/${n}`));
  }
  log.info(
    result.created.length
      ? `Created ${result.created.length} bin(s): ${result.created.join(", ")}`
      : "Project bins already exist",
  );
  return result;
}

export async function addMarkerAtPlayhead(project: Project, name: string, comment: string): Promise<TransactionResult> {
  const P = ppro();
  const seq = await project.getActiveSequence();
  if (!seq) throw new Error("Open a sequence first.");
  const position = await seq.getPlayerPosition();
  const markers = await P.Markers.getMarkers(seq);
  const undo = "MAG: Add marker";
  let committed = false;
  project.lockedAccess(() => {
    const action = markers.createAddMarkerAction(name, "Comment", position, P.TickTime.TIME_ZERO, comment);
    committed = project.executeTransaction((compound) => {
      compound.addAction(action);
    }, undo);
  });
  return finishTransaction(committed, undo, 1);
}
