import { CanonicalChatSafeErrorSchema, canonicalChatSafeFailureReason } from "@matrix-os/contracts";

/** Project validated wire envelopes only; stored failures retain the trusted cause. */
export function projectChatFundingErrors<T>(value: T, version: "0" | "1"): T {
  if (version === "1") return value;
  function project(input: unknown, depth: number): unknown {
    if (depth > 4 || input === null || typeof input !== "object") return input;
    if (Array.isArray(input)) return input.map(item => project(item, depth + 1));
    const result = { ...input } as Record<string, unknown>;
    const error = CanonicalChatSafeErrorSchema.safeParse(result.error);
    if (error.success && ["insufficient_credit", "budget_exceeded", "credit_reserved"].includes(error.data.code)) {
      const code = result.type === "run.error" ? "run_failed" : "provider_unavailable";
      result.error = { code, safeMessage: canonicalChatSafeFailureReason(code)!, retryable: false, recoveryActions: ["select_provider"] };
    }
    // Never descend into user message parts, tool output or arbitrary JSON.
    for (const key of ["record", "items", "content", "activities"]) {
      if (key in result) result[key] = project(result[key], depth + 1);
    }
    return result;
  }
  return project(value, 0) as T;
}
