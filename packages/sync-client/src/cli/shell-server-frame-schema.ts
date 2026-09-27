import { z } from "zod/v4";

const TerminalRefSchema = z.object({
  workspaceId: z.string().regex(/^tws_[0-9a-f]{32}$/),
  tabId: z.string().regex(/^tt_[0-9a-f]{32}$/),
}).strict();

const TerminalGridSizeSchema = z.object({
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200),
}).strict();

const SafeClientRecoveryActionSchema = z.enum([
  "retry",
  "sign_in",
  "select_runtime",
  "open_setup_terminal",
  "resume",
  "start_new_session",
  "return_home",
]);

const TerminalServerEventBaseSchema = z.object({
  terminalRef: TerminalRefSchema,
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

// Keep in step with TerminalTabServerFrameSchema in @matrix-os/contracts: a missing
// field makes the strict parse silently drop the frame (tests/cli/shell-client-frame-drift.test.ts).
// The published CLI cannot import the contracts root, which pulls in chat-only dependencies.
export const ShellServerFrameSchema = z.discriminatedUnion("type", [
  TerminalServerEventBaseSchema.extend({
    type: z.literal("attached"),
    canonicalSize: TerminalGridSizeSchema,
    nextSeq: z.number().int().min(0),
    capabilities: z.array(z.string().min(1).max(80)).max(8).optional(),
    ownership: z.enum(["writer", "observer"]).optional(),
    leaseEpoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  }).strict(),
  TerminalServerEventBaseSchema.extend({
    type: z.literal("snapshot"),
    canonicalSize: TerminalGridSizeSchema,
    presentationRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    seq: z.number().int().min(0),
    ansi: z.string().max(5 * 1024 * 1024),
    viewport: z.object({
      top: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      rows: z.number().int().min(1).max(200),
    }).strict(),
  }).strict(),
  TerminalServerEventBaseSchema.extend({
    type: z.literal("output"),
    seq: z.number().int().min(0),
    data: z.string().min(1).max(64 * 1024),
  }).strict(),
  TerminalServerEventBaseSchema.extend({ type: z.literal("replay-start"), fromSeq: z.number().int().min(0) }).strict(),
  TerminalServerEventBaseSchema.extend({
    type: z.literal("replay-evicted"),
    fromSeq: z.number().int().min(0),
    nextSeq: z.number().int().min(0),
  }).strict(),
  TerminalServerEventBaseSchema.extend({
    type: z.literal("replay-gap"),
    fromSeq: z.number().int().min(0),
    nextSeq: z.number().int().min(0),
  }).strict(),
  TerminalServerEventBaseSchema.extend({
    type: z.literal("replay-end"),
    nextSeq: z.number().int().min(0),
    toSeq: z.number().int().min(0).nullable().optional(),
  }).strict(),
  TerminalServerEventBaseSchema.extend({ type: z.literal("canonical-size"), canonicalSize: TerminalGridSizeSchema }).strict(),
  TerminalServerEventBaseSchema.extend({ type: z.literal("pong") }).strict(),
  TerminalServerEventBaseSchema.extend({ type: z.literal("exit"), exitCode: z.number().int().nullable() }).strict(),
  z.object({
    type: z.literal("lease-revoked"),
    terminalRef: TerminalRefSchema,
    epoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  }).strict(),
  z.object({
    type: z.literal("error"),
    terminalRef: TerminalRefSchema.optional(),
    code: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
    message: z.string().min(1).max(720),
  }).strict(),
  z.object({
    type: z.literal("safe-error"),
    terminalRef: TerminalRefSchema.optional(),
    error: z.object({
      code: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
      safeMessage: z.string().min(1).max(180),
      retryable: z.boolean(),
      recoveryActions: z.array(SafeClientRecoveryActionSchema).max(6).optional(),
    }).strict(),
  }).strict(),
]);
