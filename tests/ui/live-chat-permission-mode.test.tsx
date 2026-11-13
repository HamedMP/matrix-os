// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { setCanonicalChatPermissionMode, useLiveChatPermissionMode, liveChatPermissionModes, builtinToolPermissionModeCallback } from "../../packages/ui/src/chat/live-permission-mode";
import { useChatProviderState } from "../../shell/src/components/chat-app-provider-setup";
import { WebChatComposerControls } from "../../shell/src/components/chat/WebChatComposerControls";
import { createCanonicalShellChatClient } from "../../shell/src/lib/canonical-chat-client";
import { createCanonicalChatClient } from "../../desktop/src/renderer/src/lib/canonical-chat-client";
import { createApiClient, type ApiClient } from "../../desktop/src/renderer/src/lib/api";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { createCanonicalChatFixture, createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
function context() {
  const { snapshot } = createCanonicalChatFixture("approval_required");
  let detail: CanonicalChatDetailResponse | null = { record: { chat: snapshot.chat, activeRun: snapshot.chat.activeRun },
    runs: snapshot.runs, messages: [], turns: [], activities: [] };
  const chatId = snapshot.chat.id;
  const runId = snapshot.runs[0]!.id;
  const accepted = { chatId, runId, permissionMode: "full_access" as const, submission: "accepted" as const };
  const commit = vi.fn((update: (value: CanonicalChatDetailResponse | null) => CanonicalChatDetailResponse | null) => { detail = update(detail); });
  const refresh = vi.fn(async () => undefined);
  const input = { runId, permissionMode: "full_access" as const, getDetail: () => detail, isCurrent: () => true, commit, refresh };
  return { chatId, runId, accepted, input, detail: () => detail };
}

it.each(["Web", "Electron"])("%s sends the permission mutation through its real validated client and commits only its confirmed run", async surface => {
  const state = context();
  const fetchFn = vi.fn(async () => Response.json(state.accepted));
  const post = vi.fn(async () => state.accepted);
  const client = surface === "Web" ? createCanonicalShellChatClient({ gatewayUrl: "https://matrix.test", fetchFn })
    : createCanonicalChatClient({ post } as unknown as ApiClient);
  await setCanonicalChatPermissionMode({ ...state.input, client, clientRequestId: "req_permission_intent" });
  expect(state.detail()?.runs[0]?.permissionMode).toBe("full_access");
  expect(state.input.refresh).toHaveBeenCalledWith(state.chatId);
  if (surface === "Web") {
    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining(`/chats/${state.chatId}/runs/${state.runId}/permission-mode`),
      expect.objectContaining({ method: "POST", body: JSON.stringify({ clientRequestId: "req_permission_intent", permissionMode: "full_access" }), signal: expect.any(AbortSignal) }));
  } else expect(post).toHaveBeenCalledWith(expect.stringContaining(`/api/chats/${state.chatId}/runs/${state.runId}/permission-mode`), { clientRequestId: "req_permission_intent", permissionMode: "full_access" }, { timeoutMs: 45_000 });
});

it("keeps an acknowledged permission change confirmed when the subsequent approval refresh fails", async () => {
  const state = context();
  state.input.refresh.mockRejectedValue(new Error("RefreshUnavailable"));
  await expect(setCanonicalChatPermissionMode({ ...state.input, client: { setPermissionMode: vi.fn(async () => state.accepted) } })).resolves.toEqual({ refreshFailed: true });
  expect(state.detail()?.runs[0]?.permissionMode).toBe("full_access");
});

it("recovers a lost response from canonical state without sending the mutation again", async () => {
  const state = context();
  state.input.refresh.mockImplementation(async () => {
    state.input.commit(current => current ? { ...current, runs: current.runs.map(run => ({ ...run, permissionMode: "full_access" })) } : current);
  });
  const setPermissionMode = vi.fn(async () => { throw new TypeError("LostResponse"); });
  await expect(setCanonicalChatPermissionMode({ ...state.input, client: { setPermissionMode } })).resolves.toEqual({ refreshFailed: false });
  expect(setPermissionMode).toHaveBeenCalledOnce();
  expect(state.detail()?.runs[0]?.permissionMode).toBe("full_access");
});

it("does not trust a mismatched acknowledgement or modify a Chat after its authority changes", async () => {
  const wrong = context();
  await expect(setCanonicalChatPermissionMode({ ...wrong.input, client: { setPermissionMode: vi.fn(async () => ({ ...wrong.accepted, chatId: "chat_other" })) } })).rejects.toThrow("Could not change permission mode");
  expect(wrong.input.commit).not.toHaveBeenCalled();
  const stale = context();
  let isCurrent = true;
  const setPermissionMode = vi.fn(async () => { isCurrent = false; return stale.accepted; });
  await expect(setCanonicalChatPermissionMode({ ...stale.input, isCurrent: () => isCurrent, client: { setPermissionMode } })).rejects.toThrow("Could not change permission mode");
  expect(stale.input.commit).not.toHaveBeenCalled();
  expect(stale.input.refresh).not.toHaveBeenCalled();
});

it("keeps the accepted indicator unchanged on rejection and reuses the pending intent id for an explicit retry", async () => {
  const change = vi.fn().mockRejectedValueOnce(new TypeError("LostResponse")).mockResolvedValue(undefined);
  const changeDraft = vi.fn();
  const hook = renderHook(() => useLiveChatPermissionMode({ scope: "runtime:chat:run", activeRunId: "run_one", liveModes: ["supervised", "full_access"], change, changeDraft }));
  await act(async () => { await expect(hook.result.current.select("full_access")).rejects.toThrow("Could not change permission mode"); });
  expect(hook.result.current.error).toBe("Could not change permission mode. Try again.");
  expect(changeDraft).not.toHaveBeenCalled();
  await act(async () => { await hook.result.current.select("full_access"); });
  expect(change.mock.calls[1]?.[2]).toBe(change.mock.calls[0]?.[2]);
  expect(hook.result.current.error).toBeNull();
});

it("disables unsupported active permission changes and isolates a late failure from the next Chat", async () => {
  const changeDraft = vi.fn();
  let reject!: (error: Error) => void;
  const change = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const hook = renderHook(({ scope, supported }) => useLiveChatPermissionMode({ scope, activeRunId: "run_one", liveModes: supported ? ["supervised", "full_access"] : undefined, change, changeDraft }),
    { initialProps: { scope: "runtime:chat_one:run_one", supported: false } });
  expect(hook.result.current.disabled).toBe(true);
  expect(hook.result.current.disabledReason).toMatch(/after this run finishes/);
  hook.rerender({ scope: "runtime:chat_one:run_one", supported: true });
  let result!: Promise<void>;
  act(() => { result = hook.result.current.select("full_access"); });
  const observed = result.catch((error: unknown) => error);
  expect(hook.result.current.pending).toBe(true);
  hook.rerender({ scope: "runtime:chat_two:run_one", supported: true });
  await act(async () => { reject(new Error("OldChatFailure")); await observed; });
  await waitFor(() => expect(hook.result.current.error).toBeNull());
  expect(changeDraft).not.toHaveBeenCalled();
  hook.rerender({ scope: "runtime:chat_one:run_one", supported: true });
  expect(hook.result.current.pending).toBe(false);
  expect(hook.result.current.error).toBeNull();
});

it("offers live controls only for the supported owner run, independent of next-turn drafts", () => {
  const catalog = createCanonicalProviderCatalogFixture();
  catalog.instances[0]!.supports.livePermissionModes = ["supervised", "full_access"];
  const controls = { chatId: "chat_one", runId: "run_one", selection: { instanceId: catalog.instances[0]!.id, model: "fixture" }, interactionMode: "default", permissionMode: "supervised" };
  expect(liveChatPermissionModes(catalog, controls, "run_one", true)).toEqual(["supervised", "full_access"]);
  expect(liveChatPermissionModes(catalog, controls, "run_other", true)).toBeUndefined();
  expect(liveChatPermissionModes(catalog, controls, "run_one", false)).toBeUndefined();
  expect(liveChatPermissionModes(catalog, { ...controls, interactionMode: "plan" }, "run_one", true)).toBeUndefined();
  for (const permissionMode of ["auto", "auto_accept_edits"]) {
    expect(liveChatPermissionModes(catalog, { ...controls, permissionMode }, "run_one", true)).toBeUndefined();
  }
});

it("does not route integration or custom-MCP receipts through a builtin Full access grant", () => {
  const mutate = vi.fn();
  expect(builtinToolPermissionModeCallback("tool_command", mutate)).toBe(mutate);
  expect(builtinToolPermissionModeCallback("integration_command", mutate)).toBeUndefined();
  expect(builtinToolPermissionModeCallback("custom_mcp_command", mutate)).toBeUndefined();
});

it.each(["Web", "Electron"])("%s permits a bounded permission acknowledgement slower than ordinary API requests", async surface => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Deadline", "TimeoutError")), milliseconds);
    return controller.signal;
  });
  const state = context();
  const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(Response.json(state.accepted)), 12_000);
    init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
  }));
  const client = surface === "Web" ? createCanonicalShellChatClient({ gatewayUrl: "https://matrix.test", fetchFn })
    : createCanonicalChatClient(createApiClient({ baseUrl: "https://matrix.test", getRuntimeSlot: () => "primary", fetchFn }));
  const result = client.setPermissionMode!(state.chatId, state.runId, { clientRequestId: "req_slow_permission", permissionMode: "full_access" })
    .then(value => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }));
  await vi.advanceTimersByTimeAsync(12_000);
  expect(await result).toMatchObject({ ok: true, value: state.accepted });
  expect(fetchFn).toHaveBeenCalledOnce();
});

it("shows recovery copy while preserving confirmed Full Access when approval reload fails", async () => {
  const state = context();
  const catalog = createCanonicalProviderCatalogFixture();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(catalog)));
  state.input.refresh.mockRejectedValue(new Error("RefreshUnavailable"));
  function Controls() {
    const detail = state.detail()!;
    const run = detail.runs[0]!;
    const providerState = useChatProviderState(run.selection, run.instanceId, { chatId: state.chatId,
      executionControls: { chatId: state.chatId, runId: state.runId, selection: run.selection, interactionMode: run.interactionMode, permissionMode: run.permissionMode } });
    const permissionControl = useLiveChatPermissionMode({ scope: state.chatId, activeRunId: state.runId,
      liveModes: ["supervised", "full_access"], changeDraft: providerState.selectPermissionMode,
      change: async () => await setCanonicalChatPermissionMode({ ...state.input, client: { setPermissionMode: vi.fn(async () => state.accepted) } }),
    });
    return <WebChatComposerControls providerState={providerState} permissionControl={permissionControl} onSetupAction={vi.fn()} />;
  }
  render(<Controls />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Permission mode" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Permission mode" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Full Access" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Permission mode" }).textContent).toContain("Full Access"));
  expect(screen.getByRole("alert").textContent).toBe("Permission mode changed. Reopen this chat to refresh tool requests.");
  expect(state.detail()?.runs[0]?.permissionMode).toBe("full_access");
  expect(screen.queryByText("Could not change permission mode. Try again.")).toBeNull();
  vi.unstubAllGlobals();
});

it.each(["organization", "shared"])("does not issue a live mutation for a %s Chat", async kind => {
  const state = context();
  state.input.commit(current => current ? { ...current, record: { ...current.record, chat: { ...current.record.chat,
    ...(kind === "organization" ? { ownerScope: { type: "organization" as const, ownerId: "org_one" } }
      : { collaboration: { mode: "shared" as const, membership: { role: "owner" as const, memberCount: 2 } } }),
  } } } : current);
  const setPermissionMode = vi.fn(async () => state.accepted);
  await expect(setCanonicalChatPermissionMode({ ...state.input, client: { setPermissionMode } })).rejects.toThrow("Could not change permission mode");
  expect(setPermissionMode).not.toHaveBeenCalled();
});
