// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useConnection, wireConnectionEvents, unwireConnectionEvents } from "@desktop/renderer/src/stores/connection";
import { desktopQueryClient } from "@desktop/renderer/src/lib/query-client";
import { clearDraftChats, useDraftChat } from "@desktop/renderer/src/stores/draft-chat";
import * as apiModule from "@desktop/renderer/src/lib/api";
import * as collaboration from "@desktop/renderer/src/lib/collaboration";

const older = { signedIn: true, handle: "computer-a", userId: "owner-a", platformHost: "https://platform.test", runtimeSlot: "primary", authGeneration: 1 };
const newer = { ...older, handle: "computer-b", userId: "owner-b", runtimeSlot: "preview", authGeneration: 2 };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  unwireConnectionEvents(); clearDraftChats(); desktopQueryClient.clear();
  useConnection.setState({ status: "signed-in", handle: older.handle, userId: older.userId, platformHost: older.platformHost, runtimeSlot: "primary", authGeneration: 1, api: null });
});
afterEach(() => { unwireConnectionEvents(); vi.restoreAllMocks(); desktopQueryClient.clear(); clearDraftChats(); });

it("ignores every queued callback from old wiring, including collaboration cleanup", async () => {
  const listeners = new Map<string, Array<() => void>>();
  const close = vi.spyOn(collaboration, "closeDesktopCollaborationSessions");
  window.operator = { invoke: vi.fn().mockResolvedValue(older), on: vi.fn((channel: string, callback: () => void) => {
    listeners.set(channel, [...(listeners.get(channel) ?? []), callback]);
    return () => {};
  }) };
  wireConnectionEvents();
  const queued = [...(listeners.get("auth:changed") ?? []), ...(listeners.get("runtime:changed") ?? [])];
  unwireConnectionEvents(); listeners.clear(); wireConnectionEvents();
  const state = useConnection.getState();
  desktopQueryClient.setQueryData(["current-owner"], "keep");
  for (const callback of queued) callback();
  await Promise.resolve();
  expect(close).not.toHaveBeenCalled();
  expect(window.operator.invoke).not.toHaveBeenCalled();
  expect(useConnection.getState()).toBe(state);
  expect(desktopQueryClient.getQueryData(["current-owner"])).toBe("keep");
  for (const callback of listeners.get("auth:changed") ?? []) callback();
  await Promise.resolve();
  expect(close).toHaveBeenCalledOnce();
  expect(window.operator.invoke).toHaveBeenCalledExactlyOnceWith("auth:status", {});
});

for (const outcome of ["success", "rejection"] as const) {
  it(`ignores an older refresh ${outcome} before cache, API or organization effects`, async () => {
    const first = deferred<typeof older>(), second = deferred<typeof newer>();
    window.operator = { invoke: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise), on: vi.fn() };
    const a = useConnection.getState().refresh(), b = useConnection.getState().refresh();
    second.resolve(newer); await b;
    const accepted = useConnection.getState();
    desktopQueryClient.setQueryData(["new-owner-catalog"], "keep");
    useDraftChat.getState().setDraft("project", { prompt: "keep", providerId: "codex", mode: "default", sandboxMode: "workspace_write", projectId: "project" });
    const draft = useDraftChat.getState();
    const api = vi.spyOn(apiModule, "createApiClient");
    const savedOrg = vi.spyOn(Storage.prototype, "getItem");
    if (outcome === "success") first.resolve(older); else first.reject(new Error("private path/token"));
    await a;
    expect(useConnection.getState()).toBe(accepted);
    expect(desktopQueryClient.getQueryData(["new-owner-catalog"])).toBe("keep");
    expect(useDraftChat.getState()).toBe(draft);
    expect(api).not.toHaveBeenCalled(); expect(savedOrg).not.toHaveBeenCalled();
  });

  it(`ignores a pending refresh ${outcome} after successful sign-out`, async () => {
    const pending = deferred<typeof older>();
    window.operator = { invoke: vi.fn((channel: string) => channel === "auth:status" ? pending.promise : Promise.resolve({})), on: vi.fn() };
    const refresh = useConnection.getState().refresh();
    await useConnection.getState().signOut();
    const signedOut = useConnection.getState();
    desktopQueryClient.setQueryData(["signed-out-data"], "keep");
    if (outcome === "success") pending.resolve(older); else pending.reject(new Error("old error"));
    await refresh;
    expect(useConnection.getState()).toBe(signedOut);
    expect(desktopQueryClient.getQueryData(["signed-out-data"])).toBe("keep");
  });

  it(`invalidates a pre-selection ${outcome} before the post-switch status settles`, async () => {
    const old = deferred<typeof older>(), postSwitch = deferred<typeof newer>();
    window.operator = { invoke: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce({}).mockReturnValueOnce(postSwitch.promise), on: vi.fn() };
    const refresh = useConnection.getState().refresh();
    const selection = useConnection.getState().selectRuntime("preview");
    await vi.waitFor(() => expect(window.operator.invoke).toHaveBeenCalledTimes(3));
    const switching = useConnection.getState();
    if (outcome === "success") old.resolve(older); else old.reject(new Error("old error"));
    await refresh;
    expect(useConnection.getState()).toBe(switching);
    expect(useConnection.getState().runtimeSlot).toBe("preview");
    postSwitch.resolve(newer); await selection;
    expect(useConnection.getState().userId).toBe("owner-b");
  });

  it(`discards an old event refresh ${outcome} after rewiring`, async () => {
    const pending = deferred<typeof older>();
    const listeners = new Map<string, Array<() => void>>();
    window.operator = { invoke: vi.fn().mockReturnValue(pending.promise), on: vi.fn((channel: string, callback: () => void) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), callback]);
      return () => {};
    }) };
    wireConnectionEvents();
    for (const callback of listeners.get("auth:changed") ?? []) callback();
    unwireConnectionEvents(); wireConnectionEvents();
    const state = useConnection.getState();
    if (outcome === "success") pending.resolve(newer); else pending.reject(new Error("old wiring"));
    await pending.promise.catch(() => undefined); await Promise.resolve();
    expect(useConnection.getState()).toBe(state);
  });
}
