// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { WorkRail } from "@desktop/renderer/src/features/work/WorkRail";
import type { Project } from "@desktop/renderer/src/stores/board";
import { afterEach, describe, expect, it, vi } from "vitest";

function record(
  id: string,
  title: string,
  options: { pinned?: boolean; projectId?: string; updatedAt: string },
): CanonicalChatRecord {
  return {
    chat: {
      id,
      ownerScope: { type: "personal", ownerId: "owner_test" },
      title,
      lifecycle: "active",
      attention: "none",
      revision: 1,
      messageCount: 1,
      userState: { readThroughSeq: 0, pinned: options.pinned ?? false, muted: false },
      createdAt: options.updatedAt,
      updatedAt: options.updatedAt,
    },
    ...(options.projectId ? { projectId: options.projectId } : {}),
  };
}

const alpha: Project = {
  id: "project_alpha_id",
  slug: "alpha",
  name: "Alpha",
  kind: "folder",
};
const beta: Project = {
  id: "project_beta_id",
  slug: "beta",
  name: "Beta",
  kind: "scratch",
};
const pinned = record("chat_pinned", "Pinned global", {
  pinned: true,
  updatedAt: "2026-08-28T12:00:00.000Z",
});
const projectChat = record("chat_alpha", "Alpha chat", {
  projectId: "project_alpha_id",
  updatedAt: "2026-08-28T11:00:00.000Z",
});
const recent = record("chat_recent", "Recent global", {
  updatedAt: "2026-08-28T10:00:00.000Z",
});

function setup() {
  const records = [pinned, projectChat, recent];
  const client = {
    list: vi.fn(async () => ({ items: records })),
    delete: vi.fn(async (chatId: string) => ({
      chatId,
      deletedAt: "2026-08-28T13:00:00.000Z",
    })),
    updateUserState: vi.fn(async (chatId: string, input: { pinned: boolean }) => {
      const current = records.find((candidate) => candidate.chat.id === chatId)!;
      return {
        ...current,
        chat: {
          ...current.chat,
          userState: { readThroughSeq: 0, muted: false, pinned: input.pinned },
        },
      };
    }),
  } as unknown as CanonicalChatClient;
  const actions = {
    onNewGlobalChat: vi.fn(),
    onCreateProject: vi.fn(),
    onNewProjectChat: vi.fn(),
    onSelectChat: vi.fn(),
    onCollapse: vi.fn(),
  };
  render(<WorkRail client={client} projects={[alpha]} active {...actions} />);
  return { client, actions };
}

afterEach(cleanup);

describe("WorkRail", () => {
  it("renders New chat as a plain leading rail row", async () => {
    const { actions } = setup();
    await screen.findByRole("button", { name: "Pinned global" });

    const newChat = screen.getByRole("button", { name: "New chat" });
    expect(newChat.className).toContain("justify-start");
    expect(newChat.className).not.toContain("w-full");
    expect(newChat.parentElement?.className).toContain("mx-3");
    expect(newChat.style.background).toBe("");
    fireEvent.click(newChat);
    expect(actions.onNewGlobalChat).toHaveBeenCalledOnce();
  });

  it("refreshes the same Chat id across Global to Project and Project to Project routes", async () => {
    const global = record("chat_moved", "Moved chat", {
      updatedAt: "2026-08-28T14:00:00.000Z",
    });
    const inAlpha = { ...global, projectId: "project_alpha_id" };
    const inBeta = { ...global, projectId: "project_beta_id" };
    const client = {
      list: vi.fn()
        .mockResolvedValueOnce({ items: [global] })
        .mockResolvedValueOnce({ items: [inAlpha] })
        .mockResolvedValueOnce({ items: [inBeta] }),
    } as unknown as CanonicalChatClient;
    const actions = {
      onNewGlobalChat: vi.fn(),
      onCreateProject: vi.fn(),
      onNewProjectChat: vi.fn(),
      onSelectChat: vi.fn(),
      onCollapse: vi.fn(),
    };
    const { rerender } = render(
      <WorkRail
        client={client}
        projects={[alpha, beta]}
        active
        activeChatId="chat_moved"
        {...actions}
      />,
    );
    expect(await screen.findByRole("button", { name: "Moved chat" })).toBeTruthy();

    rerender(
      <WorkRail
        client={client}
        projects={[alpha, beta]}
        active
        activeChatId="chat_moved"
        activeProjectSlug="alpha"
        {...actions}
      />,
    );
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
    const alphaRow = screen.getByRole("button", { name: "Alpha" });
    fireEvent.click(alphaRow);
    expect(within(alphaRow.parentElement!.parentElement!).getByRole("button", { name: "Moved chat" })).toBeTruthy();

    rerender(
      <WorkRail
        client={client}
        projects={[alpha, beta]}
        active
        activeChatId="chat_moved"
        activeProjectSlug="beta"
        {...actions}
      />,
    );
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(3));
    const betaRow = screen.getByRole("button", { name: "Beta" });
    fireEvent.click(betaRow);
    expect(within(betaRow.parentElement!.parentElement!).getByRole("button", { name: "Moved chat" })).toBeTruthy();
  });

  it("loads bounded canonical Chat pages without a Project filter", async () => {
    const older = record("chat_older", "Older chat", {
      updatedAt: "2026-08-27T10:00:00.000Z",
    });
    const client = {
      list: vi.fn()
        .mockResolvedValueOnce({ items: [recent], nextCursor: "chatcur_page2" })
        .mockResolvedValueOnce({ items: [older] }),
    } as unknown as CanonicalChatClient;
    render(
      <WorkRail
        client={client}
        projects={[alpha]}
        active
        onNewGlobalChat={vi.fn()}
        onCreateProject={vi.fn()}
        onNewProjectChat={vi.fn()}
        onSelectChat={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );

    expect(await screen.findByRole("button", { name: "Older chat" })).toBeTruthy();
    expect(client.list).toHaveBeenNthCalledWith(1, { limit: 100 });
    expect(client.list).toHaveBeenNthCalledWith(2, { limit: 100, cursor: "chatcur_page2" });
  });

  it("logs a classified initial-load failure while showing the safe rail error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = {
      list: vi.fn(async () => { throw new TypeError("private gateway detail"); }),
    } as unknown as CanonicalChatClient;
    render(
      <WorkRail
        client={client}
        projects={[alpha]}
        active
        onNewGlobalChat={vi.fn()}
        onCreateProject={vi.fn()}
        onNewProjectChat={vi.fn()}
        onSelectChat={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );

    expect((await screen.findByRole("alert")).textContent).toBe("Chats could not be loaded.");
    expect(warn).toHaveBeenCalledWith("[work] Chat list load failed:", "TypeError");
  });

  it("reloads the canonical list when the retained Work route selects a new Chat", async () => {
    const created = record("chat_created", "Created chat", {
      updatedAt: "2026-08-28T13:00:00.000Z",
    });
    const client = {
      list: vi.fn()
        .mockResolvedValueOnce({ items: [recent] })
        .mockResolvedValueOnce({ items: [created, recent] }),
    } as unknown as CanonicalChatClient;
    const actions = {
      onNewGlobalChat: vi.fn(),
      onCreateProject: vi.fn(),
      onNewProjectChat: vi.fn(),
      onSelectChat: vi.fn(),
      onCollapse: vi.fn(),
    };
    const { rerender } = render(
      <WorkRail client={client} projects={[alpha]} active {...actions} />,
    );
    expect(await screen.findByRole("button", { name: "Recent global" })).toBeTruthy();

    rerender(
      <WorkRail
        client={client}
        projects={[alpha]}
        active
        activeChatId="chat_created"
        {...actions}
      />,
    );

    expect(await screen.findByRole("button", { name: "Created chat" })).toBeTruthy();
  });

  it("keeps section and Project disclosure state independent", async () => {
    setup();
    expect(await screen.findByRole("button", { name: "Pinned global" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Recent global" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Alpha chat" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(screen.getByRole("button", { name: "Alpha chat" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Pinned" }));
    expect(screen.queryByRole("button", { name: "Pinned global" })).toBeNull();
    expect(screen.getByRole("button", { name: "Alpha chat" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Recent global" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull();
    expect(screen.getByRole("button", { name: "Recent global" })).toBeTruthy();
  });

  it("exposes keyboard-reachable global, Project, Chat, and collapse actions without Board", async () => {
    const { actions } = setup();
    await screen.findByRole("button", { name: "Pinned global" });

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));

    const compose = screen.getByRole("button", { name: "New chat in Alpha" });
    expect(screen.queryByRole("button", { name: "Open Alpha board" })).toBeNull();
    compose.focus();
    expect(document.activeElement).toBe(compose);
    expect(compose.className).toContain("focus-visible");
    expect(compose.parentElement?.className).toContain("group-focus-within/project:opacity-100");
    fireEvent.click(compose);
    fireEvent.click(screen.getByRole("button", { name: "Hide Chat navigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Alpha chat" }));

    expect(actions.onNewGlobalChat).toHaveBeenCalledOnce();
    expect(actions.onCreateProject).toHaveBeenCalledOnce();
    expect(actions.onNewProjectChat).toHaveBeenCalledWith(alpha);
    expect(actions.onCollapse).toHaveBeenCalledOnce();
    expect(actions.onSelectChat).toHaveBeenCalledWith(projectChat, alpha);
  });

  it("pins and unpins through the canonical client and updates unique placement", async () => {
    const { client } = setup();
    await screen.findByRole("button", { name: "Recent global" });

    fireEvent.click(screen.getByRole("button", { name: "Pin Recent global" }));
    await waitFor(() => expect(client.updateUserState).toHaveBeenCalledWith("chat_recent", { pinned: true }));
    expect(await screen.findByRole("button", { name: "Unpin Recent global" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Unpin Pinned global" }));
    await waitFor(() => expect(client.updateUserState).toHaveBeenCalledWith("chat_pinned", { pinned: false }));
    expect(await screen.findByRole("button", { name: "Pin Pinned global" })).toBeTruthy();
  });

  it("logs a classified pin failure and restores the row action", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const records = [recent];
    const client = {
      list: vi.fn(async () => ({ items: records })),
      updateUserState: vi.fn(async () => { throw new Error("private gateway detail"); }),
    } as unknown as CanonicalChatClient;
    render(
      <WorkRail
        client={client}
        projects={[]}
        active
        onNewGlobalChat={vi.fn()}
        onCreateProject={vi.fn()}
        onNewProjectChat={vi.fn()}
        onSelectChat={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Pin Recent global" }));
    await waitFor(() => expect(warn).toHaveBeenCalledWith(
      "[work] Chat pin update failed:",
      "Error",
    ));
    expect(screen.queryByText("Chats could not be loaded.")).toBeNull();
    expect(screen.getByText("Chat pin could not be updated.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Pin Recent global" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows Pin and Delete in the Chat context menu", async () => {
    setup();
    const recentChat = await screen.findByRole("button", { name: "Recent global" });

    fireEvent.contextMenu(recentChat, { clientX: 120, clientY: 160 });

    expect(await screen.findByRole("menuitem", { name: "Pin" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
  });

  it("deletes a Chat from its hover action after confirmation", async () => {
    const { client } = setup();
    await screen.findByRole("button", { name: "Recent global" });

    fireEvent.click(screen.getByRole("button", { name: "Delete Recent global" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));

    await waitFor(() => expect(client.delete).toHaveBeenCalledWith(
      "chat_recent",
      expect.any(String),
    ));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Recent global" })).toBeNull());
  });

  it("opens Project deletion from both hover and right-click actions", async () => {
    setup();
    const project = await screen.findByRole("button", { name: "Alpha" });

    expect(screen.getByRole("button", { name: "Delete Alpha project" })).toBeTruthy();
    fireEvent.contextMenu(project, { clientX: 100, clientY: 140 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    expect(await screen.findByRole("alertdialog", { name: "Delete project permanently?" })).toBeTruthy();
  });
});
