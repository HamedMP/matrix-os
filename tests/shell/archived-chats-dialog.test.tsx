// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ArchivedChatsDialog } from "../../shell/src/components/chat/ArchivedChatsDialog";

afterEach(cleanup);

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
