import { UsageExportSchema } from "@matrix-os/contracts/ai-usage";
import { ChatImportSessionSchema } from "./local-chat-import-ipc";
export const AI_USAGE_INVOKE = {
  "runtime:ai-usage": {
    request: ChatImportSessionSchema,
    response: UsageExportSchema,
  },
} as const;
