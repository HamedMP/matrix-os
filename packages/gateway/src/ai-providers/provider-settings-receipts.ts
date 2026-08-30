import { createHash } from "node:crypto";
import {
  ProviderConnectionAttemptSchema,
  type ProviderConnectionAttempt,
  type ProviderDependencyCounts,
  type ProviderSettingsMutation,
} from "@matrix-os/contracts";

export function hashProviderSettingsMutation(mutation: ProviderSettingsMutation): string {
  return createHash("sha256").update(JSON.stringify(mutation)).digest("hex");
}

export function sameProviderDependencyCounts(
  left: ProviderDependencyCounts,
  right: ProviderDependencyCounts,
): boolean {
  return left.activeChatCount === right.activeChatCount
    && left.resumableChatCount === right.resumableChatCount
    && left.harnessInstanceCount === right.harnessInstanceCount;
}

export function currentProviderConnectionAttempt(
  value: unknown,
  now: Date,
): ProviderConnectionAttempt {
  const attempt = ProviderConnectionAttemptSchema.parse(value);
  if (Date.parse(attempt.expiresAt) > now.getTime() || attempt.state !== "pending") return attempt;
  return ProviderConnectionAttemptSchema.parse({
    ...attempt,
    state: "expired",
    action: { kind: "none" },
    safeFailure: "expired",
  });
}
