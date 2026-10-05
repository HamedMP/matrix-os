import { canonicalAgentFailure } from "@matrix-os/contracts";

// Called only for failed native execution; ordinary assistant/tool output is not evidence.
export function classifiedClaudeFailureEvidence(text: string) {
  if (/\b(?:unsupported|invalid) model\b|\bmodel\b.{0,120}\b(?:does not exist|not found|not available|unavailable|unsupported)\b/i.test(text)) {
    return {
      category: "unsupported_model" as const,
      safeError: {
        code: "model_unavailable" as const,
        safeMessage: "The selected Claude model is unavailable. Choose another model and try again.",
        retryable: false,
        recoveryActions: ["select_provider" as const],
      },
    };
  }
  if (/\b(?:authentication (?:failed|required)|unauthorized|not logged in|login required|invalid (?:api[ -]?key|x-api-key)|api[ -]?key.{0,80}(?:missing|required|invalid)|oauth.{0,80}(?:expired|required)|credentials?.{0,80}(?:missing|invalid|expired|required))\b|\bplease (?:run )?\/?login\b/i.test(text)) {
    return {
      category: "authentication" as const,
      safeError: canonicalAgentFailure("authentication_required")!,
    };
  }
  if (/(?:^|\n)\s*(?:Your )?credit balance is too low\b/i.test(text)) {
    return { category: "credit" as const, safeError: canonicalAgentFailure("credit_required")! };
  }
  if (/\b(?:permission denied|not permitted|operation not permitted|access denied|requires? permission)\b/i.test(text)) {
    return {
      category: "permission" as const,
      safeError: {
        code: "authorization_failed" as const,
        safeMessage: "Claude was blocked by its current permissions. Review the permission mode and try again.",
        retryable: true,
        recoveryActions: ["retry" as const],
      },
    };
  }
  return undefined;
}

