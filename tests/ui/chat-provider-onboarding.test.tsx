// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatProviderConnections, ChatProviderOnboarding, deriveChatProviderConnectionState } from "../../packages/ui/src/agents-providers/ChatProviderConnections";
import { disconnectedSnapshot } from "./chat-provider-settings-fixture";
describe("Chat connection state", () => {
  it("requires confirmed disconnection", () => {
    expect(deriveChatProviderConnectionState(null)).toBe("checking");
    expect(deriveChatProviderConnectionState(disconnectedSnapshot())).toBe("disconnected");
    const snapshot = disconnectedSnapshot(); snapshot.harnesses[0]!.authState = "unknown";
    expect(deriveChatProviderConnectionState(snapshot)).toBe("unknown");
  });
  it("preserves any connected provider even when disabled or catalog unavailable", () => {
    const snapshot = disconnectedSnapshot(); snapshot.harnesses[0]!.harness = "pi"; snapshot.harnesses[0]!.authState = "authenticated";
    snapshot.harnesses[0]!.enabled = false; snapshot.harnesses[0]!.routeAvailability = "catalog_unavailable";
    expect(deriveChatProviderConnectionState(snapshot)).toBe("connected");
    expect(deriveChatProviderConnectionState(snapshot, true)).toBe("connected");
  });
  it.each(["present_unverified", "unknown"] as const)("never advertises disconnected from %s local login evidence", (state) => {
    const snapshot = disconnectedSnapshot(); snapshot.harnesses[0]!.localObservation = { state, checkedAt: "2026-01-01T00:00:00Z", staleAfter: "2026-01-01T00:10:00Z" };
    if (state === "unknown") snapshot.harnesses[0]!.authState = "unknown";
    expect(deriveChatProviderConnectionState(snapshot)).toBe("unknown");
  });
  it("shows login for authoritative explicit local absence", () => {
    const snapshot = disconnectedSnapshot(); snapshot.harnesses[0]!.authState = "unknown";
    snapshot.harnesses[0]!.localObservation = { state: "absent", checkedAt: snapshot.refreshedAt, staleAfter: new Date(Date.parse(snapshot.refreshedAt) + 60_000).toISOString() };
    expect(deriveChatProviderConnectionState(snapshot)).toBe("disconnected");
  });
  it.each([-581, 2_000, 60_000])("uses the authoritative server observation despite renderer clock offset %sms", (offset) => {
    const snapshot = disconnectedSnapshot();
    snapshot.refreshedAt = "2026-09-30T21:06:32.368Z";
    snapshot.harnesses[1]!.authState = "unknown";
    snapshot.harnesses[1]!.localObservation = {
      state: "absent", checkedAt: "2026-09-30T21:06:32.363Z", staleAfter: "2026-09-30T21:06:37.363Z",
    };
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(snapshot.refreshedAt) + offset);
    try { expect(deriveChatProviderConnectionState(snapshot)).toBe("disconnected"); }
    finally { clock.mockRestore(); }
  });
  it.each([
    { checkedAt: null, staleAfter: "2026-09-30T21:06:37.363Z", refreshedAt: "2026-09-30T21:06:32.368Z" },
    { checkedAt: "invalid", staleAfter: "2026-09-30T21:06:37.363Z", refreshedAt: "2026-09-30T21:06:32.368Z" },
    { checkedAt: "2026-09-30T21:06:32.363Z", staleAfter: null, refreshedAt: "2026-09-30T21:06:32.368Z" },
    { checkedAt: "2026-09-30T21:06:32.363Z", staleAfter: "invalid", refreshedAt: "2026-09-30T21:06:32.368Z" },
    { checkedAt: "2026-09-30T21:06:33.000Z", staleAfter: "2026-09-30T21:06:37.363Z", refreshedAt: "2026-09-30T21:06:32.368Z" },
    { checkedAt: "2026-09-30T21:06:32.363Z", staleAfter: "2026-09-30T21:06:37.363Z", refreshedAt: "2026-09-30T21:06:37.363Z" },
    { checkedAt: "2026-09-30T21:06:32.363Z", staleAfter: "2026-09-30T21:06:32.363Z", refreshedAt: "2026-09-30T21:06:32.368Z" },
    { checkedAt: "2026-09-30T21:06:32.363Z", staleAfter: "2026-09-30T21:06:37.363Z", refreshedAt: "invalid" },
  ])("keeps incoherent or expired server observation unknown: %j", (timing) => {
    const snapshot = disconnectedSnapshot(); snapshot.refreshedAt = timing.refreshedAt;
    snapshot.harnesses[1]!.authState = "unknown";
    snapshot.harnesses[1]!.localObservation = { state: "absent", checkedAt: timing.checkedAt, staleAfter: timing.staleAfter };
    expect(deriveChatProviderConnectionState(snapshot)).toBe("unknown");
  });
  it("does not call locally observed login remote authentication", () => {
    const snapshot = disconnectedSnapshot(); snapshot.harnesses[0]!.authState = "authenticated";
    snapshot.harnesses[0]!.localObservation = { state: "present_unverified", checkedAt: new Date().toISOString(), staleAfter: new Date(Date.now() + 60_000).toISOString() };
    expect(deriveChatProviderConnectionState(snapshot)).toBe("unknown");
  });
  it("does not turn a failed read into disconnection", () => {
    expect(deriveChatProviderConnectionState(disconnectedSnapshot(), true)).toBe("unavailable");
  });
  it("keeps unfunded Matrix AI connected", () => {
    const snapshot = disconnectedSnapshot(); snapshot.accessSources.push({ id: "matrix", kind: "matrix_gateway", fundingKind: "matrix_included", providerId: "anthropic", accountId: null, displayName: "Matrix AI", readiness: { state: "unavailable", checkedAt: new Date().toISOString(), staleAfter: null, action: "retry", safeReason: "credit_required" }, eligibleModelIds: [], usage: { kind: "unavailable", authority: "unavailable", state: "unavailable", scope: "owner_entitlement", reason: "ledger_not_available", asOf: null } });
    expect(deriveChatProviderConnectionState(snapshot)).toBe("connected");
  });
});
describe("Chat provider connection rows", () => {
  it("keeps a coherent observation stable across rerenders until a replacement snapshot arrives", () => {
    const snapshot = disconnectedSnapshot(); snapshot.refreshedAt = "2026-09-30T21:06:32.368Z";
    snapshot.harnesses[1]!.authState = "unknown";
    snapshot.harnesses[1]!.localObservation = { state: "absent", checkedAt: "2026-09-30T21:06:32.363Z", staleAfter: "2026-09-30T21:06:37.363Z" };
    const props = { onMutate: vi.fn(), onRefresh: vi.fn(), onOpenAction: vi.fn() };
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(snapshot.refreshedAt));
    try {
      const { rerender } = render(<ChatProviderConnections snapshot={snapshot} {...props}><div>Normal Chat suggestions</div></ChatProviderConnections>);
      expect(screen.getByRole("button", { name: "Connect Claude Code" })).toBeEnabled();
      clock.mockReturnValue(Date.parse("2026-10-02T00:00:00Z"));
      rerender(<ChatProviderConnections snapshot={snapshot} busy {...props}><div>Normal Chat suggestions</div></ChatProviderConnections>);
      expect(screen.getByRole("button", { name: "Connect Claude Code" })).toBeDisabled();
      expect(screen.queryByText("Normal Chat suggestions")).not.toBeInTheDocument();
      const staleSnapshot = { ...snapshot, revision: 2, refreshedAt: "2026-09-30T21:06:37.363Z" };
      rerender(<ChatProviderConnections snapshot={staleSnapshot} {...props}><div>Normal Chat suggestions</div></ChatProviderConnections>);
      expect(screen.getByText("Normal Chat suggestions")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Connect Codex" })).not.toBeInTheDocument();
      const connectedSnapshot = { ...staleSnapshot, revision: 3, harnesses: staleSnapshot.harnesses.map((harness, index) => index === 0 ? { ...harness, authState: "authenticated" as const } : harness) };
      rerender(<ChatProviderConnections snapshot={connectedSnapshot} {...props}><div>Normal Chat suggestions</div></ChatProviderConnections>);
      expect(deriveChatProviderConnectionState(connectedSnapshot)).toBe("connected");
      expect(screen.queryByRole("region", { name: "Chat provider connection" })).not.toBeInTheDocument();
    } finally { clock.mockRestore(); }
  });
  it("offers a compact manual retry after an initial read failure without replacing normal Chat", async () => {
    let release!: (value: ReturnType<typeof disconnectedSnapshot>) => void;
    const getSnapshot = vi.fn().mockRejectedValueOnce(new Error("private read failure"))
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    render(<ChatProviderOnboarding identityKey="initial-failure" transport={{ getSnapshot, mutate: vi.fn() }}
      isIdentityCurrent={() => true} openAction={() => true}>
      <div>Normal Chat suggestions<textarea aria-label="Draft" /></div>
    </ChatProviderOnboarding>);
    const retry = await screen.findByRole("button", { name: "Check connection" });
    await waitFor(() => expect(retry).toBeEnabled());
    expect(screen.getByText("Normal Chat suggestions")).toBeVisible();
    expect(screen.getByRole("region", { name: "Chat connection recovery" })).toHaveClass("matrix-chat-connection-recovery");
    expect(screen.queryByRole("region", { name: "Chat provider connection" })).not.toBeInTheDocument();
    expect(screen.queryByText("Connection status unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("private read failure")).not.toBeInTheDocument();
    const draft = screen.getByRole("textbox", { name: "Draft" });
    fireEvent.change(draft, { target: { value: "Retain this prompt" } });
    fireEvent.click(retry);
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2));
    expect(retry).toBeDisabled();
    fireEvent.click(retry); expect(getSnapshot).toHaveBeenCalledTimes(2);
    const snapshot = disconnectedSnapshot(); snapshot.harnesses[0]!.authState = "authenticated";
    await act(async () => release(snapshot));
    expect(screen.queryByRole("region", { name: "Chat connection recovery" })).not.toBeInTheDocument();
    expect(screen.getByText("Normal Chat suggestions")).toBeVisible();
    expect(draft).toHaveValue("Retain this prompt");
  });
  it("never shows recovery or login controls for connected evidence even after an error", () => {
    const snapshot = disconnectedSnapshot(); snapshot.harnesses[0]!.authState = "authenticated";
    render(<ChatProviderConnections snapshot={snapshot} error="unsafe error" onMutate={vi.fn()} onRefresh={vi.fn()} onOpenAction={vi.fn()}>
      <div>Normal Chat suggestions</div>
    </ChatProviderConnections>);
    expect(screen.getByText("Normal Chat suggestions")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Check connection" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Chat provider connection" })).not.toBeInTheDocument();
  });
  it("retains normal Chat after a failed refresh of previously connected settings", async () => {
    const snapshot = disconnectedSnapshot(); snapshot.harnesses[0]!.authState = "authenticated";
    const getSnapshot = vi.fn().mockResolvedValueOnce(snapshot).mockRejectedValue(new Error("private read failure"));
    render(<ChatProviderOnboarding identityKey="connected" transport={{ getSnapshot, mutate: vi.fn() }}
      isIdentityCurrent={() => true} openAction={() => true}><div>Normal Chat suggestions</div></ChatProviderOnboarding>);
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Normal Chat suggestions")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Chat provider connection" })).not.toBeInTheDocument();
    expect(screen.queryByText("Connection status unavailable")).not.toBeInTheDocument();
  });
  it("retains a disconnected login handoff and safe recovery alongside normal Chat after an action failure", () => {
    const open = vi.fn(); const refresh = vi.fn();
    const attempt = { id: "attempt", harnessInstanceId: "claude_default", accountId: null, method: "terminal" as const, state: "pending" as const,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), action: { kind: "open_terminal" as const, terminalSessionId: "claude-login" }, safeFailure: null };
    render(<ChatProviderConnections snapshot={disconnectedSnapshot()} attempt={attempt} error="unsafe action failure"
      onMutate={vi.fn()} onRefresh={refresh} onOpenAction={open}><div>Normal Chat suggestions</div></ChatProviderConnections>);
    expect(screen.getByText("Normal Chat suggestions")).toBeVisible();
    expect(screen.getByRole("region", { name: "Chat connection recovery" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Continue in Terminal" }));
    expect(open).toHaveBeenCalledWith(attempt.action);
    fireEvent.click(screen.getByRole("button", { name: "Check connection" })); expect(refresh).toHaveBeenCalledOnce();
    expect(screen.queryByText("unsafe action failure")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Claude Code" })).not.toBeInTheDocument();
  });
  it.each(["checking", "unknown", "unavailable", "connected", "connected_refresh_failed"])("preserves normal Chat for %s without a connection overlay", (state) => {
    const snapshot = state === "checking" || state === "unavailable" ? null : disconnectedSnapshot();
    if (snapshot) snapshot.harnesses[0]!.authState = state.startsWith("connected") ? "authenticated" : "unknown";
    const failed = state === "unavailable" || state === "connected_refresh_failed";
    render(<ChatProviderConnections snapshot={snapshot} error={failed ? "unsafe provider secret" : null}
      onMutate={vi.fn()} onRefresh={vi.fn()} onOpenAction={vi.fn()}><div>Normal Chat suggestions</div></ChatProviderConnections>);
    expect(screen.getByText("Normal Chat suggestions")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Chat provider connection" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Claude Code" })).not.toBeInTheDocument();
    expect(screen.queryByText("Connection status unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("Checking connections…")).not.toBeInTheDocument();
    expect(screen.queryByText("unsafe provider secret")).not.toBeInTheDocument();
  });
  it("preserves normal Chat for unverified local login without changing connection evidence", () => {
    const snapshot = disconnectedSnapshot();
    snapshot.harnesses[0]!.authState = "authenticated";
    snapshot.harnesses[0]!.localObservation = { state: "present_unverified", checkedAt: new Date().toISOString(), staleAfter: new Date(Date.now() + 60_000).toISOString() };
    render(<ChatProviderConnections snapshot={snapshot} onMutate={vi.fn()} onRefresh={vi.fn()} onOpenAction={vi.fn()}><div>Normal Chat suggestions</div></ChatProviderConnections>);
    expect(deriveChatProviderConnectionState(snapshot)).toBe("unknown");
    expect(screen.getByText("Normal Chat suggestions")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Chat provider connection" })).not.toBeInTheDocument();
  });
  it("does not echo external invalidation between two mounted Chat panels", async () => {
    const event = "test-provider-settings-changed";
    const snapshot = disconnectedSnapshot();
    const pending: Array<() => void> = [];
    const first = vi.fn(async () => first.mock.calls.length === 1 ? snapshot : await new Promise((resolve) => pending.push(() => resolve(snapshot))));
    const second = vi.fn(async () => second.mock.calls.length === 1 ? snapshot : await new Promise((resolve) => pending.push(() => resolve(snapshot))));
    const changed = vi.fn(() => window.dispatchEvent(new Event(event)));
    const current = () => true;
    const firstTransport = { getSnapshot: first, mutate: vi.fn() };
    const secondTransport = { getSnapshot: second, mutate: vi.fn() };
    const { getByTestId } = render(<><div data-testid="first"><ChatProviderOnboarding identityKey="first" transport={firstTransport} isIdentityCurrent={current} openAction={() => true} onCatalogChanged={changed} changedEvent={event} /></div><div data-testid="second"><ChatProviderOnboarding identityKey="second" transport={secondTransport} isIdentityCurrent={current} openAction={() => true} onCatalogChanged={changed} changedEvent={event} /></div></>);
    await waitFor(() => expect(within(getByTestId("first")).getByRole("button", { name: "Check connection" })).toBeEnabled());
    fireEvent.click(within(getByTestId("first")).getByRole("button", { name: "Check connection" }));
    await act(async () => pending.shift()!());
    await waitFor(() => expect(second).toHaveBeenCalledTimes(2));
    await act(async () => pending.shift()!());
    expect(changed).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
  });
  it("ignores legacy Codex login advertisements and retained handoffs", () => {
    const mutate = vi.fn(); const open = vi.fn();
    const snapshot = disconnectedSnapshot();
    const attempt = { id: "old-codex", harnessInstanceId: "codex_default", accountId: null, method: "terminal" as const, state: "pending" as const,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), action: { kind: "open_terminal" as const, terminalSessionId: "codex-login" }, safeFailure: null };
    render(<ChatProviderConnections snapshot={snapshot} attempt={attempt} onMutate={mutate} onRefresh={vi.fn()} onOpenAction={open} />);
    expect(screen.queryByRole("button", { name: "Connect Codex" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Sign in to Claude Code or Codex/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue in Terminal" })).not.toBeInTheDocument();
    expect(screen.queryByText("Finish signing in")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect Claude Code" }));
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ harnessInstanceId: "claude_default" }));
    expect(open).not.toHaveBeenCalled();
  });
  it("does not reopen an orphaned cached login handoff during a failed read", () => {
    const attempt = { id: "orphan", harnessInstanceId: "codex_default", accountId: null, method: "terminal" as const, state: "pending" as const,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), action: { kind: "open_terminal" as const, terminalSessionId: "codex-login" }, safeFailure: null };
    render(<ChatProviderConnections snapshot={null} attempt={attempt} error="Connection unavailable" onMutate={vi.fn()} onRefresh={vi.fn()} onOpenAction={vi.fn()}><div>Normal Chat suggestions</div></ChatProviderConnections>);
    expect(screen.getByText("Normal Chat suggestions")).toBeVisible();
    expect(screen.getByRole("button", { name: "Check connection" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Continue in Terminal" })).not.toBeInTheDocument();
    expect(screen.queryByText("Finish signing in")).not.toBeInTheDocument();
  });
  it("uses advertised login and displays only a confirmed disconnected panel", () => {
    const mutate = vi.fn(); const snapshot = disconnectedSnapshot();
    const { rerender } = render(<ChatProviderConnections snapshot={snapshot} onMutate={mutate} onRefresh={vi.fn()} onOpenAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Claude Code" }));
    expect(mutate).toHaveBeenCalledWith({ type: "start_login", harnessInstanceId: "claude_default", accountId: null, method: "terminal" });
    snapshot.harnesses[0]!.authState = "authenticated";
    rerender(<ChatProviderConnections snapshot={snapshot} onMutate={mutate} onRefresh={vi.fn()} onOpenAction={vi.fn()} />);
    expect(screen.queryByText("Connect a coding agent")).not.toBeInTheDocument();
  });
  it("reuses the selected account and does not invent unsupported login methods", () => {
    const mutate = vi.fn(); const snapshot = disconnectedSnapshot();
    snapshot.harnesses[0]!.selectedAccountId = "existing_account";
    snapshot.harnesses[1]!.loginMethods = []; snapshot.harnesses[1]!.recommendedLoginMethod = null;
    render(<ChatProviderConnections snapshot={snapshot} onMutate={mutate} onRefresh={vi.fn()} onOpenAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Claude Code" }));
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ accountId: "existing_account" }));
    expect(screen.queryByRole("button", { name: "Connect Codex" })).not.toBeInTheDocument();
  });
  it("keeps failed disconnected actions recoverable alongside normal Chat", () => {
    const refresh = vi.fn(); render(<ChatProviderConnections snapshot={disconnectedSnapshot()} error="unsafe provider secret" onMutate={vi.fn()} onRefresh={refresh} onOpenAction={vi.fn()}><div>Normal Chat suggestions</div></ChatProviderConnections>);
    expect(screen.getByText("Normal Chat suggestions")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("The connection could not be checked or updated");
    expect(screen.queryByRole("heading", { name: "Connection status unavailable" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Claude Code" })).not.toBeInTheDocument();
    expect(screen.queryByText("unsafe provider secret")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check connection" })); expect(refresh).toHaveBeenCalledOnce();
  });
});


it("reconciles app-owned background observations without forcing probes or echoing catalog invalidation", async () => {
  const getSnapshot = vi.fn().mockResolvedValue(disconnectedSnapshot());
  const changed = vi.fn();
  const props = { identityKey: "desktop_owner", transport: { getSnapshot, mutate: vi.fn() },
    isIdentityCurrent: () => true, openAction: () => true, lifecycleRefresh: false, onCatalogChanged: changed };
  const view = render(<ChatProviderOnboarding {...props} backgroundRefreshKey={1} />);
  await waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());
  view.rerender(<ChatProviderOnboarding {...props} backgroundRefreshKey={2} />);
  await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2));
  expect(getSnapshot).toHaveBeenLastCalledWith(expect.any(AbortSignal), { refresh: false });
  expect(changed).not.toHaveBeenCalled();
  act(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  expect(getSnapshot).toHaveBeenCalledTimes(2);
});
