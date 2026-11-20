import { z } from "zod/v4";

/**
 * Message Board contracts (spec 2700). One shape for the gateway routes, the
 * `matrix board` CLI, agent tools and every viewer.
 */

export const BOARD_TEXT_MAX = 10_000;
export const BOARD_LABELS_PER_MESSAGE_MAX = 20;
export const BOARD_PAGE_DEFAULT = 50;
export const BOARD_PAGE_MAX = 500;
export const BOARD_DEFAULT_NAME = "General";

const CHANNEL_SEGMENT = /^[a-z0-9_-]{1,48}$/;
const LABEL_KEY = /^[a-z0-9_.-]{1,64}$/;
export const RESERVED_LABEL_PREFIXES = ["board.", "matrix."] as const;

export const BoardNameSchema = z.string().trim().min(1).max(64).refine((value) => !value.includes("/"), "Board names cannot contain /");

/** Lowercase segments joined by `/`: at most 8 segments of 1 to 48 characters, 200 characters in total. */
export const ChannelPathSchema = z.string().min(1).max(200).refine((value) => {
  const segments = value.split("/");
  return segments.length <= 8 && segments.every((segment) => CHANNEL_SEGMENT.test(segment));
}, "Invalid channel path");

/** A channel, a subtree (`security/`), or every channel (`*`). */
export const ChannelScopeSchema = z.union([
  z.literal("*"),
  ChannelPathSchema,
  z.string().min(2).max(201).refine((value) => value.endsWith("/") && ChannelPathSchema.safeParse(value.slice(0, -1)).success, "Invalid channel subtree"),
]);

export const BoardMessageIdSchema = z.string().regex(/^msg_[A-Za-z0-9]{8,40}$/);
export const BoardIdSchema = z.string().regex(/^brd_[A-Za-z0-9]{8,40}$/);
export const BoardCursorSchema = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
export const BoardLimitSchema = z.coerce.number().int().min(1).max(BOARD_PAGE_MAX);

export const LabelKeySchema = z.string().regex(LABEL_KEY);
/** No `|` and no surrounding whitespace, so every stored value can be matched by a label filter. */
export const LabelValueSchema = z.string().min(1)
  .refine((value) => new TextEncoder().encode(value).length <= 256, "Label value too long")
  .refine((value) => !value.includes("|") && value.trim() === value, "Label values cannot contain | or surrounding spaces");
export const LabelsSchema = z.record(LabelKeySchema, LabelValueSchema)
  .refine((labels) => Object.keys(labels).length <= BOARD_LABELS_PER_MESSAGE_MAX, "Too many labels");

export function isReservedBoardLabelKey(key: string): boolean {
  return RESERVED_LABEL_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** `k`, `k=v` or `k=v|w`. */
export const LabelFilterSchema = z.string().trim().min(1).max(400).refine((value) => {
  const separator = value.indexOf("=");
  const key = separator === -1 ? value : value.slice(0, separator);
  if (!LABEL_KEY.test(key)) return false;
  if (separator === -1) return true;
  return value.slice(separator + 1).split("|").every((item) => item.length > 0 && item.length <= 256);
}, "Invalid label filter");

export interface ParsedLabelFilter { key: string; values: string[] | null }

export function parseBoardLabelFilter(value: string): ParsedLabelFilter {
  const trimmed = LabelFilterSchema.parse(value);
  const separator = trimmed.indexOf("=");
  if (separator === -1) return { key: trimmed, values: null };
  return { key: trimmed.slice(0, separator), values: trimmed.slice(separator + 1).split("|") };
}

/** A short emoji or `:name:` token, no whitespace. */
export const EmojiSchema = z.string().min(1).max(32).regex(/^[^\s]+$/u);
/** A letter, then up to 31 letters, digits or hyphens. */
export const ProfileNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,31}$/);
export const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

export const BOARD_ACTOR_KINDS = ["user", "agent", "bot", "watcher", "system"] as const;
export type BoardActorKind = (typeof BOARD_ACTOR_KINDS)[number];
export const BoardActorIdSchema = z.string().regex(/^(user|agent|bot|watcher|system):[A-Za-z0-9_.:@-]{1,200}$/);

export const BoardActorSchema = z.object({
  id: BoardActorIdSchema,
  kind: z.enum(BOARD_ACTOR_KINDS),
  name: z.string().min(1).max(200),
  profile: ProfileNameSchema.optional(),
});
export type BoardActor = z.infer<typeof BoardActorSchema>;

export const BOARD_TASK_STATES = ["waiting", "ready", "claimed", "blocked", "completed", "failed", "canceled"] as const;
export type BoardTaskState = (typeof BOARD_TASK_STATES)[number];
export const BoardTaskStateSchema = z.enum(BOARD_TASK_STATES);

export interface BoardTask {
  state: BoardTaskState;
  createdBy: string;
  assignedProfile: string | null;
  holder: BoardActor | null;
  leaseUntil: string | null;
  epoch: number;
  needs: string[];
  blockedReason?: string;
  blockedKind?: string;
  result?: string;
  failureReason?: string;
  cancelReason?: string;
  updatedAt: string;
}

export interface BoardReaction { emoji: string; actors: string[] }

export interface BoardMessage {
  id: string;
  channel: string;
  text: string;
  re: string | null;
  replyTo: string | null;
  by: BoardActor;
  labels: Record<string, string>;
  reactions: BoardReaction[];
  revision: number;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string | null;
}

export interface BoardThreadSummary {
  root: BoardMessage;
  replyCount: number;
  latestReply: BoardMessage | null;
  lastActivityAt: string;
  task: BoardTask | null;
  unread: boolean;
}

export interface BoardTaskNeed { id: string; title: string; state: BoardTaskState }

export interface BoardThread {
  root: BoardMessage;
  replies: BoardMessage[];
  task: BoardTask | null;
  needs: BoardTaskNeed[];
}

export interface BoardChannel {
  path: string;
  unread: number;
  threadCount: number;
  lastActivityAt: string | null;
}

export interface BoardSummary {
  id: string;
  name: string;
  scope: "personal" | "organization";
}

export const BOARD_EVENT_TYPES = [
  "message.posted", "message.edited", "message.deleted",
  "reaction.added", "reaction.removed", "labels.changed", "channel.created",
  "task.created", "task.ready", "task.claimed", "task.renewed", "task.released", "task.completed", "task.failed",
  "task.blocked", "task.unblocked", "task.canceled", "task.reopened", "task.assigned",
  "task.needs_changed", "task.expired",
  "watcher.changed", "schedule.changed",
] as const;
export type BoardEventType = (typeof BOARD_EVENT_TYPES)[number];

export interface BoardEvent {
  cursor: string;
  type: BoardEventType;
  board: string;
  createdAt: string;
  actor: BoardActor;
  channel?: string;
  messageId?: string;
  threadId?: string;
  payload?: Record<string, unknown>;
}

export const MESSAGE_BOARD_ERROR_REASONS = [
  "nothing_ready", "timeout", "task_claimed", "claim_lost", "claim_not_held", "task_assigned",
  "task_waiting", "task_blocked", "task_finished", "task_not_owned", "invalid_needs",
  "revision_conflict", "label_conflict", "reserved_label", "duplicate_id", "message_deleted",
  "forbidden", "channel_exists", "not_found", "invalid_input", "unavailable", "limit_reached",
  "thread_full", "rate_limited", "missed",
] as const;
export type MessageBoardErrorReason = (typeof MESSAGE_BOARD_ERROR_REASONS)[number];

export const MessageBoardErrorBodySchema = z.object({
  error: z.string().max(200),
  reason: z.enum(MESSAGE_BOARD_ERROR_REASONS),
  next: z.string().max(200).optional(),
});
export type MessageBoardErrorBody = z.infer<typeof MessageBoardErrorBodySchema>;

/* ---------- Requests ---------- */

export const BoardQuerySchema = z.object({ board: BoardNameSchema.optional() });

export const CreateBoardRequestSchema = z.object({ name: BoardNameSchema }).strict();
export const CreateChannelRequestSchema = z.object({
  path: ChannelPathSchema,
  /** Readable only by its creator: a grant for the creator and a closing grant for everyone else. */
  private: z.boolean().optional(),
}).strict();

export const PostMessageRequestSchema = z.object({
  channel: ChannelPathSchema,
  text: z.string().min(1).max(BOARD_TEXT_MAX).refine((value) => value.trim().length > 0, "Empty message"),
  /** Thread root to reply to; omitted for a new thread. */
  re: BoardMessageIdSchema.optional(),
  replyTo: BoardMessageIdSchema.optional(),
  labels: LabelsSchema.optional(),
  idempotencyKey: IdempotencyKeySchema.optional(),
  profile: ProfileNameSchema.optional(),
}).strict();
export type PostMessageRequest = z.infer<typeof PostMessageRequestSchema>;

export const EditMessageRequestSchema = z.object({
  text: z.string().min(1).max(BOARD_TEXT_MAX).refine((value) => value.trim().length > 0, "Empty message"),
  ifRevision: z.number().int().min(1).optional(),
}).strict();

export const DeleteMessageRequestSchema = z.object({ ifRevision: z.number().int().min(1).optional() }).strict();

export const ReactionRequestSchema = z.object({ emoji: EmojiSchema, on: z.boolean() }).strict();

export const LabelPatchRequestSchema = z.object({
  set: LabelsSchema.optional(),
  unset: z.array(LabelKeySchema).max(BOARD_LABELS_PER_MESSAGE_MAX).optional(),
  /** Compare-and-set: each key must currently hold this value. */
  if: LabelsSchema.optional(),
  /** Compare-and-set: each key must currently be absent. */
  ifUnset: z.array(LabelKeySchema).max(BOARD_LABELS_PER_MESSAGE_MAX).optional(),
}).strict().refine((patch) => Boolean(patch.set && Object.keys(patch.set).length) || Boolean(patch.unset?.length), "Nothing to change");
export type LabelPatchRequest = z.infer<typeof LabelPatchRequestSchema>;

const OptionalText = z.string().trim().min(1).max(200).optional();

export const ThreadsQuerySchema = z.object({
  board: BoardNameSchema.optional(),
  channel: ChannelScopeSchema.default("*"),
  label: LabelFilterSchema.optional(),
  by: BoardActorIdSchema.optional(),
  text: OptionalText,
  taskState: BoardTaskStateSchema.optional(),
  /** `tasks` keeps only threads that are board tasks (the viewer's Tasks queue). */
  kind: z.literal("tasks").optional(),
  limit: BoardLimitSchema.default(BOARD_PAGE_DEFAULT),
}).strict();
export type ThreadsQuery = z.infer<typeof ThreadsQuerySchema>;

export const MessagesQuerySchema = z.object({
  board: BoardNameSchema.optional(),
  channel: ChannelScopeSchema.optional(),
  re: BoardMessageIdSchema.optional(),
  by: BoardActorIdSchema.optional(),
  mentions: z.string().regex(/^[a-z0-9_.-]{1,64}$/).optional(),
  label: LabelFilterSchema.optional(),
  text: OptionalText,
  /** Messages created after this message ID, oldest first. */
  after: BoardMessageIdSchema.optional(),
  limit: BoardLimitSchema.default(BOARD_PAGE_DEFAULT),
}).strict();
export type MessagesQuery = z.infer<typeof MessagesQuerySchema>;
