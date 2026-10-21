// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createChatNavigationStore } from "@matrix-os/ui";
import type { CanonicalChatNavigationItem, CanonicalChatRecord } from "@matrix-os/contracts";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { AppError } from "@desktop/shared/app-error";
import { useProjectLandingChats } from "@desktop/renderer/src/features/project/use-project-landing-chats";

const navigation = vi.hoisted(() => ({
  items: [] as CanonicalChatNavigationItem[],
  truncated: false,
  status: "ready" as "ready" | "loading" | "error",
  error: null as string | null,
  store: null as ReturnType<typeof createChatNavigationStore> | null,
}));
vi.mock("@desktop/renderer/src/features/work/use-work-navigation", () => ({ useWorkNavigation: () => navigation }));
beforeEach(() => {
  navigation.items = [];
  navigation.truncated = false;
  navigation.status = "ready";
  navigation.error = null;
  navigation.store = createChatNavigationStore({ load: async () => ({ version: 1, items: [], truncated: false }) });
});
afterEach(() => { cleanup(); navigation.store?.dispose(); });
const project = { id: "project_alpha", slug: "alpha", name: "Alpha", kind: "folder" as const };
function record(id: string, projectId = project.id): CanonicalChatRecord {
  return { chat: { id, title: id, ownerScope: { type: "personal", ownerId: "project_fixture" },
    revision: 1, titleVersion: 1, lifecycle: "active", attention: "none", messageCount: 0,
    createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z" }, projectId };
}
function item(id: string, projectId = project.id, kind: "ordinary" | "bot" = "ordinary"): CanonicalChatNavigationItem {
  return { ...record(id, projectId), classification: kind === "ordinary" ? { kind } : { kind, agentId: "agent_alpha" }, persistence: "personal" };
}
function clientWithBots() {
  return {
    list: vi.fn(async () => ({ items: [] as CanonicalChatRecord[] })),
    agents: { list: vi.fn(async () => ({ agents: [] })), bots: { directBot: vi.fn(async () => null) } },
  } as unknown as CanonicalChatClient;
}

it("reuses complete shared navigation across Project selection and hiding without list or Bot reads", () => {
  navigation.items = [item("chat_stable"), item("chat_legacy", project.slug), item("chat_bot", project.id, "bot"), item("chat_other", "other")];
  const client = clientWithBots();
  const { result, rerender } = renderHook(({ project, active }) => useProjectLandingChats(project, client, undefined, active), { initialProps: { project, active: true } });
  expect(result.current.chats.map(x => x.chat.id)).toEqual(["chat_stable", "chat_legacy"]);
  rerender({ project: { ...project, id: "project_other", slug: "other" }, active: true });
  expect(result.current.chats.map(x => x.chat.id)).toEqual(["chat_other"]);
  rerender({ project, active: false });
  rerender({ project, active: true });
  expect(result.current.chats).toHaveLength(2);
  expect(client.list).not.toHaveBeenCalled();
  expect(client.agents?.list).not.toHaveBeenCalled();
  expect(client.agents?.bots?.directBot).not.toHaveBeenCalled();
});

it("retains cached Project cards during refresh failures and clears them with shared authority", () => {
  navigation.items = [item("chat_cached")];
  navigation.status = "error";
  navigation.error = "Chats could not be loaded. Try again.";
  const client = clientWithBots();
  const { result, rerender } = renderHook(() => useProjectLandingChats(project, client));
  expect(result.current.chats.map(x => x.chat.id)).toEqual(["chat_cached"]);
  expect(result.current.error).toBe(true);
  navigation.items = [];
  rerender();
  expect(result.current.chats).toEqual([]);
  expect(client.list).not.toHaveBeenCalled();
});

it("waits for shared initial loading instead of starting a competing scoped list", () => {
  navigation.status = "loading";
  const client = clientWithBots();
  const { result, rerender } = renderHook(() => useProjectLandingChats(project, client));
  expect(result.current.chats).toEqual([]);
  navigation.items = [item("chat_ready")];
  navigation.status = "ready";
  rerender();
  expect(result.current.chats.map(x => x.chat.id)).toEqual(["chat_ready"]);
  expect(client.list).not.toHaveBeenCalled();
});

it("loads stable and legacy Project associations beyond a truncated global window and fences clients", async () => {
  navigation.truncated = true;
  const stable = record("chat_stable"), legacy = record("chat_old", project.slug);
  const client = clientWithBots();
  vi.mocked(client.list).mockImplementation(async input => ({ items: input?.projectId === project.slug ? [legacy] : [stable] }));
  const { result, rerender } = renderHook(({ client }) => useProjectLandingChats(project, client), { initialProps: { client } });
  await waitFor(() => expect(result.current.chats).toHaveLength(2));
  expect(client.list).toHaveBeenCalledWith({ projectId: project.id, limit: 100 });
  expect(client.list).toHaveBeenCalledWith({ projectId: project.slug, limit: 100 });
  const next = { list: vi.fn(() => new Promise(() => {})) } as unknown as CanonicalChatClient;
  rerender({ client: next });
  expect(result.current.chats).toEqual([]);
});

it("classifies older scoped rows and excludes Bots even outside the global window", async () => {
  navigation.truncated = true;
  const client = clientWithBots();
  vi.mocked(client.list).mockResolvedValue({ items: [record("chat_ordinary"), record("chat_bot")] });
  vi.mocked(client.agents!.bots!.directBot).mockImplementation(async id => id === "chat_bot" ? "agent_alpha" : null);
  const { result } = renderHook(() => useProjectLandingChats(project, client));
  await waitFor(() => expect(result.current.chats.map(x => x.chat.id)).toEqual(["chat_ordinary"]));
  expect(client.agents!.bots!.directBot).toHaveBeenCalledWith("chat_bot");
});

it("fails closed for scoped rows without a binding reader while retaining authoritative ordinary rows", async () => {
  navigation.truncated = true;
  navigation.items = [item("chat_confirmed"), item("chat_bound", project.id, "bot")];
  const client = { list: vi.fn(async () => ({ items: [
    record("chat_confirmed"), record("chat_bound"), record("chat_unknown"),
  ] })) } as unknown as CanonicalChatClient;
  const { result } = renderHook(() => useProjectLandingChats(project, client));
  await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.chats.map(x => x.chat.id)).toEqual(["chat_confirmed"]));
});

it("does not start scoped reads or Bot classification while inactive", () => {
  navigation.truncated = true;
  const client = clientWithBots();
  const { result } = renderHook(() => useProjectLandingChats(project, client, undefined, false));
  expect(result.current.chats).toEqual([]);
  expect(client.list).not.toHaveBeenCalled();
  expect(client.agents!.bots!.directBot).not.toHaveBeenCalled();
});

it("fences delayed scoped reads when the snapshot becomes complete or its authority changes", async () => {
  navigation.truncated = true;
  let resolve!: (value: { items: CanonicalChatRecord[] }) => void;
  const client = { list: vi.fn(() => new Promise(res => { resolve = res; })) } as unknown as CanonicalChatClient;
  // One reference makes the deferred request independently controllable.
  const selected = { ...project, slug: project.id };
  const { result, rerender } = renderHook(() => useProjectLandingChats(selected, client));
  navigation.truncated = false;
  navigation.items = [item("chat_current")];
  rerender();
  await act(async () => resolve({ items: [record("chat_stale")] }));
  expect(result.current.chats.map(x => x.chat.id)).toEqual(["chat_current"]);
  navigation.items = [];
  navigation.store = createChatNavigationStore({ load: async () => ({ version: 1, items: [], truncated: false }) });
  rerender();
  expect(result.current.chats).toEqual([]);
});

it("retains scoped cards for transient failures but clears them on authentication revocation", async () => {
  navigation.truncated = true;
  const client = clientWithBots();
  vi.mocked(client.list).mockResolvedValue({ items: [record("chat_cached")] });
  let changed!: (event: { type: "chat.full_refresh" }) => void;
  const eventSource = { subscribe: vi.fn(callback => { changed = callback; return { dispose: vi.fn() }; }) };
  const { result } = renderHook(() => useProjectLandingChats(project, client, eventSource));
  await waitFor(() => expect(result.current.chats).toHaveLength(1));
  vi.mocked(client.list).mockRejectedValue(new AppError("server"));
  act(() => changed({ type: "chat.full_refresh" }));
  await waitFor(() => expect(result.current.error).toBe(true));
  expect(result.current.chats).toHaveLength(1);
  vi.mocked(client.list).mockRejectedValue(new AppError("unauthorized"));
  act(() => changed({ type: "chat.full_refresh" }));
  await waitFor(() => expect(result.current.chats).toEqual([]));
});

it("hides old scoped cards immediately when the verified scope changes on the same client", async () => {
  navigation.truncated = true;
  const client = clientWithBots();
  vi.mocked(client.list).mockResolvedValue({ items: [record("chat_old_scope")] });
  const { result, rerender } = renderHook(() => useProjectLandingChats(project, client));
  await waitFor(() => expect(result.current.chats).toHaveLength(1));
  vi.mocked(client.list).mockImplementation(() => new Promise(() => {}));
  navigation.store = createChatNavigationStore({ load: async () => ({ version: 1, items: [], truncated: false }) });
  rerender();
  expect(result.current.chats).toEqual([]);
  navigation.store = null;
  rerender();
  expect(result.current.chats).toEqual([]);
});

it("ignores a delayed scoped Project response after another Project's cards have loaded", async () => {
  navigation.truncated = true;
  const alpha = { ...project, slug: project.id };
  const beta = { ...project, id: "project_beta", slug: "project_beta" };
  let resolveAlpha!: (value: { items: CanonicalChatRecord[] }) => void;
  const client = clientWithBots();
  vi.mocked(client.list).mockImplementation(input => input?.projectId === alpha.id
    ? new Promise(resolve => { resolveAlpha = resolve; })
    : Promise.resolve({ items: [record("chat_beta", beta.id)] }));
  const { result, rerender } = renderHook(({ selected }) => useProjectLandingChats(selected, client), { initialProps: { selected: alpha } });
  rerender({ selected: beta });
  await waitFor(() => expect(result.current.chats.map(x => x.chat.id)).toEqual(["chat_beta"]));
  await act(async () => resolveAlpha({ items: [record("chat_alpha", alpha.id)] }));
  expect(result.current.chats.map(x => x.chat.id)).toEqual(["chat_beta"]);
});


function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

it("discards Project cards across same-store revocation and failed truncated recovery", async () => {
  navigation.truncated = true;
  const selected = { ...project, slug: project.id };
  const client = clientWithBots();
  vi.mocked(client.list).mockResolvedValue({ items: [record("chat_private")] });
  const hook = renderHook(() => useProjectLandingChats(selected, client));
  await waitFor(() => expect(hook.result.current.chats).toHaveLength(1));
  act(() => { navigation.store!.revoke(); navigation.truncated = false; hook.rerender(); });
  expect(hook.result.current.chats).toEqual([]);
  const recovery = pending<{ items: CanonicalChatRecord[] }>();
  vi.mocked(client.list).mockImplementationOnce(() => recovery.promise);
  navigation.truncated = true;
  hook.rerender();
  expect(hook.result.current.chats).toEqual([]);
  await act(async () => recovery.reject(new AppError("server")));
  await waitFor(() => expect(hook.result.current.error).toBe(true));
  expect(hook.result.current.chats).toEqual([]);
});

it("rejects a late Project response after revocation before React effect cleanup", async () => {
  navigation.truncated = true;
  const delayed = pending<{ items: CanonicalChatRecord[] }>();
  const client = clientWithBots();
  vi.mocked(client.list).mockImplementationOnce(() => delayed.promise);
  const hook = renderHook(() => useProjectLandingChats({ ...project, slug: project.id }, client));
  await act(async () => {
    navigation.store!.revoke();
    delayed.resolve({ items: [record("chat_late_private")] });
  });
  expect(hook.result.current.chats).toEqual([]);
  expect(client.agents!.bots!.directBot).not.toHaveBeenCalled();
});

it("rechecks Project Bot identity after same-store authority recovery", async () => {
  navigation.truncated = true;
  const selected = { ...project, slug: project.id };
  const client = clientWithBots();
  vi.mocked(client.list).mockResolvedValue({ items: [record("chat_reclassified")] });
  const hook = renderHook(() => useProjectLandingChats(selected, client));
  await waitFor(() => expect(hook.result.current.chats).toHaveLength(1));
  vi.mocked(client.agents!.bots!.directBot).mockResolvedValue("agent_alpha");
  act(() => { navigation.store!.revoke(); navigation.truncated = false; hook.rerender(); });
  navigation.truncated = true;
  hook.rerender();
  await waitFor(() => expect(client.agents!.bots!.directBot).toHaveBeenCalledTimes(2));
  expect(hook.result.current.chats).toEqual([]);
});

it("revokes shared navigation on a scoped Project authorization rejection", async () => {
  navigation.truncated = true;
  const client = clientWithBots();
  vi.mocked(client.list).mockRejectedValue(new AppError("unauthorized"));
  const revoke = vi.spyOn(navigation.store!, "revoke");
  const hook = renderHook(() => useProjectLandingChats({ ...project, slug: project.id }, client));
  await waitFor(() => expect(revoke).toHaveBeenCalledOnce());
  expect(navigation.store!.getSnapshot().items).toEqual([]);
  expect(hook.result.current.chats).toEqual([]);
});

it.each([false, true])("matches a Project without an ID only by its valid slug (truncated=%s)", async truncated => {
  const selected = { ...project, id: undefined };
  const global = { ...item("chat_global"), projectId: undefined };
  navigation.items = [global, item("chat_slug", selected.slug)];
  navigation.truncated = truncated;
  const client = clientWithBots();
  vi.mocked(client.list).mockResolvedValue({ items: [{ ...record("chat_global"), projectId: undefined }, record("chat_slug", selected.slug)] });
  const hook = renderHook(() => useProjectLandingChats(selected, client));
  if (truncated) await waitFor(() => expect(client.list).toHaveBeenCalledOnce());
  expect(hook.result.current.chats.map(row => row.chat.id)).toEqual(["chat_slug"]);
});

it.each([true, false])("retains confirmed global Project cards through pending and failed scoped reads (binding reader=%s)", async hasReader => {
  navigation.truncated = true;
  navigation.items = [item("chat_confirmed"), item("chat_bot", project.id, "bot"), item("chat_elsewhere", "other")];
  const deferred = pending<{ items: CanonicalChatRecord[] }>();
  const client = hasReader ? clientWithBots() : { list: vi.fn() } as unknown as CanonicalChatClient;
  vi.mocked(client.list).mockImplementation(() => deferred.promise);
  const hook = renderHook(() => useProjectLandingChats(project, client));
  expect(hook.result.current.chats.map(row => row.chat.id)).toEqual(["chat_confirmed"]);
  await act(async () => deferred.reject(new AppError("server")));
  await waitFor(() => expect(hook.result.current.error).toBe(true));
  expect(hook.result.current.chats.map(row => row.chat.id)).toEqual(["chat_confirmed"]);
});

it("merges scoped older cards with confirmed global cards without stale membership or classification leaks", async () => {
  navigation.truncated = true;
  const newest = { ...item("chat_recent"), chat: { ...item("chat_recent").chat, revision: 2, activityAt: "2026-10-08T00:00:00Z" } };
  navigation.items = [newest, item("chat_moved", "other"), item("chat_bot", project.id, "bot")];
  const client = clientWithBots();
  vi.mocked(client.list).mockResolvedValue({ items: [
    { ...record("chat_recent"), chat: { ...record("chat_recent").chat, revision: 1, title: "Stale title" } },
    record("chat_moved"), record("chat_bot"), record("chat_older"), record("chat_unknown"),
  ] });
  vi.mocked(client.agents!.bots!.directBot).mockImplementation(async id => {
    if (id === "chat_unknown") throw new AppError("server");
    return null;
  });
  const hook = renderHook(() => useProjectLandingChats(project, client));
  await waitFor(() => expect(client.agents!.bots!.directBot).toHaveBeenCalledWith("chat_older"));
  await waitFor(() => expect(hook.result.current.chats.map(row => row.chat.id)).toEqual(["chat_recent", "chat_older"]));
  expect(hook.result.current.chats[0]?.chat.title).toBe("chat_recent");
  expect(client.agents!.bots!.directBot).not.toHaveBeenCalledWith("chat_bot");
});

it("caps the activity-sorted global and scoped Project cohort at 1000 unique cards", async () => {
  navigation.truncated = true;
  navigation.items = Array.from({ length: 1000 }, (_, index) => item(`chat_global_${String(index).padStart(4, "0")}`));
  const client = clientWithBots();
  const latest = record("chat_latest"); latest.chat.activityAt = "2026-10-08T00:00:00Z";
  vi.mocked(client.list).mockResolvedValue({ items: [latest] });
  const hook = renderHook(() => useProjectLandingChats(project, client));
  await waitFor(() => expect(hook.result.current.chats[0]?.chat.id).toBe("chat_latest"));
  expect(hook.result.current.chats).toHaveLength(1000);
  expect(new Set(hook.result.current.chats.map(row => row.chat.id)).size).toBe(1000);
});

it("retains only newly authorized global cards during failed truncated recovery", async () => {
  navigation.truncated = true;
  navigation.items = [item("chat_old_global")];
  const client = clientWithBots();
  vi.mocked(client.list).mockResolvedValue({ items: [record("chat_old_scoped")] });
  const hook = renderHook(() => useProjectLandingChats({ ...project, slug: project.id }, client));
  await waitFor(() => expect(hook.result.current.chats).toHaveLength(2));
  act(() => {
    navigation.store!.revoke(); navigation.items = []; navigation.truncated = false; hook.rerender();
  });
  expect(hook.result.current.chats).toEqual([]);
  const recovery = pending<{ items: CanonicalChatRecord[] }>();
  vi.mocked(client.list).mockImplementation(() => recovery.promise);
  navigation.items = [item("chat_new_global")]; navigation.truncated = true; hook.rerender();
  expect(hook.result.current.chats.map(row => row.chat.id)).toEqual(["chat_new_global"]);
  await act(async () => recovery.reject(new AppError("server")));
  await waitFor(() => expect(hook.result.current.error).toBe(true));
  expect(hook.result.current.chats.map(row => row.chat.id)).toEqual(["chat_new_global"]);
});

it.each([
  { name: "newer scoped move into Project", globalProjectId: "other", globalRevision: 1, scopedProjectId: project.id, scopedRevision: 2, visible: true },
  { name: "newer scoped move out of Project", globalProjectId: project.id, globalRevision: 1, scopedProjectId: "other", scopedRevision: 2, visible: false },
  { name: "newer scoped removal from Project", globalProjectId: project.id, globalRevision: 1, scopedProjectId: undefined, scopedRevision: 2, visible: false },
  { name: "older scoped move against newer global", globalProjectId: "other", globalRevision: 2, scopedProjectId: project.id, scopedRevision: 1, visible: false },
  { name: "equal revision global outside Project", globalProjectId: "other", globalRevision: 2, scopedProjectId: project.id, scopedRevision: 2, visible: false },
  { name: "equal revision global inside Project", globalProjectId: project.id, globalRevision: 2, scopedProjectId: "other", scopedRevision: 2, visible: true },
  { name: "known Bot despite newer scoped membership", globalProjectId: "other", globalRevision: 1, scopedProjectId: project.id, scopedRevision: 2, visible: false, bot: true },
])("merges membership by canonical revision: $name", async test => {
  navigation.truncated = true;
  const global = { ...item("chat_revision", test.globalProjectId, test.bot ? "bot" : "ordinary"),
    chat: { ...item("chat_revision").chat, revision: test.globalRevision, titleVersion: 1, title: "Global title", activityAt: "2026-10-08T00:00:00Z" } };
  const scoped = { ...record("chat_revision"), projectId: test.scopedProjectId,
    chat: { ...record("chat_revision").chat, revision: test.scopedRevision, titleVersion: 1, title: "Scoped title", activityAt: "2026-10-01T00:00:00Z" } };
  navigation.items = [global];
  const deferred = pending<{ items: CanonicalChatRecord[] }>();
  const client = clientWithBots();
  vi.mocked(client.list).mockImplementation(() => deferred.promise);
  const hook = renderHook(() => useProjectLandingChats(project, client));
  await act(async () => deferred.resolve({ items: [scoped] }));
  await waitFor(() => expect(hook.result.current.chats.map(row => row.chat.id)).toEqual(test.visible ? ["chat_revision"] : []));
  if (test.visible) {
    expect(hook.result.current.chats[0]?.projectId).toBe(project.id);
    expect(hook.result.current.chats[0]?.chat.title).toBe(test.scopedRevision > test.globalRevision ? "Scoped title" : "Global title");
    expect(hook.result.current.chats[0]?.chat.revision).toBe(Math.max(test.globalRevision, test.scopedRevision));
  }
  expect(client.agents!.bots!.directBot).not.toHaveBeenCalledWith("chat_revision");
});

it("keeps unknown scoped cards hidden until their Bot classification settles", async () => {
  navigation.truncated = true;
  navigation.items = [item("chat_confirmed")];
  const identity = pending<string | null>();
  const client = clientWithBots();
  vi.mocked(client.list).mockResolvedValue({ items: [record("chat_unknown_scoped")] });
  vi.mocked(client.agents!.bots!.directBot).mockImplementation(() => identity.promise);
  const hook = renderHook(() => useProjectLandingChats(project, client));
  await waitFor(() => expect(client.agents!.bots!.directBot).toHaveBeenCalledWith("chat_unknown_scoped"));
  expect(hook.result.current.chats.map(row => row.chat.id)).toEqual(["chat_confirmed"]);
  await act(async () => identity.resolve(null));
  await waitFor(() => expect(hook.result.current.chats.map(row => row.chat.id)).toEqual(["chat_confirmed", "chat_unknown_scoped"]));
});
