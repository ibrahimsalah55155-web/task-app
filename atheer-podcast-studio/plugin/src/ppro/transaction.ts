/**
 * Shared bookkeeping for project edits.
 *
 * Every edit in this plugin follows Adobe's 26.3+ pattern literally, so the
 * @adobe/eslint-plugin-premierepro rules can verify each call site:
 *
 *   let committed = false;
 *   project.lockedAccess(() => {
 *     const action = thing.createXAction(...);          // created under the lock
 *     committed = project.executeTransaction((compound) => {
 *       compound.addAction(action);                     // one Undo step
 *     }, "MAG: ...");
 *   });
 *   finishTransaction(committed, "MAG: ...", 1);
 *
 * Nothing asynchronous may run inside either callback: gather all data
 * (await ...) before entering lockedAccess.
 */
import { logger } from "../core/log.ts";

const log = logger("transaction");

export class TransactionError extends Error {
  readonly undoLabel: string;
  constructor(message: string, undoLabel: string) {
    super(message);
    this.name = "TransactionError";
    this.undoLabel = undoLabel;
  }
}

export interface TransactionResult {
  undoLabel: string;
  actionCount: number;
}

/** Throws if Premiere rejected the transaction; logs the Undo label otherwise. */
export function finishTransaction(committed: boolean, undoLabel: string, actionCount: number): TransactionResult {
  if (actionCount === 0) {
    log.info(`"${undoLabel}": nothing to change`);
    return { undoLabel, actionCount };
  }
  if (!committed) {
    log.error(`Premiere rejected "${undoLabel}"`);
    throw new TransactionError(`Premiere rejected "${undoLabel}". The project was not changed.`, undoLabel);
  }
  log.info(`Applied "${undoLabel}" (${actionCount} action${actionCount === 1 ? "" : "s"}). Undo with Ctrl/Cmd+Z.`);
  return { undoLabel, actionCount };
}
