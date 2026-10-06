import { canonicalAgentFailure } from "@matrix-os/contracts";
import { CanonicalCliError } from "./cli-process.js";

// Called only for failed native execution; ordinary assistant/tool output is not evidence.
export function classifiedClaudeFailureEvidence(text: string) {
  if (/\b(?:unsupported|invalid) model\b|\bmodel\b.{0,120}\b(?:does not exist|not found|not available|unavailable|unsupported)\b/i.test(text)) {
    return {
      category: "unsupported_model" as const,
      safeError: canonicalAgentFailure("model_unavailable")!,
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
      safeError: canonicalAgentFailure("permission_denied")!,
    };
  }
  if (/(?:^|\n)\s*(?:Prompt is too long|Context window exceeded)\b/i.test(text)) {
    return { category: "context_limit" as const, safeError: canonicalAgentFailure("context_limit")! };
  }
  return undefined;
}

// Typed process failures are trusted local evidence, not upstream error prose.
export function classifiedClaudeCliFailure(error: unknown) {
  if (!(error instanceof CanonicalCliError)) return undefined;
  if (error.kind === "startup") return { category: "startup" as const, safeError: canonicalAgentFailure("agent_unavailable")! };
  if (error.kind === "timeout") return { category: "timeout" as const, safeError: canonicalAgentFailure("request_timeout")! };
  if (error.kind === "invalid_output" || error.kind === "stdout_limit") {
    return { category: "invalid_protocol" as const, safeError: canonicalAgentFailure("invalid_response")! };
  }
  return undefined;
}
