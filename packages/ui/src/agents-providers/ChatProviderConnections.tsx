import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ProviderConnectionAttempt, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { HarnessIcon } from "./HarnessRail.js";
import { useProviderSettingsController, type ProviderSettingsTransport, type ProviderSettingsControllerOptions, ProviderSettingsTransportError } from "./provider-settings-controller.js";
import type { ProviderSettingsMutationIntent } from "./types.js";

export type ChatProviderConnectionState = "connected" | "disconnected" | "checking" | "unknown" | "unavailable";
/** Connection evidence is independent of enabled routes, model availability and funding. */
export function deriveChatProviderConnectionState(snapshot: ProviderSettingsSnapshot | null, failed = false): ChatProviderConnectionState {
  const sourceForAccount = (id: string) => snapshot?.accessSources.find((source) => source.id === id);
  const isUnverified = (observation: { state: string } | undefined) => observation !== undefined;
  const sourceForHarness = (harness: NonNullable<typeof snapshot>["harnesses"][number]) =>
    snapshot?.accessSources.find((source) => source.id === (harness.accessSourceId ?? harness.configuredAccessSourceId));
  if (snapshot?.accounts.some((account) => account.authState === "authenticated"
      && !isUnverified(sourceForAccount(account.accessSourceId)?.localObservation))
    || snapshot?.harnesses.some((harness) => harness.authState === "authenticated"
      && !isUnverified(harness.localObservation)
      && !isUnverified(sourceForHarness(harness)?.localObservation))
    || snapshot?.accessSources.some((source) => (source.readiness.state === "ready" && !isUnverified(source.localObservation))
      || (source.kind === "matrix_gateway" && source.readiness.safeReason === "credit_required"))) return "connected";
  if (failed) return "unavailable";
  if (!snapshot) return "checking";
  // Compare observations within one server snapshot: renderer clock skew and
  // later rerenders cannot reclassify evidence before a replacement read.
  const refreshedAt = Date.parse(snapshot.refreshedAt);
  const freshAbsent = (observation: { state: string; checkedAt: string | null; staleAfter: string | null } | undefined) => {
    const checkedAt = Date.parse(observation?.checkedAt ?? "");
    const staleAfter = Date.parse(observation?.staleAfter ?? "");
    return observation?.state === "absent" && Number.isFinite(refreshedAt)
      && Number.isFinite(checkedAt) && Number.isFinite(staleAfter)
      && checkedAt <= refreshedAt && refreshedAt < staleAfter;
  };
  const unselectedDiscovery = (source: NonNullable<typeof snapshot>["accessSources"][number]) =>
    source.kind === "harness_profile" && source.readiness.state === "unknown" && source.localObservation?.state === "unknown"
      && !snapshot.harnesses.some((harness) => harness.accessSourceId === source.id || harness.configuredAccessSourceId === source.id);
  // Local CLI login never proves remote authentication; only fresh explicit
  // absence can contribute negative connection evidence.
  if (snapshot.accounts.some((account) => account.authState === "unknown"
        && !freshAbsent(sourceForAccount(account.accessSourceId)?.localObservation))
    || snapshot.harnesses.some((harness) => harness.installState !== "missing"
      && ((harness.authState === "unknown" && !freshAbsent(harness.localObservation ?? sourceForHarness(harness)?.localObservation))
        || (harness.localObservation !== undefined && !freshAbsent(harness.localObservation))))
    || snapshot.accessSources.some((source) => !unselectedDiscovery(source) && ((source.localObservation !== undefined && !freshAbsent(source.localObservation))
      || (["unknown", "stale", "unavailable"].includes(source.readiness.state) && !freshAbsent(source.localObservation))))) return "unknown";
  return "disconnected";
}

export function ChatProviderConnections({ snapshot, busy = false, error, attempt, onMutate, onRefresh, onOpenAction, children }: {
  snapshot: ProviderSettingsSnapshot | null;
  busy?: boolean;
  error?: string | null;
  attempt?: ProviderConnectionAttempt | null;
  onMutate: (intent: ProviderSettingsMutationIntent) => unknown;
  onRefresh: () => void;
  onOpenAction: (action: ProviderConnectionAttempt["action"]) => void;
  children?: ReactNode;
}) {
  const state = deriveChatProviderConnectionState(snapshot, Boolean(error));
  if (state === "connected") return <>{children}</>;
  const disconnected = state === "disconnected";
  const allowedAttempt = attempt && snapshot?.harnesses.some((harness) =>
    harness.id === attempt.harnessInstanceId && harness.harness === "claude") ? attempt : null;
  // Settings reads are advisory to this empty-state presentation. Unknown or
  // failed evidence must not replace normal Chat or change catalog admission.
  const recovery = <>
    {allowedAttempt ? <div role="status" className="matrix-chat-provider-attempt">
      <span>{allowedAttempt.state === "pending" || allowedAttempt.state === "authorized" ? "Finish signing in" : "Sign-in needs attention"}</span>
      {allowedAttempt.action.kind === "open_terminal" || allowedAttempt.action.kind === "open_browser" ? <button type="button" disabled={busy}
        onClick={() => onOpenAction(allowedAttempt.action)}>Continue in {allowedAttempt.action.kind === "open_terminal" ? "Terminal" : "browser"}</button> : null}
    </div> : null}
    {error ? <p role="alert">The connection could not be checked or updated. Try again.</p> : null}
    <button type="button" disabled={busy} onClick={onRefresh}>Check connection</button>
  </>;
  if (!disconnected) {
    const retainRecovery = Boolean(allowedAttempt || error);
    return <>{children}{retainRecovery ? <section aria-label="Chat connection recovery" className="matrix-chat-provider-connections matrix-chat-connection-recovery" aria-busy={busy || undefined}>{recovery}</section> : null}</>;
  }
  const canLogin = snapshot?.access.mode === "writable" && snapshot.supportedActions.includes("start_login");
  return <section aria-label="Chat provider connection" className="matrix-chat-provider-connections" aria-busy={busy || undefined}>
    <h2>Connect a coding agent</h2>
    <p>Sign in to Claude Code to start chatting. Configure API key connections in Agents & providers.</p>
    <div className="matrix-chat-provider-rows">{(["claude"] as const).map((kind) => {
      const label = "Claude Code";
      const harness = snapshot?.harnesses.find((candidate) => candidate.harness === kind
        && candidate.loginMethods.length > 0) ?? snapshot?.harnesses.find((candidate) => candidate.harness === kind);
      const recommended = harness?.recommendedLoginMethod;
      const method = recommended && harness?.loginMethods.includes(recommended) ? recommended : null;
      const accountId = harness?.selectedAccountId ?? snapshot?.accounts.find((account) =>
        harness?.accountIds.includes(account.id) && account.authMethod === method)?.id ?? null;
      const signingIn = harness?.authState === "authenticating";
      return <div key={kind} className="matrix-chat-provider-row">
        <HarnessIcon harness={kind} /><strong>{label}</strong>
        {!method ? <span className="matrix-ap-help">Unavailable on this computer</span> : signingIn ? <span role="status">Signing in…</span> : null}
        <button type="button" disabled={busy || signingIn || !canLogin || !harness || !method}
          onClick={() => { if (harness && method) onMutate({ type: "start_login", harnessInstanceId: harness.id, accountId, method }); }}>
          Connect {label}
        </button>
      </div>;
    })}</div>
    {recovery}
  </section>;
}

/** Reuses Settings' validated attempts and revisions; refreshes reads, never authentication mutations. */
export function ChatProviderOnboarding({ identityKey, transport, onCatalogChanged, isIdentityCurrent, openAction, changedEvent, lifecycleRefresh = true, backgroundRefreshKey, children }: {
  identityKey: string;
  transport: ProviderSettingsTransport;
  onCatalogChanged?: ProviderSettingsControllerOptions["onCatalogChanged"];
  isIdentityCurrent: () => boolean;
  openAction: (action: ProviderConnectionAttempt["action"]) => boolean | Promise<boolean>;
  changedEvent?: string;
  /** Electron owns refresh at application scope; Web retains foreground probes. */
  lifecycleRefresh?: boolean;
  /** Accepted app-level catalog observation; inspect metadata without invalidating again. */
  backgroundRefreshKey?: number | null;
  children?: ReactNode;
}) {
  const scopedTransport = useMemo<ProviderSettingsTransport>(() => ({
    async getSnapshot(signal, options) {
      if (!isIdentityCurrent()) throw new ProviderSettingsTransportError("unavailable");
      const value = await transport.getSnapshot(signal, options);
      if (!isIdentityCurrent()) throw new ProviderSettingsTransportError("unavailable");
      return value;
    },
    async mutate(mutation, signal) {
      if (!isIdentityCurrent()) throw new ProviderSettingsTransportError("unavailable");
      const value = await transport.mutate(mutation, signal);
      if (!isIdentityCurrent()) throw new ProviderSettingsTransportError("unavailable");
      return value;
    },
  }), [transport, isIdentityCurrent]);
  const options = useMemo(() => ({ identityKey, transport: scopedTransport, onCatalogChanged }), [identityKey, scopedTransport, onCatalogChanged]);
  const controller = useProviderSettingsController(options);
  const refreshSettings = controller.refresh;
  const refreshing = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const refresh = useCallback(async (probe = true) => {
    if (refreshing.current || !isIdentityCurrent()) return;
    refreshing.current = true;
    setActionError(null);
    try { await refreshSettings({ refresh: probe }); } finally { refreshing.current = false; }
  }, [refreshSettings, isIdentityCurrent]);
  useEffect(() => {
    const focus = () => { void refresh(); };
    const visibility = () => { if (document.visibilityState === "visible") focus(); };
    if (lifecycleRefresh) {
      window.addEventListener("focus", focus);
      document.addEventListener("visibilitychange", visibility);
    }
    // The originating surface already invalidated the catalog. Re-emitting
    // that event after a read makes multiple mounted Chat panels ping-pong.
    const changed = () => { void refresh(false); };
    if (changedEvent) window.addEventListener(changedEvent, changed);
    return () => {
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
      if (changedEvent) window.removeEventListener(changedEvent, changed);
    };
  }, [refresh, changedEvent, lifecycleRefresh]);
  const previousBackgroundRefresh = useRef(backgroundRefreshKey);
  useEffect(() => {
    if (previousBackgroundRefresh.current === backgroundRefreshKey) return;
    previousBackgroundRefresh.current = backgroundRefreshKey;
    if (backgroundRefreshKey != null) void refresh(false);
  }, [backgroundRefreshKey, refresh]);
  const acceptAction = async (action: ProviderConnectionAttempt["action"]) => {
    if (!isIdentityCurrent()) return;
    setActionError(null);
    if (!await openAction(action)) throw new Error("Connection action unavailable");
  };
  return <ChatProviderConnections snapshot={controller.snapshot} busy={controller.busy} error={controller.error ?? actionError}
    attempt={controller.connectionAttempt} onRefresh={() => void refresh()}
    onOpenAction={(action) => {
      // Route continuation through the same safe controller action failure UI.
      void acceptAction(action).catch((error: unknown) => {
        console.warn("[chat] Connection continuation unavailable:", error instanceof Error ? error.name : typeof error);
        if (isIdentityCurrent()) setActionError("Connection action unavailable");
      });
    }}
    onMutate={(intent) => isIdentityCurrent() && controller.mutate(intent, { onLoginAction: acceptAction })}>
    {children}
  </ChatProviderConnections>;
}
