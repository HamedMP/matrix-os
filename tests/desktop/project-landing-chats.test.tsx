// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CanonicalChatNavigationItem, CanonicalChatRecord } from "@matrix-os/contracts";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { AppError } from "@desktop/shared/app-error";
import { useProjectLandingChats } from "@desktop/renderer/src/features/project/use-project-landing-chats";

const navigation = vi.hoisted(() => ({
  items: [] as CanonicalChatNavigationItem[],
  truncated: false,
  status: "ready" as "ready" | "loading" | "error",
  error: null as string | null,
  store: {} as object | null,
}));
vi.mock("@desktop/renderer/src/features/work/use-work-navigation", () => ({ useWorkNavigation: () => navigation }));
beforeEach(() => {
  navigation.items = [];
  navigation.truncated = false;
  navigation.status = "ready";
  navigation.error = null;
  navigation.store = {};
});
afterEach(cleanup);
const project = { id: "project_alpha", slug: "alpha", name: "Alpha", kind: "folder" as const };
function record(id: string, projectId = project.id): CanonicalChatRecord {
  return { chat: { id, title: id, createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z" }, projectId } as CanonicalChatRecord;
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
  navigation.store = {};
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
  navigation.store = {};
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
