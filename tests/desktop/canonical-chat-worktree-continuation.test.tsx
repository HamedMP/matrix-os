// @vitest-environment jsdom

import React from "react";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import type { CanonicalChatEventSource, CanonicalChatInvalidation } from "@desktop/renderer/src/lib/canonical-chat-client";
import { AppError } from "@desktop/shared/app-error";
import { createChatExecutionRootResolver } from "../../packages/gateway/src/chat/execution-root";
import { createProjectManager } from "../../packages/gateway/src/project-manager";
import { createWorktreeManager } from "../../packages/gateway/src/worktree-manager";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useProviderPreferences } from "@desktop/renderer/src/features/settings/provider-preferences";
import { useRetainedComposerDrafts } from "@desktop/renderer/src/features/chat/retained-composer-drafts";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { createCanonicalChatWorkspaceClient } from "./canonical-chat-workspace-test-utils";
import { mockSharedComposerPopoverLayout, setSharedComposerText } from "./shared-chat-composer-test-utils";

const worktree = { kind: "worktree", projectId: "matrix-os", worktreeId: "wt_00000000000a" } as const;

function worktreeFixture(state: "completed" | "running" = "completed") {
  const { snapshot, providerCatalog } = createCanonicalChatFixture(state);
  const { project, providerBinding, activeRun, ...chat } = snapshot.chat;
  const run = { ...snapshot.runs[0]!, executionRoot: worktree };
  const detail: CanonicalChatDetailResponse = {
    record: { chat, projectId: project.projectId, providerBinding, ...(activeRun ? { activeRun } : {}) },
    messages: snapshot.messages,
    turns: snapshot.turns,
    runs: [run],
    activities: snapshot.activities,
  };
  const client = createCanonicalChatWorkspaceClient();
  vi.mocked(client.list).mockResolvedValue({ items: [detail.record] });
  vi.mocked(client.getDetail).mockResolvedValue(detail);
  vi.mocked(client.admitTurn).mockImplementation(async (_chatId, input) => ({
    admission: "accepted",
    record: detail.record,
    message: snapshot.messages[0]!,
    turn: { ...snapshot.turns[0]!, clientRequestId: input.clientRequestId },
    run: { ...run, permissionMode: input.permissionMode, executionRoot: input.executionRoot },
  }));
  vi.mocked(client.queueTurn).mockImplementation(async (_chatId, input) => ({
    queueDepth: 1,
    queuedTurn: {
      ...input, id: "qturn_continuation", chatId: chat.id, position: 1,
      createdAt: run.createdAt, updatedAt: run.updatedAt,
    },
  }));
  return { detail, client, providerCatalog };
}

function openWorkspace(fixture: ReturnType<typeof worktreeFixture>) {
  return render(<CanonicalChatWorkspace client={fixture.client} projectId="matrix-os"
    initialChatId={fixture.detail.record.chat.id} initialView="conversation"
    active catalog={fixture.providerCatalog} />);
}

describe("native Chat worktree continuation", () => {
  let restoreLayout: () => void;
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    restoreLayout = mockSharedComposerPopoverLayout();
    useConnection.setState({ ...useConnection.getInitialState(), status: "signed-in", userId: "user_fixture" }, true);
    useBoard.setState(useBoard.getInitialState(), true);
    useProviderPreferences.setState({ ...useProviderPreferences.getInitialState(), hydrated: true }, true);
    useRetainedComposerDrafts.setState(useRetainedComposerDrafts.getInitialState(), true);
    window.operator = { invoke: vi.fn(async () => ({ available: false })), on: vi.fn(() => () => undefined) };
  });
  afterEach(() => { cleanup(); restoreLayout(); vi.unstubAllGlobals(); });

  it("continues in the same worktree after reopening and keeps the selected Full Access mode", async () => {
    const fixture = worktreeFixture();
    const first = openWorkspace(fixture);
    await screen.findByRole("textbox", { name: "Reply to chat" });
    first.unmount();
    openWorkspace(fixture);
    const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
    fireEvent.click(screen.getByRole("button", { name: "Permission mode" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Full Access" }));
    await setSharedComposerText(editor, "Change the Files menu in this worktree.");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fixture.client.admitTurn).toHaveBeenCalledWith(
      fixture.detail.record.chat.id,
      expect.objectContaining({ executionRoot: worktree, permissionMode: "full_access",
        parts: [{ type: "text", text: "Change the Files menu in this worktree." }] }),
      { chatScope: "project" },
    ));
    expect(screen.getByRole("button", { name: "Permission mode" }).textContent).toContain("Full Access");
  });

  it("queues a normal follow-up in the running worktree", async () => {
    const fixture = worktreeFixture("running");
    openWorkspace(fixture);
    const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
    await setSharedComposerText(editor, "Then run the Files tests in the same worktree.");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fixture.client.queueTurn).toHaveBeenCalledWith(
      fixture.detail.record.chat.id,
      expect.objectContaining({ executionRoot: worktree, parts: [{ type: "text", text: "Then run the Files tests in the same worktree." }] }),
    ));
  });

  it("offers an idle Chat an explicit project checkout after its worktree is deleted", async () => {
    const fixture = worktreeFixture();
    const { detail, client } = fixture;
    const owner = detail.record.chat.ownerScope;
    if (owner.type !== "personal") throw new Error("Expected a personal Chat");
    const ownerScope = { type: "user" as const, id: owner.ownerId };
    const homePath = await mkdtemp(join(tmpdir(), "matrix-chat-worktree-deletion-"));
    try {
      const projects = createProjectManager({ homePath });
      const created = await projects.createProject({ mode: "scratch", name: "Matrix OS", slug: "matrix-os", ownerScope });
      if (!created.ok) throw new Error("Fixture project creation failed");
      const { project } = created;
      const worktrees = createWorktreeManager({
        homePath, runCommand: async (_command, args) => {
          if (args[0] === "worktree" && args[1] === "add") {
            await mkdir(args[args.indexOf("--") + 1]!, { recursive: true });
          }
          return { stdout: "", stderr: "" };
        },
      });
      const createdWorktree = await worktrees.createWorktree({ projectSlug: project.slug, branch: "feature/chat", ownerScope });
      if (!createdWorktree.ok) throw new Error("Fixture worktree creation failed");
      const root = { kind: "worktree", projectId: project.id, worktreeId: createdWorktree.worktree.id } as const;
      const projectRoot = { kind: "project", projectId: project.id } as const;
      detail.record.projectId = project.id;
      detail.runs[0]!.executionRoot = root;
      useBoard.setState({ projects: [project] });
      const resolver = createChatExecutionRootResolver({ homePath, projects, worktrees });
      await expect(resolver.resolve(owner, root)).resolves.toMatchObject({ ref: root });
      await expect(worktrees.deleteWorktree({ projectSlug: project.slug, worktreeId: root.worktreeId, ownerScope }))
        .resolves.toEqual({ ok: true });
      await expect(resolver.resolve(owner, root)).rejects.toThrow();
      const get = vi.fn(async (path: string) => {
        if (path === "/api/projects/matrix-os/worktrees") {
          const result = await worktrees.listWorktrees(project.slug, ownerScope);
          if (!result.ok) throw new Error("Fixture worktree inventory failed");
          return { worktrees: result.worktrees };
        }
        if (path === "/api/projects/matrix-os") return { project };
        throw new Error("Unexpected fixture request");
      });
      const admit = vi.mocked(client.admitTurn).getMockImplementation()!;
      vi.mocked(client.admitTurn).mockImplementation(async (chatId, input, options) => {
        if (!input.executionRoot) throw new Error("Fixture requires an explicit project root");
        await resolver.resolve(owner, input.executionRoot);
        return admit(chatId, input, options);
      });
      const listeners = new Set<(event: CanonicalChatInvalidation) => void>();
      const eventSource: Pick<CanonicalChatEventSource, "subscribe"> = {
        subscribe(listener) {
          listeners.add(listener);
          return { dispose: () => { listeners.delete(listener); } };
        },
      };
      render(<CanonicalChatWorkspace client={client} api={{ get } as unknown as ApiClient}
        projectId={project.id} initialChatId={detail.record.chat.id} initialView="conversation"
        active catalog={fixture.providerCatalog} eventSource={eventSource} />);
      const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
      await setSharedComposerText(editor, "Continue after removing the worktree.");
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      const chooseProject = await screen.findByRole("button", { name: "Use project checkout" });
      expect(client.admitTurn).not.toHaveBeenCalled();
      expect(editor.textContent).toBe("Continue after removing the worktree.");
      fireEvent.click(chooseProject);
      vi.mocked(client.admitTurn).mockRejectedValueOnce(new AppError("server", { httpStatus: 503 }));
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await screen.findByText("Message status is unconfirmed. You can retry safely.");
      expect(client.admitTurn).toHaveBeenCalledExactlyOnceWith(detail.record.chat.id,
        expect.objectContaining({ executionRoot: projectRoot,
          parts: [{ type: "text", text: "Continue after removing the worktree." }] }), { chatScope: "project" });
      const request = vi.mocked(client.admitTurn).mock.calls[0]![1];
      const renamed = { ...detail.record, chat: {
        ...detail.record.chat, title: "Renamed while confirming the send", revision: detail.record.chat.revision + 1,
      } };
      const priorReads = vi.mocked(client.getDetail).mock.calls.length;
      vi.mocked(client.list).mockResolvedValue({ items: [renamed] });
      vi.mocked(client.getDetail).mockResolvedValue({ ...detail, record: renamed });
      await act(async () => listeners.forEach(listener => listener({ type: "chat.full_refresh", cursor: 2 })));
      await waitFor(() => expect(vi.mocked(client.getDetail).mock.calls.length).toBeGreaterThan(priorReads));
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(client.admitTurn).toHaveBeenCalledTimes(2));
      expect(vi.mocked(client.admitTurn).mock.calls[1]![1]).toEqual(request);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
