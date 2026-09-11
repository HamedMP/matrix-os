// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { WorkRailChatRow } from "@desktop/renderer/src/features/work/work-rail/WorkRailChatRow";
import { ChatContextMenu } from "@matrix-os/ui";
import { RenameableConversationRow } from "../../shell/src/components/chat/ChatTitleRename";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { canonicalChatRecord, createCanonicalChatWorkspaceClient, providerCatalog } from "./canonical-chat-workspace-test-utils";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("copies the right-clicked Chat ID without opening or renaming that chat", async () => {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const select = vi.fn();
  const rename = vi.fn();
  const record = { chat: { id: "chat_diagnostic_42", title: "Investigate failure", attention: "failed" } } as CanonicalChatRecord;
  render(<WorkRailChatRow record={record} active={false} pinning={false} placement="recent"
    renaming={false} renamePending={false} renameDisabled={false} onSelect={select} onRenameStart={rename}
    onRenameCommit={vi.fn()} onRenameCancel={vi.fn()} onPin={vi.fn()} onDelete={vi.fn()} />);
  fireEvent.contextMenu(screen.getByRole("button", { name: "Investigate failure" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Copy chat ID" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("chat_diagnostic_42"));
  expect(select).not.toHaveBeenCalled();
  expect(rename).not.toHaveBeenCalled();
});

it.each([null, "matrix-os"])("copies from the Electron %s chat list and visible content", async (projectId) => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<CanonicalChatWorkspace client={createCanonicalChatWorkspaceClient()} projectId={projectId}
    initialChatId={canonicalChatRecord.chat.id} initialView="conversation" active catalog={providerCatalog} />);
  const row = await screen.findByRole("button", { name: canonicalChatRecord.chat.title });
  fireEvent.contextMenu(row);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Copy chat ID" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(canonicalChatRecord.chat.id));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  const transcript = await screen.findByRole("log");
  fireEvent.contextMenu(transcript);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Copy chat ID" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
});

it("offers Copy chat ID on Web chat rows even when renaming is unavailable", async () => {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<RenameableConversationRow conversation={{ id: "chat_web", title: "Web chat", preview: "", messageCount: 0, updatedAt: 0 }}
    active={false} mobile={false} editing={false} renamePending={false} onSelect={vi.fn()}
    onRenameCommit={vi.fn()} onRenameCancel={vi.fn()} />);
  fireEvent.contextMenu(screen.getByRole("button", { name: "Web chat" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Copy chat ID" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("chat_web"));
});

it("keeps a safe, retryable clipboard failure visible in the menu", async () => {
  const writeText = vi.fn().mockRejectedValueOnce(new Error("secret platform failure")).mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<ChatContextMenu chatId="chat_retry"><button>Transcript</button></ChatContextMenu>);
  fireEvent.contextMenu(screen.getByRole("button", { name: "Transcript" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Copy chat ID" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Could not copy chat ID. Try again.");
  expect(screen.queryByText(/secret platform/)).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy chat ID" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Chat ID copied"));
});

it("does not offer a fabricated ID for a draft and fences clipboard feedback after switching chats", async () => {
  let complete!: () => void;
  const writeText = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const view = render(<ChatContextMenu><button>Draft</button></ChatContextMenu>);
  fireEvent.contextMenu(screen.getByRole("button", { name: "Draft" }));
  expect(screen.queryByRole("menuitem", { name: "Copy chat ID" })).toBeNull();
  view.rerender(<ChatContextMenu chatId="chat_old"><button>Draft</button></ChatContextMenu>);
  fireEvent.contextMenu(screen.getByRole("button", { name: "Draft" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Copy chat ID" }));
  view.rerender(<ChatContextMenu chatId="chat_new"><button>Draft</button></ChatContextMenu>);
  await React.act(async () => { complete(); });
  expect(screen.queryByText("Chat ID copied")).toBeNull();
  expect(writeText).toHaveBeenCalledWith("chat_old");
});

it("preserves copying selected transcript text alongside Copy chat ID", async () => {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<ChatContextMenu chatId="chat_selected"><div>Selected reply text</div></ChatContextMenu>);
  const text = screen.getByText("Selected reply text");
  const range = document.createRange();
  range.selectNodeContents(text);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  expect(window.getSelection()!.toString()).toBe("Selected reply text");
  fireEvent.contextMenu(text);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Copy selected text" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("Selected reply text"));
  window.getSelection()!.removeAllRanges();
});

it("ignores a late clipboard rejection after switching chats even without a selection API", async () => {
  let reject!: (error: unknown) => void;
  const writeText = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  vi.spyOn(window, "getSelection").mockReturnValue(null);
  const view = render(<ChatContextMenu chatId="chat_old"><button>Reply</button></ChatContextMenu>);
  fireEvent.contextMenu(screen.getByRole("button", { name: "Reply" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Copy chat ID" }));
  view.rerender(<ChatContextMenu chatId="chat_new"><button>Reply</button></ChatContextMenu>);
  await React.act(async () => { reject("private clipboard failure"); });
  expect(screen.queryByRole("alert")).toBeNull();
});
