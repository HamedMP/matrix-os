// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatShareDialog } from "@desktop/renderer/src/features/chat/ChatShareDialog";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);
it("requires disclosure confirmation before creating a link and retains it after clipboard failure", async () => {
  const createLink = vi.fn(async () => ({ url: "https://matrix.test/shared/chat/example/primary/token", id: "share" }));
  render(<ChatShareDialog title="Example" messages={[{ role: "user", text: "Hello" }]} createLink={createLink}
    copyText={vi.fn(async () => { throw new Error("Denied"); })} revoke={vi.fn()} onClose={vi.fn()} />);
  expect((screen.getByRole("button", { name: "Create link" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Create link" }));
  expect(await screen.findByDisplayValue("https://matrix.test/shared/chat/example/primary/token")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Could not copy. Select and copy the link above.");
  expect(createLink).toHaveBeenCalledOnce();
});

it("refreshes changed share previews and requires confirmation again before creating", async () => {
  const { ChatSharingButton } = await import("../../packages/ui/src/chat/ChatSharingButton");
  const old = { title: "Example", revision: 1, fingerprint: "a".repeat(64), messages: [{ role: "user", text: "Hello" }] };
  const updated = { ...old, revision: 2, fingerprint: "b".repeat(64), messages: [...old.messages, { role: "assistant", text: "New reply" }] };
  const get = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce({ shares: [] }).mockResolvedValue(updated);
  const post = vi.fn().mockResolvedValue({ id: "123e4567-e89b-42d3-a456-426614174000", token: "c".repeat(64) });
  render(<ChatSharingButton api={{ baseUrl: "https://matrix.test", get, post, delete: vi.fn() }} chatId="chat_test" handle="example" runtimeSlot="primary" platformHost="https://matrix.test" copyText={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Share" }));
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Create link" }));
  expect(await screen.findByText("New reply")).toBeTruthy();
  expect(post).not.toHaveBeenCalled();
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Create link" }));
  expect(await screen.findByRole("textbox", { name: "Shared Chat link" })).toBeTruthy();
  expect(post).toHaveBeenCalledWith("/api/chats/chat_test/shares", { revision: 2, fingerprint: updated.fingerprint, confirmed: true });
});

it("refreshes a reply committed between preflight and share creation without retrying stale consent", async () => {
  const { ChatSharingButton } = await import("../../packages/ui/src/chat/ChatSharingButton");
  const old = { title: "Example", revision: 1, fingerprint: "a".repeat(64), messages: [{ role: "user", text: "Hello" }] };
  const updated = { ...old, revision: 2, fingerprint: "b".repeat(64), messages: [{ role: "assistant", text: "Racing reply" }] };
  const get = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce({ shares: [] }).mockResolvedValueOnce(old).mockResolvedValueOnce(updated);
  const post = vi.fn().mockRejectedValue(new Error("Conflict"));
  render(<ChatSharingButton api={{ baseUrl: "https://matrix.test", get, post, delete: vi.fn() }} chatId="chat_test" handle="example" runtimeSlot="primary" platformHost="https://matrix.test" copyText={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Share" }));
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Create link" }));
  expect(await screen.findByText("Racing reply")).toBeTruthy();
  expect(post).toHaveBeenCalledOnce();
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  expect(screen.getByText("This Chat changed. Review the updated preview and confirm again.")).toBeTruthy();
});
