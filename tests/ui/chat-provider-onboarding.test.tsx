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
    snapshot.harnesses[0]!.localObservation = { state: "absent", checkedAt: new Date().toISOString(), staleAfter: new Date(Date.now() + 60_000).toISOString() };
    expect(deriveChatProviderConnectionState(snapshot)).toBe("disconnected");
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
    expect(screen.getByRole("button", { name: "Connect Codex" })).toBeDisabled();
  });
  it("keeps unknown state truthful with manual recovery", () => {
    const refresh = vi.fn(); render(<ChatProviderConnections snapshot={null} error="unsafe provider secret" onMutate={vi.fn()} onRefresh={refresh} onOpenAction={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Connect Claude Code" })).not.toBeInTheDocument();
    expect(screen.queryByText("unsafe provider secret")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check connection" })); expect(refresh).toHaveBeenCalledOnce();
  });
});
