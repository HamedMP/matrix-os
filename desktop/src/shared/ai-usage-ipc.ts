import { UsageExportSchema } from "@matrix-os/contracts/ai-usage";
import { ChatImportSessionSchema } from "./local-chat-import-ipc";
import { z } from "zod/v4";
export const AI_USAGE_INVOKE = {
  "runtime:ai-usage-sync": {
    request: ChatImportSessionSchema.extend({ force: z.boolean().optional() }),
    response: z.discriminatedUnion("status", [
      z.strictObject({
        status: z.literal("synced"),
        syncedAt: z.iso.datetime(),
      }),
      z.strictObject({ status: z.literal("unpaired") }),
    ]),
  },
  "runtime:ai-usage": {
    request: ChatImportSessionSchema,
    response: UsageExportSchema,
  },
} as const;
