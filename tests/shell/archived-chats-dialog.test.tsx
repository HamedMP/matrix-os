// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ArchivedChatsDialog } from "../../shell/src/components/chat/ArchivedChatsDialog";

afterEach(cleanup);

it("searches archived history and keeps the query when loading older matches", async () => {
  const row = (id: string) => ({ chat: { id, title: id, revision: 1, archivedAt: "2026-11-12T00:00:00.000Z" } });
  const list = vi.fn(async () => ({ items: [row("Recent archive")] }));
  const search = vi.fn().mockResolvedValueOnce({ items: [row("Planning match")], nextCursor: "chatcur_older" })
    .mockResolvedValueOnce({ items: [row("Older planning match")] });
  render(<ArchivedChatsDialog open onClose={vi.fn()} list={list as never} search={search}
    restore={vi.fn(async () => true)} remove={vi.fn(async () => true)}/>);
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select Recent archive" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search archived chats" }), { target: { value: "planning" } });
  await screen.findByRole("checkbox", { name: "Select Planning match" });
  expect(search).toHaveBeenCalledWith("planning", { lifecycle: "archived", limit: 50 });
  expect(screen.getByRole("button", { name: "Restore selected" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  await screen.findByRole("checkbox", { name: "Select Older planning match" });
  expect(search).toHaveBeenCalledWith("planning", { lifecycle: "archived", limit: 50, cursor: "chatcur_older" });
  fireEvent.change(screen.getByRole("searchbox", { name: "Search archived chats" }), { target: { value: "" } });
  await screen.findByRole("checkbox", { name: "Select Recent archive" });
});

it("restores selected archived chats and confirms permanent deletion", async () => {
  const row = { chat: { id: "chat_one", title: "Old chat", revision: 3, archivedAt: "2026-11-12T00:00:00.000Z" } };
  const list = vi.fn(async () => ({ items: [row], nextCursor: undefined }));
  const restore = vi.fn(async () => true);
  const remove = vi.fn(async () => true);
  const view = render(<ArchivedChatsDialog open onClose={vi.fn()} list={list as never} restore={restore} remove={remove}/>);
  await screen.findByRole("checkbox", { name: "Select Old chat" });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Old chat" }));
  fireEvent.click(screen.getByRole("button", { name: "Restore selected" }));
  await waitFor(() => expect(restore).toHaveBeenCalledWith("chat_one", 3));
  view.rerender(<ArchivedChatsDialog open={false} onClose={vi.fn()} list={list as never} restore={restore} remove={remove}/>);
  view.rerender(<ArchivedChatsDialog open onClose={vi.fn()} list={list as never} restore={restore} remove={remove}/>);
  await screen.findByRole("checkbox", { name: "Select Old chat" });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Old chat" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith("chat_one"));
});

it("ignores a late archive page after the dialog reopens", async () => {
  const row = (id: string) => ({ chat: { id, title: id, revision: 1, archivedAt: "2026-11-12T00:00:00.000Z" } });
  let finishOld!: (value: unknown) => void;
  const oldPage = new Promise(resolve => { finishOld = resolve; });
  const list = vi.fn(async (cursor?: string) => cursor ? oldPage : { items: [row("Recent")], nextCursor: "next" });
  const props = { onClose: vi.fn(), list: list as never, restore: vi.fn(async () => true), remove: vi.fn(async () => true) };
  const view = render(<ArchivedChatsDialog open {...props}/>);
  await screen.findByRole("checkbox", { name: "Select Recent" });
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  view.rerender(<ArchivedChatsDialog open={false} {...props}/>);
  view.rerender(<ArchivedChatsDialog open {...props}/>);
  await screen.findByRole("checkbox", { name: "Select Recent" });
  await act(async () => finishOld({ items: [row("Stale")], nextCursor: undefined }));
  expect(screen.queryByRole("checkbox", { name: "Select Stale" })).toBeNull();
});
