import { z } from "zod/v4";
import {
  BOARD_TEXT_MAX, BoardActorIdSchema, BoardMessageIdSchema, ChannelPathSchema, ChannelScopeSchema, LabelFilterSchema,
  type BoardActor,
} from "#message-board-schemas";

/* ---------------- durations ---------------- */

const DURATION = /^([1-9][0-9]{0,5})(s|m|h|d)$/;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** `30s`, `5m`, `2h`, `7d`. */
export const BoardDurationSchema = z.string().regex(DURATION);

export function boardDurationMs(value: string): number {
  const match = DURATION.exec(value);
  if (!match) throw new Error("Invalid duration");
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

/* ---------------- watchers (spec 2700 section 6) ---------------- */

export const BOARD_WATCHERS_PER_BOARD_MAX = 32;
export const BOARD_WATCHER_RUNS_PER_HOUR_DEFAULT = 20;
export const BOARD_WATCHER_RUNS_PER_HOUR_MAX = 120;
/** Events from sessions this many watcher hops deep never wake a watcher. */
export const BOARD_WATCHER_MAX_DEPTH = 3;

export const BoardWatcherNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const Slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

export const BoardWatcherTailSchema = z.object({
  channel: ChannelScopeSchema,
  label: LabelFilterSchema.optional(),
  by: BoardActorIdSchema.optional(),
}).strict();

export const BoardWatcherActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), template: Slug, project: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional() }).strict(),
  z.object({ kind: z.literal("send"), session: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/) }).strict(),
  z.object({ kind: z.literal("routine"), routine: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict(),
]);
export type BoardWatcherAction = z.infer<typeof BoardWatcherActionSchema>;

export const CreateWatcherRequestSchema = z.object({
  name: BoardWatcherNameSchema,
  tail: BoardWatcherTailSchema,
  action: BoardWatcherActionSchema,
  enabled: z.boolean().optional(),
  maxRunsPerHour: z.number().int().min(1).max(BOARD_WATCHER_RUNS_PER_HOUR_MAX).optional(),
}).strict();
export type CreateWatcherRequest = z.infer<typeof CreateWatcherRequestSchema>;

export const PatchWatcherRequestSchema = z.object({
  enabled: z.boolean().optional(),
  maxRunsPerHour: z.number().int().min(1).max(BOARD_WATCHER_RUNS_PER_HOUR_MAX).optional(),
  tail: BoardWatcherTailSchema.optional(),
  action: BoardWatcherActionSchema.optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, "Nothing to change");

export const BoardWatcherIdSchema = z.string().regex(/^wat_[A-Za-z0-9]{8,40}$/);

export interface BoardWatcher {
  id: string;
  name: string;
  tail: { channel: string; label?: string; by?: string };
  action: BoardWatcherAction;
  enabled: boolean;
  maxRunsPerHour: number;
  runsThisHour: number;
  totalRuns: number;
  lastRunAt: string | null;
  /** Generic copy only; never a provider or session error. */
  lastError: string | null;
}

/* ---------------- schedules (spec 2700 section 7) ---------------- */

export const BOARD_SCHEDULES_PER_BOARD_MAX = 200;
export const BOARD_SCHEDULE_MIN_INTERVAL_MS = 60_000;

export const BoardScheduleIdSchema = z.string().regex(/^sch_[A-Za-z0-9]{8,40}$/);

export const CreateScheduleRequestSchema = z.object({
  channel: ChannelPathSchema.optional(),
  thread: BoardMessageIdSchema.optional(),
  text: z.string().min(1).max(BOARD_TEXT_MAX).refine((value) => value.trim().length > 0, "Empty text"),
  in: BoardDurationSchema.optional(),
  at: z.iso.datetime({ offset: true }).optional(),
  every: BoardDurationSchema.optional(),
  times: z.number().int().min(1).max(10_000).optional(),
  until: z.iso.datetime({ offset: true }).optional(),
}).strict()
  .refine((value) => Boolean(value.channel) !== Boolean(value.thread), "Give a channel or a thread")
  .refine((value) => !(value.in && value.at), "Give --in or --at, not both")
  .refine((value) => !value.every || boardDurationMs(value.every) >= BOARD_SCHEDULE_MIN_INTERVAL_MS, "The shortest interval is 1 minute")
  .refine((value) => !value.in || boardDurationMs(value.in) >= BOARD_SCHEDULE_MIN_INTERVAL_MS, "The shortest delay is 1 minute");
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequestSchema>;

export interface BoardSchedule {
  id: string;
  target: { kind: "channel"; channel: string } | { kind: "thread"; threadId: string; channel: string };
  text: string;
  by: BoardActor;
  nextRunAt: string;
  every?: string;
  remaining?: number;
  until?: string;
  runCount: number;
}

/* ---------------- grants (spec 2700 section 8) ---------------- */

export const BOARD_GRANT_PERMISSIONS = ["read", "post", "react", "label", "manage"] as const;
export type BoardGrantPermission = (typeof BOARD_GRANT_PERMISSIONS)[number];

/** `*` (everyone with board access) or one actor, for example `user:usr_1`. */
export const BoardGrantPrincipalSchema = z.union([z.literal("*"), BoardActorIdSchema]);
export const BoardGrantIdSchema = z.string().regex(/^grt_[A-Za-z0-9]{8,40}$/);

export const CreateGrantRequestSchema = z.object({
  principals: z.array(BoardGrantPrincipalSchema).min(1).max(32),
  /** Exact channel, subtree ending in `/`, or `*`. */
  channel: ChannelScopeSchema,
  /** An empty list is a closing grant: at this pattern the principal gets nothing. */
  permissions: z.array(z.enum(BOARD_GRANT_PERMISSIONS)).max(5),
}).strict();
export type CreateGrantRequest = z.infer<typeof CreateGrantRequestSchema>;

export const PatchGrantRequestSchema = z.object({ permissions: z.array(z.enum(BOARD_GRANT_PERMISSIONS)).max(5) }).strict();

export interface BoardGrant {
  id: string;
  principal: string;
  channel: string;
  permissions: BoardGrantPermission[];
  createdBy: string;
  createdAt: string;
}

export interface BoardGrantExplanation {
  channel: string;
  principal: string;
  /** The pattern whose grants decided, or null when only the default applies. */
  pattern: string | null;
  permissions: BoardGrantPermission[];
  /** The grants at the deciding pattern and principal level. */
  grants: BoardGrant[];
  source: "owner" | "grants" | "default";
}

export const ExplainGrantsQuerySchema = z.object({
  board: z.string().trim().min(1).max(64).optional(),
  channel: ChannelPathSchema,
  principal: BoardActorIdSchema.optional(),
}).strict();

