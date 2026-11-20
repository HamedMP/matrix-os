import type {
  BoardActor, BoardChannel, BoardEvent, BoardMessage, BoardSchedule, BoardSummary,
  BoardThread, BoardThreadSummary, BoardWatcher,
} from "./types.js";

export { MESSAGE_BOARD_ERROR_REASONS, type MessageBoardErrorReason } from "@matrix-os/contracts/message-board";
import type { MessageBoardErrorReason } from "@matrix-os/contracts/message-board";

export class MessageBoardError extends Error {
  readonly reason: MessageBoardErrorReason;
  constructor(reason: MessageBoardErrorReason) {
    super(reason);
    this.name = "MessageBoardError";
    this.reason = reason;
  }
}

export interface PostInput {
  channel: string;
  text: string;
  labels?: Record<string, string>;
  /** Create the thread as a board task. */
  task?: { needs?: string[]; forProfile?: string };
}

export interface ReplyInput {
  text: string;
  replyTo?: string;
}

export interface LabelPatch {
  set?: Record<string, string>;
  unset?: string[];
}

export type BoardEventListener = (event: BoardEvent) => void;

/**
 * Everything the viewer does goes through this interface, so the HTTP/WS
 * client for `/api/board` and test doubles are interchangeable.
 * Rejections are `MessageBoardError`s.
 */
export interface MessageBoardClient {
  whoami(): Promise<BoardActor>;
  listBoards(): Promise<BoardSummary[]>;
  listActors(board: string): Promise<BoardActor[]>;
  listChannels(board: string): Promise<BoardChannel[]>;
  /** Threads in a channel, or a subtree when `channel` ends with `/`, or every channel for `*`. */
  listThreads(board: string, channel: string): Promise<BoardThreadSummary[]>;
  getThread(board: string, rootId: string): Promise<BoardThread>;
  markRead(board: string, rootId: string): Promise<void>;

  post(board: string, input: PostInput): Promise<BoardMessage>;
  reply(board: string, rootId: string, input: ReplyInput): Promise<BoardMessage>;
  edit(board: string, messageId: string, text: string, ifRevision: number): Promise<BoardMessage>;
  remove(board: string, messageId: string): Promise<void>;
  react(board: string, messageId: string, emoji: string, on: boolean): Promise<void>;
  label(board: string, messageId: string, patch: LabelPatch): Promise<void>;

  /** Turns an existing thread into a board task. */
  createTask(board: string, rootId: string, options?: { needs?: string[]; forProfile?: string }): Promise<void>;
  claimTask(board: string, taskId: string): Promise<void>;
  renewTask(board: string, taskId: string): Promise<void>;
  releaseTask(board: string, taskId: string): Promise<void>;
  completeTask(board: string, taskId: string, result?: string): Promise<void>;
  failTask(board: string, taskId: string, reason: string): Promise<void>;
  blockTask(board: string, taskId: string, reason: string, kind?: string): Promise<void>;
  unblockTask(board: string, taskId: string): Promise<void>;
  reopenTask(board: string, taskId: string): Promise<void>;
  /** `null` returns the task to the shared pool. */
  assignTask(board: string, taskId: string, profile: string | null): Promise<void>;
  cancelTask(board: string, taskId: string, reason: string): Promise<void>;

  listWatchers(board: string): Promise<BoardWatcher[]>;
  setWatcherEnabled(board: string, watcherId: string, enabled: boolean): Promise<void>;
  listSchedules(board: string): Promise<BoardSchedule[]>;
  cancelSchedule(board: string, scheduleId: string): Promise<void>;

  /** Live events for a board; returns the unsubscribe function. */
  subscribe(board: string, listener: BoardEventListener): () => void;
}
