import { isAbsolute } from "node:path";
import { z } from "zod/v4";
import { CanonicalChatIdSchema, TerminalRefSchema, WorktreeIdSchema } from "@matrix-os/contracts";
import { isHerdrChatTerminalRef } from "@matrix-os/contracts/herdr-terminals";
import { ManagedTerminalTurnAuthoritySchema } from "@matrix-os/contracts/managed-terminal-control";

export const HERDR_CHAT_ROUTE = "/api/chat/herdr-terminal";
export const HerdrChatTargetSchema = z.strictObject({
  chatId: CanonicalChatIdSchema,
  worktreeId: WorktreeIdSchema,
  executionRoot: z.string().min(1).max(4096).refine(path => isAbsolute(path) && !path.includes("\0")),
  ref: TerminalRefSchema.refine(isHerdrChatTerminalRef),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  authority: ManagedTerminalTurnAuthoritySchema.optional(),
});
export type HerdrChatTarget = z.infer<typeof HerdrChatTargetSchema>;
