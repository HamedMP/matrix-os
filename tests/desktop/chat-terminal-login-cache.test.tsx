// @vitest-environment jsdom
import React, { useState } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CanonicalProviderCatalogSchema, ProviderWorkflowV2Schema, type AgentProviderSummary } from "@matrix-os/contracts";
import { useProviderSetup } from "../../desktop/src/renderer/src/features/chat/use-provider-setup";
import { useChatProviderCatalog } from "../../desktop/src/renderer/src/features/chat/chat-provider-catalog";
import { startDesktopProviderCatalogCoordinator, stopDesktopProviderCatalogCoordinator } from "../../desktop/src/renderer/src/features/chat/provider-catalog-coordinator";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useShellSessions } from "../../desktop/src/renderer/src/stores/shell-sessions";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import { disconnectedSnapshot } from "../ui/chat-provider-settings-fixture";

const workspaceId = `tws_${"a".repeat(32)}`;
const tabId = `tt_${"b".repeat(32)}`;
const terminalRef = `${workspaceId}:${tabId}`;
const root = "/api/ai/provider-settings/workflows";
const option = { id: "openai_terminal", providerId: "openai", authKind: "subscription", method: "terminal",
  billingKind: "subscription", executionKind: "native", availability: "available" } as const;
const receipt = ProviderWorkflowV2Schema.parse({ id: "chat_codex_login", harnessInstanceId: "codex_default", kind: "login", state: "running",
  expiresAt: "2099-01-01T00:00:00.000Z", terminalSessionId: terminalRef, deviceCode: null, authorizationUrl: null,
  safeFailure: null, connectionOption: option });
const seed = createCanonicalProviderCatalogFixture();
const ready = CanonicalProviderCatalogSchema.parse({ ...seed,
  drivers: [...seed.drivers, { ...seed.drivers[0], kind: "claude_code" }],
  instances: [seed.instances[0], { ...seed.instances[0], id: "sibling_claude", driverKind: "claude_code",
    defaultSelection: { ...seed.instances[0]!.defaultSelection, instanceId: "sibling_claude" } }],
});
const { defaultSelection: _default, ...codex } = ready.instances[0]!;
const signedOut = CanonicalProviderCatalogSchema.parse({ ...ready, instances: [{ ...codex, availability: "unavailable", models: [],
  setupActions: [{ id: "codex_connect", kind: "foreground_terminal", label: "Connect Codex", command: "codex login --device-auth" }] }, ready.instances[1]] });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  useConnection.setState(useConnection.getInitialState(), true);
  stopDesktopProviderCatalogCoordinator();
  vi.restoreAllMocks();
});

async function boundary(input: { start?: typeof receipt; terminalAvailable?: boolean; summary?: boolean; handoffFailure?: boolean;
  lostStart?: "active" | "completed"; resumeId?: string } = {}) {
  const completion = deferred<unknown>();
  const snapshot = disconnectedSnapshot();
  let completed = false;
  let listReads = 0, operationReads = 0, started = false;
  const catalogPaths: string[] = [];
  const get = vi.fn(async (path: string) => {
    if (path.startsWith("/api/chat-providers?")) { catalogPaths.push(path); return completed ? ready : signedOut; }
    if (path.startsWith("/api/ai/provider-settings?")) return snapshot;
    if (path === `${root}/v2/capabilities`) return [{ harnessInstanceId: "codex_default", harness: "codex", displayName: "Codex",
      installState: "installed", loginMethods: ["terminal"], apiKeyProviders: [], install: false, uninstall: false, logs: false,
      connectionOptions: input.terminalAvailable === false ? [] : [option],
      ...(input.resumeId ? { activeOperationId: input.resumeId } : started && input.lostStart === "active" ? { activeOperationId: receipt.id } : {}) }];
    if (path === `${root}/v2/${receipt.id}` || input.resumeId && path === `${root}/v2/${input.resumeId}`) {
      if (input.lostStart === "active" && ++operationReads === 1) return receipt;
      const value = ProviderWorkflowV2Schema.parse(await completion.promise);
      completed = value.state === "succeeded";
      return value;
    }
    if (path === "/api/terminal/workspaces") {
      if (++listReads === 1 && input.handoffFailure) throw new Error("Synthetic transient handoff failure");
      return { workspaces: [{ id: workspaceId, revision: 1,
        tabs: [{ id: tabId, name: "Connect Codex", cwd: "projects", status: "active", revision: 1 }] }] };
    }
    throw new Error(`Unexpected synthetic GET ${path}`);
  });
  const post = vi.fn(async (path: string) => {
    if (path === `${root}/v2/start`) {
      if (input.lostStart && !started) { started = true; completed = input.lostStart === "completed"; throw new Error("Synthetic lost start response after commit"); }
      return input.lostStart === "completed" ? { ...receipt, state: "succeeded" } : input.start ?? receipt;
    }
    // The old path must reach the regression assertion, rather than fail fixture setup.
    if (path.endsWith("/ensure")) return { workspace: { id: workspaceId } };
    if (path.endsWith("/tabs")) return { tab: { id: tabId } };
    throw new Error(`Unexpected synthetic POST ${path}`);
  });
  const api = { get, post, forRuntime: vi.fn() } as unknown as ApiClient;
  vi.mocked(api.forRuntime).mockReturnValue(api);
  useConnection.setState({ status: "signed-in", handle: "fixture_computer", userId: "fixture_owner", platformHost: "https://fixture.invalid",
    runtimeSlot: "dev", authGeneration: 7, api });
  useTabs.setState(useTabs.getInitialState(), true);
  useShellSessions.setState(useShellSessions.getInitialState(), true);
  startDesktopProviderCatalogCoordinator();
  const chat = renderHook(() => useChatProviderCatalog(ready));
  await waitFor(() => expect(chat.result.current.hasTrustedCatalog).toBe(true));
  function ChatConnect() {
    const providers: AgentProviderSummary[] = input.summary ? [{ id: "codex", kind: "codex", displayName: "Codex", availability: "auth_required",
      installStatus: "installed", authStatus: "unauthenticated", supportedModes: ["default"], defaultMode: "default",
      setupActions: signedOut.instances[0]!.setupActions }] : [];
    const setup = useProviderSetup(providers, undefined, api);
    const [draft, setDraft] = useState("Keep this draft after sign in");
    return <><textarea aria-label="Draft" value={draft} onChange={event => setDraft(event.target.value)} />
      <button onClick={() => void setup(signedOut.instances[0]!, signedOut.instances[0]!.setupActions[0]!)}>Connect Codex</button></>;
  }
  const connect = render(<ChatConnect />);
  fireEvent.click(screen.getByRole("button", { name: "Connect Codex" }));
  return { api, get, post, chat, connect, completion, catalogPaths };
}

// Detects the reported fault: Chat's real action opens an unobserved shell command,
// rather than the canonical native-login producer whose success invalidates Chat.
it("keeps Chat and its draft while Terminal login success immediately exposes Codex models", async () => {
  const b = await boundary();
  await waitFor(() => expect(b.post).toHaveBeenCalledWith(`${root}/v2/start`, expect.objectContaining({
    harnessInstanceId: "codex_default", optionId: "openai_terminal",
  }), expect.anything()));
  await waitFor(() => expect(useTabs.getState().terminalSessionRequest?.sessionName).toBe(terminalRef));
  expect(b.chat.result.current.catalog.instances[0]!.models).toEqual([]);
  expect(b.catalogPaths).toHaveLength(1);
  await act(async () => b.completion.resolve({ ...receipt, state: "succeeded" }));
  await waitFor(() => expect(b.chat.result.current.catalog.instances[0]!.models).toEqual(ready.instances[0]!.models), { timeout: 2500 });
  expect(useConnection.getState().providerCatalogAffectedInstanceIds).toEqual([codex.id]);
  expect(b.chat.result.current.catalog.instances[1]!.availability).toBe("available");
  expect((screen.getByRole("textbox", { name: "Draft" }) as HTMLTextAreaElement).value).toBe("Keep this draft after sign in");
  expect(b.catalogPaths).toHaveLength(2);
  expect(b.catalogPaths.every(path => !path.includes("refresh=true"))).toBe(true);
  expect(b.post.mock.calls.some(([path]) => path.includes("/terminal/workspaces"))).toBe(false);
});

async function polling(b: Awaited<ReturnType<typeof boundary>>) {
  await waitFor(() => expect(b.get.mock.calls.some(([path]) => path === `${root}/v2/${receipt.id}`)).toBe(true), { timeout: 2500 });
}

it("observes completion after the originating Chat setup surface unmounts", async () => {
  const b = await boundary();
  await polling(b);
  b.connect.unmount();
  await act(async () => b.completion.resolve({ ...receipt, state: "succeeded" }));
  await waitFor(() => expect(b.chat.result.current.catalog.instances[0]!.availability).toBe("available"));
  expect(b.catalogPaths).toHaveLength(2);
});

it("also connects through the real coding-provider summary branch instead of launching a raw command", async () => {
  const b = await boundary({ summary: true });
  await polling(b);
  await act(async () => b.completion.resolve({ ...receipt, state: "succeeded" }));
  expect(b.post.mock.calls.filter(([path]) => path === `${root}/v2/start`)).toHaveLength(1);
  expect(b.post.mock.calls.some(([path]) => path.includes("/terminal/workspaces"))).toBe(false);
  expect(b.chat.result.current.catalog.instances[0]!.availability).toBe("available");
});

it.each(["failed", "cancelled", "expired"] as const)("does not expose models for a %s Terminal completion", async state => {
  const b = await boundary();
  await polling(b);
  await act(async () => b.completion.resolve({ ...receipt, state }));
  expect(useConnection.getState().providerCatalogGeneration).toBe(0);
  expect(b.catalogPaths).toHaveLength(1);
  expect(b.chat.result.current.catalog.instances[0]!.models).toEqual([]);
});

it.each([{ userId: "another_owner" }, { handle: "another_computer" }, { runtimeSlot: "primary" }, { authGeneration: 8 }])(
  "discards a late successful Terminal receipt after changing %j", async changed => {
    const b = await boundary();
    await polling(b);
    act(() => useConnection.setState(changed));
    const generation = useConnection.getState().providerCatalogGeneration;
    await act(async () => b.completion.resolve({ ...receipt, state: "succeeded" }));
    expect(useConnection.getState().providerCatalogGeneration).toBe(generation);
    expect(useConnection.getState().providerCatalogAffectedInstanceIds).toBeNull();
  },
);

it("coalesces repeated Connect clicks into one canonical login", async () => {
  const b = await boundary();
  fireEvent.click(screen.getByRole("button", { name: "Connect Codex" }));
  await polling(b);
  await act(async () => b.completion.resolve({ ...receipt, state: "succeeded" }));
  expect(b.post.mock.calls.filter(([path]) => path === `${root}/v2/start`)).toHaveLength(1);
  expect(b.catalogPaths).toHaveLength(2);
});

it("refuses a mismatched completed receipt instead of borrowing another harness login", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const b = await boundary();
  await polling(b);
  await act(async () => b.completion.resolve({ ...receipt, state: "succeeded", harnessInstanceId: "claude_default" }));
  expect(useConnection.getState().providerCatalogGeneration).toBe(0);
  expect(b.catalogPaths).toHaveLength(1);
  expect(warn).toHaveBeenCalled();
});

it("does not fall back to an unobserved raw CLI command when native Terminal capability is unavailable", async () => {
  const b = await boundary({ terminalAvailable: false });
  await act(async () => {});
  expect(b.post).not.toHaveBeenCalled();
  expect(useTabs.getState().tabs.some(tab => tab.kind === "terminals")).toBe(false);
  expect(useConnection.getState().providerCatalogGeneration).toBe(0);
});

it("stops observing an expired pending login without renewing any catalog", async () => {
  const b = await boundary({ start: { ...receipt, expiresAt: new Date(Date.now() - 1000).toISOString() } });
  await waitFor(() => expect(useTabs.getState().terminalSessionRequest?.sessionName).toBe(terminalRef));
  expect(b.get.mock.calls.some(([path]) => path === `${root}/v2/${receipt.id}`)).toBe(false);
  expect(b.catalogPaths).toHaveLength(1);
  expect(useConnection.getState().providerCatalogGeneration).toBe(0);
});

it("retries a failed Terminal handoff while observing the same login", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const b = await boundary({ handoffFailure: true });
  await polling(b);
  expect(useTabs.getState().terminalSessionRequest).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Connect Codex" }));
  await waitFor(() => expect(useTabs.getState().terminalSessionRequest?.sessionName).toBe(terminalRef));
  expect(b.post.mock.calls.filter(([path]) => path === `${root}/v2/start`)).toHaveLength(1);
  await act(async () => b.completion.resolve({ ...receipt, state: "succeeded" }));
  expect(b.chat.result.current.catalog.instances[0]!.availability).toBe("available");
});

it("reopens the existing Terminal after it was closed without starting another login", async () => {
  const b = await boundary();
  await polling(b);
  const terminal = useTabs.getState().tabs.find(tab => tab.kind === "terminals")!;
  act(() => {
    useTabs.getState().closeTab(terminal.id);
    useTabs.setState({ terminalSessionRequest: null });
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect Codex" }));
  await waitFor(() => expect(useTabs.getState().terminalSessionRequest?.sessionName).toBe(terminalRef));
  expect(b.post.mock.calls.filter(([path]) => path === `${root}/v2/start`)).toHaveLength(1);
  await act(async () => b.completion.resolve({ ...receipt, state: "succeeded" }));
  expect(b.chat.result.current.catalog.instances[0]!.availability).toBe("available");
});

it("does not coalesce a returned Computer with its aborted earlier observer", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const b = await boundary();
  await polling(b);
  act(() => {
    useConnection.setState({ runtimeSlot: "primary" });
    useConnection.setState({ runtimeSlot: "dev" });
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect Codex" }));
  await waitFor(() => expect(b.get.mock.calls.filter(([path]) => path === `${root}/v2/capabilities`)).toHaveLength(2));
  await act(async () => b.completion.resolve({ ...receipt, state: "succeeded" }));
  await waitFor(() => expect(useConnection.getState().providerCatalogGeneration).toBe(1), { timeout: 2500 });
});

it.each(["active", "completed"] as const)("recovers a lost start response when the same native workflow is already %s", async lostStart => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const b = await boundary({ lostStart });
  await waitFor(() => expect(b.post).toHaveBeenCalledTimes(1));
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Connect Codex" }));
  if (lostStart === "active") {
    await waitFor(() => expect(useTabs.getState().terminalSessionRequest?.sessionName).toBe(terminalRef));
    await waitFor(() => expect(b.get.mock.calls.filter(([path]) => path === `${root}/v2/${receipt.id}`)).toHaveLength(2), { timeout: 2500 });
    await act(async () => b.completion.resolve({ ...receipt, state: "succeeded" }));
    expect(b.post).toHaveBeenCalledTimes(1);
  } else {
    await waitFor(() => expect(b.post).toHaveBeenCalledTimes(2));
    const firstBody = (b.post.mock.calls[0] as unknown[])[1];
    const retryBody = (b.post.mock.calls[1] as unknown[])[1];
    expect(retryBody).toEqual(firstBody);
  }
  await waitFor(() => expect(useConnection.getState().providerCatalogGeneration).toBe(1));
  expect(b.chat.result.current.catalog.instances[0]!.models).toEqual(ready.instances[0]!.models);
});

it("rejects another operation's receipt while resuming the advertised native login", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const b = await boundary({ resumeId: "different_active_operation" });
  await waitFor(() => expect(b.get.mock.calls.some(([path]) => path === `${root}/v2/different_active_operation`)).toBe(true));
  await act(async () => b.completion.resolve({ ...receipt, state: "succeeded" }));
  expect(useConnection.getState().providerCatalogGeneration).toBe(0);
  expect(useTabs.getState().terminalSessionRequest).toBeNull();
});
