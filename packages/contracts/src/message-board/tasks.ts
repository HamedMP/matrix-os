import { z } from "zod/v4";
import {
  BOARD_EVENT_TYPES, BOARD_TEXT_MAX, BoardActorIdSchema, BoardActorSchema, BoardCursorSchema, BoardMessageIdSchema, BoardNameSchema, BoardTaskStateSchema,
  ChannelPathSchema, ChannelScopeSchema, LabelFilterSchema, LabelsSchema, ProfileNameSchema,
  type BoardEvent, type BoardTask,
} from "#message-board-schemas";

export const BOARD_LEASE_DEFAULT_SECONDS = 300;
export const BOARD_LEASE_MAX_SECONDS = 3_600;
export const BOARD_TASKS_PER_WRITE_MAX = 15;
/** Long-polls and server-side claim waits never exceed this. */
export const BOARD_WAIT_MAX_SECONDS = 25;

const Text = z.string().min(1).max(BOARD_TEXT_MAX).refine((value) => value.trim().length > 0, "Empty text");
const Reason = z.string().trim().min(1).max(2_000);
const LeaseSeconds = z.number().int().min(10).max(BOARD_LEASE_MAX_SECONDS);

export const BoardTaskKindSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);

const TaskOptions = {
  labels: LabelsSchema.optional(),
  needs: z.array(BoardMessageIdSchema).max(BOARD_TASKS_PER_WRITE_MAX).optional(),
  forProfile: ProfileNameSchema.optional(),
};

/** A new thread as a task, or an existing thread (`rootId`) turned into one. */
export const CreateTaskRequestSchema = z.union([
  z.object({ channel: ChannelPathSchema, text: Text, ...TaskOptions, claim: z.boolean().optional(), profile: ProfileNameSchema.optional() }).strict(),
  z.object({ rootId: BoardMessageIdSchema, needs: TaskOptions.needs, forProfile: TaskOptions.forProfile }).strict(),
]);
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

/** A plan: several tasks with dependencies, created all or none. `needs` may name plan keys or task IDs. */
export const CreateTaskPlanRequestSchema = z.object({
  channel: ChannelPathSchema,
  tasks: z.array(z.object({
    key: z.string().regex(/^[A-Za-z0-9_-]{1,48}$/),
    text: Text,
    labels: LabelsSchema.optional(),
    needs: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,48}$/)).max(BOARD_TASKS_PER_WRITE_MAX).optional(),
    forProfile: ProfileNameSchema.optional(),
  }).strict()).min(1).max(BOARD_TASKS_PER_WRITE_MAX),
  profile: ProfileNameSchema.optional(),
}).strict();
export type CreateTaskPlanRequest = z.infer<typeof CreateTaskPlanRequestSchema>;

export const ClaimTaskRequestSchema = z.union([
  z.object({ id: BoardMessageIdSchema, leaseSeconds: LeaseSeconds.optional(), profile: ProfileNameSchema.optional() }).strict(),
  z.object({
    ready: ChannelScopeSchema,
    label: LabelFilterSchema.optional(),
    /** Also take tasks created by this actor; tasks from other creators are never taken implicitly. */
    from: BoardActorIdSchema.optional(),
    leaseSeconds: LeaseSeconds.optional(),
    waitSeconds: z.number().int().min(0).max(BOARD_WAIT_MAX_SECONDS).optional(),
    profile: ProfileNameSchema.optional(),
  }).strict(),
]);
export type ClaimTaskRequest = z.infer<typeof ClaimTaskRequestSchema>;

/** Proof of the current claim. People holding a claim may omit it; agents must send it. */
const ClaimProof = { epoch: z.number().int().min(1).optional(), token: z.string().regex(/^[a-f0-9]{64}$/).optional() };

export const RenewTaskRequestSchema = z.object({ ...ClaimProof, leaseSeconds: LeaseSeconds.optional() }).strict();
export const ReleaseTaskRequestSchema = z.object({ ...ClaimProof }).strict();
export const CompleteTaskRequestSchema = z.object({ ...ClaimProof, result: z.string().trim().max(BOARD_TEXT_MAX).optional() }).strict();
export const FailTaskRequestSchema = z.object({ ...ClaimProof, reason: Reason }).strict();
export const BlockTaskRequestSchema = z.object({ ...ClaimProof, reason: Reason, kind: BoardTaskKindSchema.optional() }).strict();
export const UnblockTaskRequestSchema = z.object({}).strict();
export const ReopenTaskRequestSchema = z.object({}).strict();
export const AssignTaskRequestSchema = z.object({ profile: ProfileNameSchema.nullable() }).strict();
export const SetTaskNeedsRequestSchema = z.object({ needs: z.array(BoardMessageIdSchema).max(BOARD_TASKS_PER_WRITE_MAX) }).strict();
export const CancelTaskRequestSchema = z.object({ reason: Reason }).strict();

export type ClaimProofInput = { epoch?: number; token?: string };

export interface BoardClaim {
  task: BoardTask;
  taskId: string;
  epoch: number;
  /** Shown once; the board stores only its hash. */
  token: string;
}

export const TasksQuerySchema = z.object({
  board: BoardNameSchema.optional(),
  channel: ChannelScopeSchema.default("*"),
  state: BoardTaskStateSchema.optional(),
  label: LabelFilterSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
}).strict();

export const EventsQuerySchema = z.object({
  board: BoardNameSchema.optional(),
  after: BoardCursorSchema.optional(),
  /** Seconds to hold the request open when nothing is new. */
  wait: z.coerce.number().int().min(0).max(BOARD_WAIT_MAX_SECONDS).optional(),
  channel: ChannelScopeSchema.optional(),
  thread: BoardMessageIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
}).strict();
export type EventsQuery = z.infer<typeof EventsQuerySchema>;

export interface BoardEventsPage {
  events: BoardEvent[];
  /** Pass as `after` next time; unchanged when nothing arrived. */
  cursor: string;
  /** Set when `after` is older than the retained window; resume from `cursor`. */
  missed?: boolean;
}

/** Frames on `WS /ws/board/events`. */
export type BoardSocketFrame =
  | { type: "ready"; cursor: string }
  | { type: "event"; event: BoardEvent }
  | { type: "heartbeat" }
  | { type: "pong" }
  | { type: "missed"; cursor: string }
  | { type: "shutdown" }
  | { type: "error"; reason: "unavailable" | "capacity" | "invalid_input" | "forbidden" };

export const BoardSocketClientFrameSchema = z.object({ type: z.literal("ping") }).strict();

const SocketEventSchema = z.object({
  cursor: BoardCursorSchema,
  type: z.enum(BOARD_EVENT_TYPES),
  board: z.string().min(1).max(64),
  createdAt: z.string().max(64),
  actor: BoardActorSchema,
  channel: z.string().max(200).optional(),
  messageId: z.string().max(64).optional(),
  threadId: z.string().max(64).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

/** Every server frame on `WS /ws/board/events`, checked by clients before anything is used. */
export const BoardSocketServerFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), cursor: BoardCursorSchema }),
  z.object({ type: z.literal("event"), event: SocketEventSchema }),
  z.object({ type: z.literal("heartbeat") }),
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("missed"), cursor: BoardCursorSchema }),
  z.object({ type: z.literal("shutdown") }),
  z.object({ type: z.literal("error"), reason: z.enum(["unavailable", "capacity", "invalid_input", "forbidden"]) }),
]);

export const BoardSocketQuerySchema = z.object({
  board: BoardNameSchema.optional(),
  after: BoardCursorSchema.optional(),
  channel: ChannelScopeSchema.optional(),
  /** Browser WebSocket auth; read by the gateway auth middleware. */
  token: z.string().max(4_096).optional(),
}).strict();

export { Reason as BoardReasonSchema, LeaseSeconds as BoardLeaseSecondsSchema };
