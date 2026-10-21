import { createHash } from "node:crypto";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import type { ProviderSettingsStoreWriter } from "./provider-settings-store.js";
import { ProviderWorkflowError, ProviderWorkflowNotStartedError } from "./provider-workflows.js";

/** Foreground consent only. Observation alone must never select or enable an account. */
export function createClaudeNativeConnectCompletion(store: ProviderSettingsStoreWriter, harnessInstanceId: string) {
  async function read() {
    const snapshot = await store.getSnapshot({ refresh: true, includeNativeAccountMetadata: true, includeNativeAccountUsage: false });
    const harness = snapshot.harnesses.find(row => row.id === harnessInstanceId && row.harness === "claude");
    if (!harness || harness.installState !== "installed" || snapshot.access.mode !== "writable"
      || harness.route.kind !== "fixed" || harness.route.providerId !== "anthropic") {
      throw new ProviderWorkflowError("unavailable");
    }
    return { snapshot, harness };
  }

  function authenticated({ snapshot, harness }: Awaited<ReturnType<typeof read>>) {
    const source = snapshot.accessSources.find(row => row.id === "owner_claude_profile"
      && row.providerId === "anthropic" && row.kind === "provider_account" && row.fundingKind === "owner_account"
      && row.accountId === "owner_claude_profile");
    const account = snapshot.accounts.find(row => row.id === "owner_claude_profile"
      && row.providerId === "anthropic" && row.accessSourceId === source?.id
      && row.authMethod === "terminal" && row.authState === "authenticated");
    if (!source || !account) return false;
    if (!source.eligibleModelIds.includes(harness.route.modelId)) throw new ProviderWorkflowError("unavailable");
    return true;
  }

  async function commit(snapshot: ProviderSettingsSnapshot, idempotencyKey: string) {
    if (!store.completeClaudeNativeLogin) throw new ProviderWorkflowError("unavailable");
    // The store independently revalidates the current principal, writer, fixed
    // route, revision and replay inside mutation admission and before commit.
    // A rejection may follow a write: propagate it, never start another login.
    await store.completeClaudeNativeLogin({ harnessInstanceId, expectedRevision: snapshot.revision,
      idempotencyKey: `connect-${createHash("sha256").update(idempotencyKey).digest("hex")}` });
  }

  return {
    async tryAdopt(idempotencyKey: string, beforeCommit: () => void): Promise<boolean> {
      let current: Awaited<ReturnType<typeof read>>;
      try {
        current = await read();
        if (!authenticated(current)) return false;
      } catch (error) {
        // No write or child launch occurred. Keep ordinary no-resource retry and
        // conflict semantics instead of retaining a protected failed attempt.
        console.warn("[provider-workflow] Native account preflight unavailable:", error instanceof Error ? error.name : "UnknownError");
        throw new ProviderWorkflowNotStartedError();
      }
      beforeCommit();
      await commit(current.snapshot, idempotencyKey);
      return true;
    },
    async complete(idempotencyKey: string): Promise<void> {
      const current = await read();
      if (!authenticated(current)) throw new ProviderWorkflowError("unavailable");
      await commit(current.snapshot, idempotencyKey);
    },
  };
}
