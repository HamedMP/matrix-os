/**
 * Message Board view types (spec 2700). Board, thread, task and event shapes
 * come from the shared contracts; view-only types live here.
 */

export {
  BOARD_ACTOR_KINDS, BOARD_EVENT_TYPES, BOARD_TASK_STATES,
  type BoardActor, type BoardActorKind, type BoardChannel, type BoardEvent, type BoardEventType, type BoardMessage,
  type BoardReaction, type BoardSummary, type BoardTask, type BoardTaskNeed, type BoardTaskState, type BoardThread,
  type BoardThreadSummary, type BoardWatcher, type BoardWatcherAction, type BoardSchedule,
} from "@matrix-os/contracts/message-board";
import type { BoardTaskState } from "@matrix-os/contracts/message-board";

export interface BoardThreadFilter {
  /** `k`, `k=v` or `k=v|w`. */
  label?: string;
  /** Actor ID. */
  author?: string;
  taskState?: BoardTaskState;
  text?: string;
}

export type BoardViewMode = "threads" | "tasks";
