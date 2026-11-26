// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ArchivedChatsPage, archivedChatContextLabel, type ChatArchiveClient } from "../../packages/ui/src/chat/ArchivedChatsPage";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(cleanup);
const archived = { chat: { id: "chat_archive", title: "Archived design", lifecycle: "archived", revision: 3, archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, projectId: "project_alpha" };
function client() {
  return { list: vi.fn(async (): Promise<{ items: typeof archived[]; nextCursor?: string }> => ({ items: [archived] })), search: vi.fn(async () => ({ items: [archived] })),
    updateLifecycle: vi.fn(async (_id: string, _input: { baseRevision: number; lifecycle: "active" | "archived" }) => ({ ...archived, chat: { ...archived.chat, revision: 4, lifecycle: "active" } })), delete: vi.fn(async (_id: string, _requestId: string) => ({})) };
}

it("selects archives on the full page, clears with Escape and leaves a failed restore selected for retry", async () => {
  const api = client();
  const failedChat = createCanonicalChatFixture("failed").snapshot.chat;
  api.updateLifecycle.mockResolvedValue({ ...archived, chat: { ...failedChat, id: archived.chat.id, title: archived.chat.title, revision: 4, lifecycle: "active", archivedAt: new Date().toISOString() } });
  api.updateLifecycle.mockRejectedValueOnce(new Error("offline"));
  render(<ArchivedChatsPage client={api as unknown as ChatArchiveClient} projects={[{ id: "project_alpha", slug: "alpha", name: "Alpha" }]}/>);
  expect(await screen.findByRole("heading", { name: "Archived chats" })).toBeTruthy();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select Archived design" }));
  expect(screen.getByRole("toolbar", { name: "Archive selection" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Restore", exact: true }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  fireEvent.keyDown(screen.getByRole("region", { name: "Archived chats" }), { key: "Escape" });
  expect(screen.queryByRole("toolbar")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Restore Archived design" }));
  await waitFor(() => expect(screen.queryByRole("checkbox")).toBeNull());
  expect(api.updateLifecycle).toHaveBeenCalledWith("chat_archive", { baseRevision: 3, lifecycle: "active" });
  expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Chat restored to Needs you · Alpha");
});

it("searches message history and requires an explicit permanent-delete confirmation", async () => {
  const api = client();
  render(<ArchivedChatsPage client={api as unknown as ChatArchiveClient} projects={[]}/>);
  await screen.findByRole("checkbox");
  fireEvent.change(screen.getByRole("searchbox", { name: "Search archived chats" }), { target: { value: "message-only phrase" } });
  await waitFor(() => expect(api.search).toHaveBeenCalledWith("message-only phrase", { lifecycle: "archived", limit: 50 }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete Archived design" }));
  expect(api.delete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete forever" }));
  await waitFor(() => expect(api.delete).toHaveBeenCalledWith("chat_archive", expect.stringMatching(/^req_/)));
  await waitFor(() => expect(screen.queryByRole("checkbox")).toBeNull());
});

it("retries only the remaining chat after a partial permanent-delete failure", async () => {
  const second = { ...archived, chat: { ...archived.chat, id: "chat_second", title: "Second archive" } };
  const api = client();
  api.list.mockResolvedValue({ items: [archived, second] });
  api.delete.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("offline")).mockResolvedValue({});
  render(<ArchivedChatsPage client={api as unknown as ChatArchiveClient} projects={[]}/>);
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select Archived design" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Second archive" }));
  fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: "Delete", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Delete forever" }));
  await screen.findByRole("alert");
  expect(within(screen.getByRole("dialog", { name: "Delete archived chats?" })).getByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete forever" }));
  await waitFor(() => expect(screen.queryByRole("checkbox")).toBeNull());
  expect(api.delete.mock.calls.map(call => call[0])).toEqual(["chat_archive", "chat_second", "chat_second"]);
});

it("shows project context for both canonical IDs and legacy slugs", async () => {
  const api = client();
  api.list.mockResolvedValue({ items: [
    { ...archived, projectId: "alpha" },
    { ...archived, chat: { ...archived.chat, id: "chat_beta", title: "Beta archive" }, projectId: "beta" },
  ] });
  render(<ArchivedChatsPage client={api as unknown as ChatArchiveClient} projects={[
    { id: "project_alpha", slug: "alpha", name: "Alpha" }, { id: "project_beta", slug: "beta", name: "Beta" },
  ]}/>);
  expect(await screen.findByRole("checkbox", { name: "Select Archived design" })).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Select Beta archive" })).toBeTruthy();
  expect(screen.getByText(/· Alpha/)).toBeTruthy();
  expect(screen.getByText(/· Beta/)).toBeTruthy();
});

it("keeps restore Undo available while searching other archives", async () => {
  const api = client();
  api.search.mockResolvedValue({ items: [] });
  render(<ArchivedChatsPage client={api as unknown as ChatArchiveClient} projects={[]}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Restore Archived design" }));
  await screen.findByRole("button", { name: "Undo" });
  fireEvent.change(screen.getByRole("searchbox", { name: "Search archived chats" }), { target: { value: "another archive" } });
  await waitFor(() => expect(api.search).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(api.updateLifecycle).toHaveBeenCalledWith("chat_archive", { baseRevision: 4, lifecycle: "archived" }));
  expect((screen.getByRole("searchbox", { name: "Search archived chats" }) as HTMLInputElement).value).toBe("another archive");
  await waitFor(() => expect(api.search).toHaveBeenCalledTimes(2));
});

it("lets the user retry a failed archived-history read", async () => {
  const api = client();
  api.list.mockRejectedValueOnce(new Error("offline"));
  render(<ArchivedChatsPage client={api as unknown as ChatArchiveClient} projects={[]}/>);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Retry loading archived chats" }));
  expect(await screen.findByRole("checkbox", { name: "Select Archived design" })).toBeTruthy();
});

it("searches across project boundaries without hiding matching archives", async () => {
  const beta = { ...archived, chat: { ...archived.chat, id: "chat_beta", title: "Beta archive" }, projectId: "project_beta" };
  const api = client();
  api.list.mockResolvedValue({ items: [archived, beta] });
  api.search.mockResolvedValue({ items: [beta] });
  render(<ArchivedChatsPage client={api as unknown as ChatArchiveClient} projects={[
    { id: "project_alpha", slug: "alpha", name: "Alpha" }, { id: "project_beta", slug: "beta", name: "Beta" },
  ]}/>);
  await screen.findByRole("checkbox", { name: "Select Archived design" });
  fireEvent.change(screen.getByRole("searchbox", { name: "Search archived chats" }), { target: { value: "Beta archive" } });
  expect(await screen.findByRole("checkbox", { name: "Select Beta archive" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "All projects" })).toBeNull();
});

it("retries a failed next page with the same cursor and keeps loaded selections", async () => {
  const second = { ...archived, chat: { ...archived.chat, id: "chat_second", title: "Second archive" } };
  const api = client();
  api.list.mockResolvedValueOnce({ items: [archived], nextCursor: "older_cursor" })
    .mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ items: [second] });
  render(<ArchivedChatsPage client={api as unknown as ChatArchiveClient} projects={[]}/>);
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select Archived design" }));
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Retry loading archived chats" }));
  expect(await screen.findByRole("checkbox", { name: "Select Second archive" })).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: "Select Archived design" }) as HTMLInputElement).checked).toBe(true);
  expect(api.list).toHaveBeenLastCalledWith({ lifecycle: "archived", limit: 50, cursor: "older_cursor" });
});

it.each(["restore", "delete"] as const)("does not reinsert a %s result from a stale overlapping page", async action => {
  const retained = { ...archived, chat: { ...archived.chat, id: "chat_retained", title: "Retained archive" } };
  const older = { ...archived, chat: { ...archived.chat, id: "chat_older", title: "Older archive" } };
  const api = client();
  let resolveNext!: (page: Awaited<ReturnType<typeof api.list>>) => void;
  api.list.mockResolvedValueOnce({ items: [archived, retained], nextCursor: "older_cursor" })
    .mockImplementationOnce(() => new Promise(resolve => { resolveNext = resolve; }));
  render(<ArchivedChatsPage client={api as unknown as ChatArchiveClient} projects={[]}/>);
  await screen.findByRole("checkbox", { name: "Select Archived design" });
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: `${action === "restore" ? "Restore" : "Delete"} Archived design` }));
  if (action === "delete") fireEvent.click(screen.getByRole("button", { name: "Delete forever" }));
  await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Select Archived design" })).toBeNull());
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Retained archive" }));
  await act(async () => { resolveNext({ items: [archived, older] }); });
  expect(await screen.findByRole("checkbox", { name: "Select Older archive" })).toBeTruthy();
  expect(screen.queryByRole("checkbox", { name: "Select Archived design" })).toBeNull();
  expect((screen.getByRole("checkbox", { name: "Select Retained archive" }) as HTMLInputElement).checked).toBe(true);
  expect(api.list).toHaveBeenLastCalledWith({ lifecycle: "archived", limit: 50, cursor: "older_cursor" });
});

it("reloads conflicted revisions while preserving the failed restore selection", async () => {
 const api=client();api.updateLifecycle.mockRejectedValueOnce(new Error("RevisionConflict"));
 api.list.mockResolvedValueOnce({items:[archived]}).mockResolvedValue({items:[{...archived,chat:{...archived.chat,revision:9}}]});
 render(<ArchivedChatsPage client={api as unknown as ChatArchiveClient} projects={[]}/>);
 fireEvent.click(await screen.findByRole("checkbox",{name:"Select Archived design"}));
 fireEvent.click(screen.getByRole("button",{name:"Restore",exact:true}));
 fireEvent.click(await screen.findByRole("button",{name:"Reload archives"}));
 await waitFor(()=>expect(api.list).toHaveBeenCalledTimes(2));
 expect((await screen.findByRole("checkbox",{name:"Select Archived design"}) as HTMLInputElement).checked).toBe(true);
 fireEvent.click(screen.getByRole("button",{name:"Restore",exact:true}));
 await waitFor(()=>expect(api.updateLifecycle).toHaveBeenLastCalledWith("chat_archive",{baseRevision:9,lifecycle:"active"}));
});

it("labels an archived search result with its project and archive day the same way in both desktops", () => {
  const day = 86400_000;
  const at = (offset: number) => ({ chat: { archivedAt: new Date(Date.now() - offset).toISOString(), updatedAt: new Date(0).toISOString() } });
  expect(archivedChatContextLabel(at(0), "Lisbon trip")).toBe("Lisbon trip · Archived today");
  expect(archivedChatContextLabel(at(0))).toBe("Archived today");
  const old = new Date(Date.now() - 40 * day);
  expect(archivedChatContextLabel(at(40 * day), "Portfolio")).toBe(`Portfolio · Archived ${old.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`);
  expect(archivedChatContextLabel({ chat: { archivedAt: null, updatedAt: old.toISOString() } })).toBe(`Archived ${old.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`);
});

it("labels yesterday by calendar day across a daylight-saving change", () => {
  const previousTz = process.env.TZ;
  process.env.TZ = "America/New_York";
  vi.useFakeTimers();
  try {
    // US clocks fall back on 1 Nov 2026, so that local day is 25 hours long.
    vi.setSystemTime(new Date(2026, 10, 2, 0, 30));
    const archivedAt = new Date(2026, 10, 1, 0, 30).toISOString();
    expect(archivedChatContextLabel({ chat: { archivedAt, updatedAt: archivedAt } })).toBe("Archived yesterday");
  } finally {
    vi.useRealTimers();
    if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz;
  }
});
