// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp.js";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat.js";

vi.mock("@clerk/nextjs", async importOriginal => ({
  ...(await importOriginal<typeof import("@clerk/nextjs")>()),
  useOrganization: () => ({ organization: null }),
  useAuth: () => ({ userId: null, sessionId: null }),
}));
vi.mock("../../shell/src/components/chat-provider-onboarding", () => ({
  ChatProviderOnboarding: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(createCanonicalProviderCatalogFixture())));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const conversation = { id: "chat_release", title: "Release plan", preview: "Release plan", messageCount: 2, updatedAt: 0 };

function renderChat(onDeleteConversation?: (id: string) => Promise<boolean>) {
  render(<ChatApp messages={[]} busy={false} connected conversations={[conversation]}
    onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()} onDeleteConversation={onDeleteConversation} />);
}

async function openDeleteDialog() {
  fireEvent.keyDown(await screen.findByRole("button", { name: "Actions for Release plan" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  return screen.findByRole("alertdialog", { name: "Delete Release plan?" });
}

it("confirms before permanently deleting a Web Chat", async () => {
  const onDelete = vi.fn(async () => true);
  renderChat(onDelete);

  const dialog = await openDeleteDialog();
  expect(dialog.textContent).toContain("This permanently deletes this chat and its messages. This action cannot be undone.");
  expect(onDelete).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));
  await waitFor(() => expect(onDelete).toHaveBeenCalledWith("chat_release"));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

it("keeps the dialog open with a safe message when deletion fails", async () => {
  renderChat(vi.fn(async () => false));

  await openDeleteDialog();
  fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));

  expect((await screen.findByRole("alert")).textContent).toBe("The Chat could not be deleted. Try again.");
  expect(screen.getByRole("alertdialog", { name: "Delete Release plan?" })).toBeTruthy();
});

it("leaves the delete action out when the shell cannot delete", async () => {
  renderChat();

  fireEvent.keyDown(await screen.findByRole("button", { name: "Actions for Release plan" }), { key: "Enter" });
  await screen.findByRole("menu");
  expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
});
