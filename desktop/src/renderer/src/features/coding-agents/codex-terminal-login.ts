import { ProviderSettingsSnapshotSchema, ProviderWorkflowV2Schema, type ProviderWorkflowV2 } from "@matrix-os/contracts";
import { ProviderWorkflowClientError } from "@matrix-os/ui";
import type { ApiClient } from "../../lib/api";
import { desktopProviderIdentityKey } from "../../lib/provider-settings-identity";
import { useConnection } from "../../stores/connection";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../../stores/runtime-generation";
import { invalidateDesktopProviderCatalog } from "../chat/provider-catalog-invalidation";
import { createDesktopProviderSettingsTransport, openExistingProviderTerminalSession } from "../settings/provider-settings-desktop-adapter";
import { createDesktopProviderWorkflowClient } from "../settings/provider-workflow-transport";

// A single foreground Codex sign-in, bounded to ten minutes. Its observer belongs
// to the connection, so opening Terminal or closing Chat cannot drop completion.
type ActiveLogin = { identityKey: string; opened: Promise<boolean>; current: () => boolean; reopen?: () => Promise<boolean> };
let active: ActiveLogin | null = null;
// One nonsecret intent survives a lost start reply; replay its exact nonce if
// the server already completed and no longer advertises an active operation.
let pendingStart: { identityKey: string; harnessId: string; key: string; expiresAt: number } | null = null;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const visible = () => { if (document.visibilityState === "visible") finish(); };
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      window.removeEventListener("focus", finish);
      document.removeEventListener("visibilitychange", visible);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    // OAuth runs in another application. Chromium can throttle the timer while
    // Electron is occluded; foreground return must inspect the same receipt now.
    window.addEventListener("focus", finish, { once: true });
    document.addEventListener("visibilitychange", visible);
    if (signal.aborted) finish();
  });
}

/** Use the same canonical native consent/completion as Settings, with a Terminal UI. */
export function openCodexTerminalLogin(api: ApiClient): Promise<boolean> {
  const connection = useConnection.getState();
  if (connection.status !== "signed-in") return Promise.resolve(false);
  const identityKey = desktopProviderIdentityKey(connection);
  if (active?.identityKey === identityKey && active.current()) return active.reopen?.() ?? active.opened;
  if (pendingStart && (pendingStart.identityKey !== identityKey || pendingStart.expiresAt <= Date.now())) pendingStart = null;
  const generation = captureRuntimeGeneration();
  const controller = new AbortController();
  const { signal } = controller;
  const current = () => !signal.aborted && isCurrentRuntimeGeneration(generation)
    && desktopProviderIdentityKey(useConnection.getState()) === identityKey;
  const unsubscribe = useConnection.subscribe(() => { if (!current()) controller.abort(); });
  const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
  const runtimeApi = api.forRuntime(connection.runtimeSlot);
  const client = createDesktopProviderWorkflowClient(runtimeApi, current);
  const transport = createDesktopProviderSettingsTransport(runtimeApi);
  const entry: ActiveLogin = { identityKey, opened: Promise.resolve(false), current };
  active = entry;
  const release = () => {
    clearTimeout(timeout);
    controller.abort();
    unsubscribe();
    if (active === entry) active = null;
  };
  const report = (error: unknown) => {
    if (current()) console.warn("[provider-setup] Codex connection unavailable:", error instanceof Error ? error.name : "UnknownError");
  };
  entry.opened = (async () => {
    let observing = false;
    try {
      const [rawSnapshot, capabilities] = await Promise.all([
        transport.getSnapshot(signal, { refresh: false }), client.capabilities(signal),
      ]);
      const snapshot = ProviderSettingsSnapshotSchema.parse(rawSnapshot);
      if (!current() || snapshot.access.mode !== "writable") return false;
      const matches = capabilities.filter(row => row.harness === "codex" && row.installState === "installed"
        && row.loginMethods.includes("terminal") && snapshot.harnesses.some(h => h.id === row.harnessInstanceId && h.harness === "codex"));
      const capability = matches.length === 1 ? matches[0] : undefined;
      const option = capability?.connectionOptions?.find(item => item.id === "openai_terminal" && item.providerId === "openai"
        && item.authKind === "subscription" && item.billingKind === "subscription" && item.executionKind === "native"
        && item.method === "terminal" && item.availability === "available");
      if (!capability || !option || !client.startConnection) return false;
      if (!pendingStart || pendingStart.harnessId !== capability.harnessInstanceId) {
        pendingStart = { identityKey, harnessId: capability.harnessInstanceId, key: crypto.randomUUID(), expiresAt: Date.now() + 10 * 60_000 };
      }
      const started = ProviderWorkflowV2Schema.parse(capability.activeOperationId
        ? await client.get(capability.activeOperationId, signal)
        : await client.startConnection({ harnessInstanceId: capability.harnessInstanceId,
          optionId: option.id, idempotencyKey: pendingStart.key }, signal));
      if (capability.activeOperationId && started.id !== capability.activeOperationId) throw new Error("Connection scope mismatch");
      const accept = (value: ProviderWorkflowV2) => {
        if (value.id !== started.id || value.kind !== "login" || value.harnessInstanceId !== capability.harnessInstanceId
          || value.connectionOption?.id !== option.id || value.connectionOption.method !== "terminal"
          || value.connectionOption.providerId !== "openai" || value.connectionOption.authKind !== "subscription"
          || value.connectionOption.billingKind !== "subscription" || value.connectionOption.availability !== "available") {
          throw new Error("Connection scope mismatch");
        }
        return value;
      };
      let receipt = accept(started);
      if (!current()) return false;
      pendingStart = null;
      if (!["pending", "running", "succeeded"].includes(receipt.state)) return false;
      let handoff: Promise<boolean> | null = null;
      entry.reopen = () => {
        if (!current() || !receipt.terminalSessionId) return Promise.resolve(false);
        handoff ??= openExistingProviderTerminalSession(runtimeApi, receipt.terminalSessionId, current).finally(() => { handoff = null; });
        return handoff;
      };
      const opened = receipt.state === "succeeded" || await entry.reopen();
      const deadline = Math.min(Date.parse(receipt.expiresAt), Date.now() + 10 * 60_000);
      const observe = async () => {
        let failures = 0;
        while (current()) {
          if (receipt.state === "succeeded") {
            invalidateDesktopProviderCatalog(identityKey, undefined, snapshot, receipt);
            return;
          }
          if (!["pending", "running"].includes(receipt.state) || Date.now() >= deadline) return;
          await delay(Math.min(deadline - Date.now(), Math.min(10_000, 1000 * 2 ** Math.min(failures, 4))), signal);
          if (!current() || Date.now() >= deadline) return;
          try {
            receipt = accept(ProviderWorkflowV2Schema.parse(await client.get(receipt.id, signal)));
            failures = 0;
          } catch (error) {
            if (!(error instanceof ProviderWorkflowClientError) || error.reason !== "unavailable") throw error;
            failures += 1;
          }
        }
      };
      observing = true;
      void observe().catch(report).finally(release);
      return opened;
    } catch (error) {
      report(error);
      return false;
    } finally {
      if (!observing) release();
    }
  })();
  return entry.opened;
}
