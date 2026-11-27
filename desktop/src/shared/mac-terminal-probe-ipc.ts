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
