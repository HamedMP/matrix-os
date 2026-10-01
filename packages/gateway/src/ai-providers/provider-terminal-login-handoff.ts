import { TerminalRefSchema, type TerminalRef, type ProviderConnectionAttempt } from "@matrix-os/contracts";
import {
  ProviderSettingsStoreError,
  type ProviderSettingsStoreWriter,
} from "./provider-settings-store.js";

/** Project outward responses after persisted mutation replay, leaving internal login receipts untouched. */
export function createProviderTerminalLoginHandoff(
  store: ProviderSettingsStoreWriter,
  resolveTerminalRef: (identity: string) => Promise<TerminalRef>,
  resolveAttemptIdentity?: (attempt: ProviderConnectionAttempt) => Promise<string>,
): ProviderSettingsStoreWriter {
  if (!store || typeof store.getSnapshot !== "function" || typeof store.mutate !== "function") {
    throw new Error("Provider settings store is required");
  }
  if (typeof resolveTerminalRef !== "function") {
    throw new Error("Provider terminal resolver is required");
  }
  if (resolveAttemptIdentity !== undefined && typeof resolveAttemptIdentity !== "function") {
    throw new Error("Provider login attempt resolver is required");
  }
  return {
    getSnapshot: (options) => store.getSnapshot(options),
    async mutate(mutation) {
      const result = await store.mutate(mutation);
      if (result.kind !== "login_attempt" || result.attempt.action.kind !== "open_terminal") return result;
      const identity = resolveAttemptIdentity ? await resolveAttemptIdentity(result.attempt) : result.attempt.action.terminalSessionId;
      const ref = TerminalRefSchema.safeParse(await resolveTerminalRef(identity));
      if (!ref.success) throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
      return {
        ...result,
        attempt: {
          ...result.attempt,
          action: { kind: "open_terminal", terminalSessionId: `${ref.data.workspaceId}:${ref.data.tabId}` },
        },
      };
    },
  };
}
