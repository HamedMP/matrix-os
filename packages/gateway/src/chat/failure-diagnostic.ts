import { z } from "zod/v4";

export const CHAT_RUN_CLEANUP_UNCONFIRMED_MESSAGE = "The Run could not be stopped. Its status is being checked.";

export const ChatRunFailureDiagnosticSchema = z.object({
  stage: z.enum(["preparation", "provider", "projection", "persistence", "recovery", "cleanup", "execution"]),
  category: z.enum(["timeout", "validation", "resource_limit", "state_conflict", "network", "authorization", "unknown"]),
}).strict();
export type ChatRunFailureDiagnostic = z.infer<typeof ChatRunFailureDiagnosticSchema>;

export const CHAT_FAILURE_CATEGORY_REASONS = {
  timeout: "Operation timed out",
  validation: "Agent event or state failed validation",
  resource_limit: "Agent output exceeded a resource limit",
  state_conflict: "Chat state changed during the operation",
  network: "Required connection unavailable",
  authorization: "Authorization failed",
  unknown: "Agent execution failed; detailed reason unavailable",
} satisfies Record<ChatRunFailureDiagnostic["category"], string>;

/** Deliberately classifies known errors instead of redacting arbitrary messages. */
export function diagnoseChatRunFailure(error: unknown, stage: ChatRunFailureDiagnostic["stage"]): ChatRunFailureDiagnostic {
  let category: ChatRunFailureDiagnostic["category"] = "unknown";
  if (error instanceof Error) {
    if (error.name === "TimeoutError") category = "timeout";
    else if (error.name === "ZodError") category = "validation";
    else if (error.name === "ChatConflictError" || error.name === "ChatBusyError") category = "state_conflict";
    else if (error.message === "Provider assistant output exceeded the canonical limit") category = "resource_limit";
    else if ("code" in error && typeof error.code === "string") {
      if (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(error.code)) category = "timeout";
      else if (["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(error.code)) category = "network";
      else if (["EACCES", "EPERM"].includes(error.code)) category = "authorization";
    }
  }
  return { stage, category };
}
