import { CanonicalChatIdSchema, CanonicalChatRunIdSchema, WorktreeIdSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { LocalTerminalIdSchema } from "./local-terminals";

const Prepare = z.strictObject({ chatId: CanonicalChatIdSchema, worktreeId: WorktreeIdSchema });
const Run = z.strictObject({ chatId: CanonicalChatIdSchema, runId: CanonicalChatRunIdSchema });
const PrepareReply = z.union([
  z.strictObject({
    status: z.literal("ready"), targetId: z.uuid(), terminalId: LocalTerminalIdSchema,
    expiresAt: z.number().int().positive(),
  }),
  z.strictObject({ status: z.enum(["declined", "unavailable", "busy", "failed"]) }),
]);
export const MAC_TERMINAL_SNAPSHOT_MAX_CHARS = 2_000;
const TerminalScreen = z.string().max(MAC_TERMINAL_SNAPSHOT_MAX_CHARS * 2)
  .regex(/^[^\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]*$/)
  .refine(text => Array.from(text).length <= MAC_TERMINAL_SNAPSHOT_MAX_CHARS);
const TerminalSnapshot = {
  terminalId: LocalTerminalIdSchema,
  title: z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/),
};
const TerminalSelectionFailure = z.strictObject({ status: z.enum(["declined", "unavailable", "busy", "failed"]) });
const ExistingTerminalReadReply = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ready"), ...TerminalSnapshot, output: TerminalScreen.refine(text => text.length > 0) }),
  TerminalSelectionFailure,
]);
const TerminalWatchRequest = Prepare.extend({ requestId: z.uuid() });
const TerminalWatchReference = Prepare.extend({ watchId: z.uuid() });
const TerminalWatchStartReply = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ready"), ...TerminalSnapshot, output: TerminalScreen,
    watchId: z.uuid(), expiresAt: z.number().int().positive(),
  }),
  TerminalSelectionFailure,
]);
const TerminalWatchReadReply = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ready"), output: TerminalScreen }),
  z.strictObject({ status: z.enum(["ended", "busy"]) }),
]);
const RunReply = z.strictObject({ status: z.enum(["returned", "unavailable", "busy", "failed", "already-handled"]) });
const BackgroundGrant = {
  targetId: z.uuid(),
  expiresAt: z.number().int().positive(),
  remaining: z.number().int().min(0).max(3),
};
const BackgroundStartReply = z.union([
  z.strictObject({ status: z.literal("ready"), ...BackgroundGrant }),
  z.strictObject({ status: z.enum(["declined", "unavailable", "busy", "failed"]) }),
]);
const BackgroundStatus = z.discriminatedUnion("active", [
  z.strictObject({ active: z.literal(false) }),
  z.strictObject({
    active: z.literal(true), ...BackgroundGrant,
    phase: z.enum(["waiting", "running", "returning"]),
  }),
]);

export const MAC_TERMINAL_PROBE_INVOKE = {
  "chat:mac-terminal-available": { request: z.strictObject({}), response: z.strictObject({ available: z.boolean() }) },
  "chat:mac-terminal-prepare": { request: Prepare, response: PrepareReply },
  "chat:mac-terminal-read-existing": { request: Prepare, response: ExistingTerminalReadReply },
  "chat:mac-terminal-watch-start": { request: TerminalWatchRequest, response: TerminalWatchStartReply },
  "chat:mac-terminal-watch-read": { request: TerminalWatchReference, response: TerminalWatchReadReply },
  "chat:mac-terminal-watch-stop": {
    request: z.union([TerminalWatchReference, TerminalWatchRequest]),
    response: z.strictObject({ ok: z.boolean() }),
  },
  "chat:mac-terminal-run": { request: Run, response: RunReply },
  "chat:mac-terminal-background-start": { request: Prepare, response: BackgroundStartReply },
  "chat:mac-terminal-background-status": { request: Prepare, response: BackgroundStatus },
  "chat:mac-terminal-cancel": {
    request: z.strictObject({ chatId: CanonicalChatIdSchema }),
    response: z.strictObject({ ok: z.boolean() }),
  },
} as const;

export type PrepareMacTerminalCheck = z.infer<typeof Prepare>;
export type PrepareMacTerminalCheckReply = z.infer<typeof PrepareReply>;
export type RunMacTerminalCheck = z.infer<typeof Run>;
export type RunMacTerminalCheckReply = z.infer<typeof RunReply>;
