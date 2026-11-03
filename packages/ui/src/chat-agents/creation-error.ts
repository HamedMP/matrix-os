import { safeHttpStatus } from "./safe-http-status.js";

export type BotCreationFailureReason = "prompt_too_large" | "unsupported_skill";

/** Only these server diagnoses cross the transport; messages remain local copy. */
export function botCreationFailureReason(value: unknown): BotCreationFailureReason | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const body = "error" in value && typeof value.error === "object" && value.error !== null ? value.error : value;
  const reason = "reason" in body ? body.reason : undefined;
  return reason === "prompt_too_large" || reason === "unsupported_skill" ? reason : undefined;
}

export function botCreationFailureMessage(failure: unknown): string | undefined {
  if (safeHttpStatus(failure) !== 400) return undefined;
  switch (botCreationFailureReason(failure)) {
    case "prompt_too_large": return "Shorten the instructions or remove recipe skills, then try again.";
    case "unsupported_skill": return "Remove the unavailable skill before creating this Bot.";
    default: return undefined;
  }
}
