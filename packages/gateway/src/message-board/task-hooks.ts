import type { BoardTask, BoardTaskNeed, BoardTaskState } from "@matrix-os/contracts/message-board";
import type { BoardTrx } from "./rows.js";

/** How thread reads see board tasks; supplied by the task store (spec 2700 section 2). */
export interface TaskExtension {
  load(trx: BoardTrx, rootIds: readonly string[]): Promise<Map<string, BoardTask>>;
  describeNeeds(trx: BoardTrx, taskIds: readonly string[]): Promise<BoardTaskNeed[]>;
  /** Narrows a `board_messages as m` root query to tasks in `state`. */
  filterByState<Q>(builder: Q, state: BoardTaskState): Q;
}

export async function loadTasks(extension: TaskExtension | undefined, trx: BoardTrx, rootIds: readonly string[]): Promise<Map<string, BoardTask>> {
  if (!extension || rootIds.length === 0) return new Map();
  return extension.load(trx, rootIds);
}
