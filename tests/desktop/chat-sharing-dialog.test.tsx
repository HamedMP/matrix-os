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
