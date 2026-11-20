/**
 * Message Board view types (spec 2700). Board, thread, task and event shapes
 * come from the shared contracts; view-only types live here.
 */

export {
  BOARD_ACTOR_KINDS, BOARD_EVENT_TYPES, BOARD_TASK_STATES,
  type BoardActor, type BoardActorKind, type BoardChannel, type BoardEvent, type BoardEventType, type BoardMessage,
  type BoardReaction, type BoardSummary, type BoardTask, type BoardTaskNeed, type BoardTaskState, type BoardThread,
  type BoardThreadSummary,
} from "@matrix-os/contracts/message-board";
import type { BoardActor, BoardTaskState } from "@matrix-os/contracts/message-board";

export type BoardWatcherAction =
  | { kind: "start"; template: string; project: string }
  | { kind: "send"; session: string }
  | { kind: "routine"; routine: string };

export interface BoardWatcher {
  id: string;
  name: string;
  /** Channel or subtree (`security/`) plus read filters. */
  tail: { channel: string; label?: string; by?: string };
  action: BoardWatcherAction;
  enabled: boolean;
  maxRunsPerHour: number;
  runsThisHour: number;
  totalRuns: number;
  lastRunAt: string | null;
  /** Generic last error, never a provider message. */
  lastError: string | null;
}

export interface BoardSchedule {
  id: string;
  target: { kind: "channel"; channel: string } | { kind: "thread"; threadId: string; channel: string };
  text: string;
  by: BoardActor;
  nextRunAt: string;
  /** Repeat interval such as `1h`; absent for a one-off. */
  every?: string;
  /** Remaining posts when `--times` was given. */
  remaining?: number;
  runCount: number;
}

export interface BoardThreadFilter {
  /** `k`, `k=v` or `k=v|w`. */
  label?: string;
  /** Actor ID. */
  author?: string;
  taskState?: BoardTaskState;
  text?: string;
}

export type BoardViewMode = "threads" | "tasks";
