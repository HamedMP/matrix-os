// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FocusedWebProject } from "../../shell/src/components/chat/FocusedWebProject";
import type { RenameableConversation } from "../../shell/src/components/chat/ChatTitleRename";

// Every fetched Chat is already listed, and paging has reached its cap.
vi.mock("../../shell/src/components/chat/usePagedProjectChats", async original => ({
  ...await original<typeof import("../../shell/src/components/chat/usePagedProjectChats")>(),
  usePagedProjectChats: () => ({ expanded: true, toggleExpanded: vi.fn(), fetched: [{ id: "chat_1", title: "Chat 1", titleVersion: 0 }],
    loading: false, error: false, retry: vi.fn(), loadMore: vi.fn(), hasMore: false, capped: true }),
}));

afterEach(cleanup);

it("keeps the paging-limit notice when every capped row is already listed", () => {
  const chat = { id: "chat_1", title: "Chat 1", preview: "", messageCount: 1, updatedAt: 1 } as RenameableConversation;
  render(<FocusedWebProject project={{ id: "proj_france", slug: "france", name: "France" }} gatewayUrl="https://example.test" chats={[chat]}
    listedChatIds={new Set(["chat_1"])} onSelectChat={vi.fn()} renderRow={item => <p key={item.id}>{item.title}</p>} onBack={vi.fn()}
    mobile={false} unreadOnly={false} sourceFilter="all" searchQuery="" />);
  expect(screen.getByText("Showing the newest 1,000 chats in this project.")).toBeTruthy();
});
