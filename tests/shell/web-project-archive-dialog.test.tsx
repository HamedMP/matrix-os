// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WebProjectArchiveAction } from "../../shell/src/components/chat/WebProjectArchiveAction";

afterEach(cleanup);

it("uses the project menu and shared confirmation dialog before archiving project chats", async () => {
  const archive = vi.fn(async () => true);
  render(<WebProjectArchiveAction projectId="proj_one" projectSlug="one" projectName="One" onArchive={archive}/>);
  fireEvent.click(screen.getByRole("button", { name: "Actions for One" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Archive chats in One" }));
  const dialog = screen.getByRole("alertdialog", { name: "Archive chats in One?" });
  expect(dialog.getAttribute("data-slot")).toBe("dialog-content");
  expect(archive).not.toHaveBeenCalled();
});
