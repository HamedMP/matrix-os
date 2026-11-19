import type { MessageBoardErrorBody, MessageBoardErrorReason } from "@matrix-os/contracts/message-board";

/** A typed board failure. The reason is stable and safe to show; the cause stays in logs. */
export class MessageBoardServiceError extends Error {
  readonly reason: MessageBoardErrorReason;
  constructor(reason: MessageBoardErrorReason) {
    super(reason);
    this.name = "MessageBoardServiceError";
    this.reason = reason;
  }
}

export function boardFail(reason: MessageBoardErrorReason): never {
  throw new MessageBoardServiceError(reason);
}

const STATUS: Record<MessageBoardErrorReason, 400 | 403 | 404 | 408 | 409 | 410 | 413 | 429 | 503> = {
  nothing_ready: 404, timeout: 408, task_claimed: 409, claim_lost: 409, claim_not_held: 409,
  task_assigned: 409, task_waiting: 409, task_blocked: 409, task_finished: 409, task_not_owned: 403,
  invalid_needs: 400, revision_conflict: 409, label_conflict: 409, reserved_label: 400, duplicate_id: 409,
  message_deleted: 410, forbidden: 403, channel_exists: 409, not_found: 404, invalid_input: 400,
  unavailable: 503, limit_reached: 409, thread_full: 409, rate_limited: 429, missed: 410,
};

const COPY: Record<MessageBoardErrorReason, string> = {
  nothing_ready: "No task is ready to claim.",
  timeout: "Nothing arrived before the timeout.",
  task_claimed: "Someone else holds this task.",
  claim_lost: "Your claim on this task has lapsed.",
  claim_not_held: "You do not hold this task.",
  task_assigned: "This task is assigned to another profile.",
  task_waiting: "This task is waiting on another task.",
  task_blocked: "This task is blocked.",
  task_finished: "This task is already finished.",
  task_not_owned: "Only the task's creator or the board owner can do that.",
  invalid_needs: "Those prerequisites are not valid.",
  revision_conflict: "The message changed since you read it.",
  label_conflict: "The labels changed since you read them.",
  reserved_label: "Labels starting with board. or matrix. are set by Matrix OS.",
  duplicate_id: "That already exists.",
  message_deleted: "That message was deleted.",
  forbidden: "You do not have access to that.",
  channel_exists: "That channel already exists.",
  not_found: "Not found.",
  invalid_input: "Invalid request.",
  unavailable: "The message board is unavailable.",
  limit_reached: "A board limit was reached.",
  thread_full: "This thread is closed to new replies.",
  rate_limited: "Too many writes. Try again shortly.",
  missed: "Those events are no longer retained.",
};

const NEXT: Partial<Record<MessageBoardErrorReason, string>> = {
  nothing_ready: "wait for a task.ready event, then claim again",
  claim_lost: "read the task again; claim it if it is ready",
  revision_conflict: "read the message again and retry with its revision",
  label_conflict: "read the labels again before retrying",
  thread_full: "start a new thread",
  rate_limited: "retry after a minute",
  missed: "read from the oldest available cursor",
};

export function boardErrorStatus(reason: MessageBoardErrorReason) {
  return STATUS[reason];
}

export function boardErrorBody(reason: MessageBoardErrorReason): MessageBoardErrorBody {
  const next = NEXT[reason];
  return { error: COPY[reason], reason, ...(next ? { next } : {}) };
}
