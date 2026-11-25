// @vitest-environment jsdom

import React from "react";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalChatDetailResponse, CanonicalCreateChatTurnRequest } from "@matrix-os/contracts";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { createCanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useProviderPreferences } from "@desktop/renderer/src/features/settings/provider-preferences";
import { useRetainedComposerDrafts } from "@desktop/renderer/src/features/chat/retained-composer-drafts";
import { useCanonicalChatRouteController } from "@desktop/renderer/src/features/chat/use-canonical-chat-route-controller";
import { AppError } from "@desktop/shared/app-error";
import { isHistoricalWorktreeMissing, withChatContinuationRoot } from "@desktop/renderer/src/features/chat/canonical-chat-continuation-root";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { createChatExecutionRootResolver } from "../../packages/gateway/src/chat/execution-root";
import { createProjectManager } from "../../packages/gateway/src/project-manager";
import { createWorktreeManager } from "../../packages/gateway/src/worktree-manager";
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

  it.each(["project_new", null])("sends an ordinary reply after the owner changes project scope to %s", async projectId => {
    const fixture = worktreeFixture();
    const { projectId: originalProjectId, ...unassignedRecord } = fixture.detail.record;
    const chatId = fixture.detail.record.chat.id;
    const baseRevision = fixture.detail.record.chat.revision;
    const baseMessageSeq = fixture.detail.record.chat.messageCount;
    const movedRecord = { ...unassignedRecord,
      chat: { ...unassignedRecord.chat, revision: baseRevision + 1 },
      ...(projectId === null ? {} : { projectId }),
    };
    let persisted = fixture.detail;
    const patch = vi.fn(async (_path: string, _body: unknown) => {
      persisted = { ...persisted, record: movedRecord };
      return movedRecord;
    });
    const { snapshot: accepted } = createCanonicalChatFixture("accepted");
    const [message] = accepted.messages;
    const [turn] = accepted.turns;
    const [run] = accepted.runs;
    const effectiveRoot = projectId === null ? undefined : { kind: "project", projectId };
    const post = vi.fn(async (_path: string, input: CanonicalCreateChatTurnRequest) => ({
      admission: "accepted",
      record: { ...movedRecord, chat: { ...movedRecord.chat, revision: baseRevision + 2, messageCount: baseMessageSeq + 1 },
        activeRun: accepted.chat.activeRun },
      message: { ...message!, chatId, seq: baseMessageSeq + 1, parts: input.parts },
      turn: { ...turn!, chatId, baseMessageSeq, clientRequestId: input.clientRequestId },
      run: { ...run!, chatId, historyBoundarySeq: baseMessageSeq, executionRoot: effectiveRoot,
        executionRootFingerprint: effectiveRoot ? run!.executionRootFingerprint : undefined },
    }));
    const transport = { get: async () => persisted, patch, post, delete: vi.fn() };
    const { updateProject, getDetail, admitTurn } = createCanonicalChatClient(
      transport as Pick<ApiClient, "get" | "post" | "patch" | "delete">,
      { trackEvent: vi.fn() },
    );
    const client = { ...fixture.client, updateProject, getDetail, admitTurn };
    const open = (scope: string | null) => renderHook(() => useCanonicalChatRouteController({
      client, projectId: scope, active: true, initialChatId: chatId,
    }));
    const original = open(originalProjectId ?? null);
    await waitFor(() => expect(original.result.current.detail?.runs[0]?.executionRoot).toEqual(worktree));
    await act(async () => { expect(await original.result.current.moveProject(projectId)).toEqual(movedRecord); });
    expect(patch).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`/api/chats/${chatId}/project?`), { baseRevision, projectId },
    );
    original.unmount();

    const moved = open(projectId);
    await waitFor(() => expect(moved.result.current.detail?.record).toEqual(movedRecord));
    expect(moved.result.current.detail?.runs[0]?.executionRoot).toEqual(worktree);
    const parts = [{ type: "text" as const, text: "Reply in the new scope." }];
    await act(async () => {
      const receipt = await moved.result.current.submitTurn({ parts,
        selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
        interactionMode: "default", permissionMode: "supervised" }, "Follow-up");
      expect(receipt).toMatchObject({ admission: "accepted", message: { id: message!.id, parts },
        turn: { id: turn!.id }, run: { id: run!.id } });
      expect(receipt?.run.executionRoot).toEqual(effectiveRoot);
    });
    expect(post).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`/api/chats/${chatId}/turns?`),
      expect.objectContaining({ baseRevision: baseRevision + 1, parts }),
      expect.anything(),
    );
    // Omitting the historical root selects the current project or owner home at the gateway.
    expect(post.mock.calls[0]![1]).not.toHaveProperty("executionRoot");
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
      render(<CanonicalChatWorkspace client={client} api={{ get } as unknown as ApiClient}
        projectId={project.id} initialChatId={detail.record.chat.id} initialView="conversation"
        active catalog={fixture.providerCatalog} />);
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
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(client.admitTurn).toHaveBeenCalledTimes(2));
      expect(vi.mocked(client.admitTurn).mock.calls[1]![1]).toEqual(request);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("does not resurrect an earlier worktree after a deliberate project-root run", async () => {
    const fixture = worktreeFixture();
    fixture.detail.runs.push({ ...fixture.detail.runs[0]!, id: "run_project_root",
      executionRoot: { kind: "project", projectId: "matrix-os" } });
    openWorkspace(fixture);
    const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
    await setSharedComposerText(editor, "Continue at the selected project root.");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fixture.client.admitTurn).toHaveBeenCalledOnce());
    expect(vi.mocked(fixture.client.admitTurn).mock.calls[0]![1]).not.toHaveProperty("executionRoot");
  });

  it.each([404, 503])("keeps the worktree draft when the server rejects it with %i", async httpStatus => {
    const fixture = worktreeFixture();
    vi.mocked(fixture.client.admitTurn).mockRejectedValue(new AppError("server", { httpStatus }));
    openWorkspace(fixture);
    const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
    await setSharedComposerText(editor, "Do not fall back to the project checkout.");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("alert");
    expect(fixture.client.admitTurn).toHaveBeenCalledOnce();
    expect(vi.mocked(fixture.client.admitTurn).mock.calls[0]![1].executionRoot).toEqual(worktree);
    expect(editor.textContent).toBe("Do not fall back to the project checkout.");
    if (httpStatus === 503) {
      const request = vi.mocked(fixture.client.admitTurn).mock.calls[0]![1];
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(fixture.client.admitTurn).toHaveBeenCalledTimes(2));
      expect(vi.mocked(fixture.client.admitTurn).mock.calls[1]![1]).toEqual(request);
      expect(editor.textContent).toBe("Do not fall back to the project checkout.");
    }
  });

  it("allocates no request ID when a worktree check finishes after leaving the Chat", async () => {
    const { client, detail, providerCatalog } = worktreeFixture();
    const project = { id: worktree.projectId, slug: "matrix-os", name: "Matrix OS", kind: "scratch" as const };
    useBoard.setState({ projects: [project] });
    let finishInventory!: (value: { worktrees: [] }) => void;
    const inventory = new Promise<{ worktrees: [] }>(resolve => { finishInventory = resolve; });
    const get = vi.fn(async (path: string) => {
      if (path === "/api/projects/matrix-os/worktrees") return inventory;
      throw new Error("Unexpected fixture request");
    });
    const api = { get } as unknown as ApiClient;
    const workspace = (active: boolean) => <CanonicalChatWorkspace client={client} api={api}
      projectId={project.id} initialChatId={detail.record.chat.id} initialView="conversation"
      active={active} catalog={providerCatalog} />;
    const view = render(workspace(true));
    const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
    await setSharedComposerText(editor, "Keep this draft.");
    const requestId = vi.spyOn(crypto, "randomUUID");
    try {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(get).toHaveBeenCalledWith("/api/projects/matrix-os/worktrees", expect.anything()));
      view.rerender(workspace(false));
      await act(async () => { finishInventory({ worktrees: [] }); });
      expect(client.admitTurn).not.toHaveBeenCalled();
      expect(requestId).not.toHaveBeenCalled();
    } finally {
      requestId.mockRestore();
    }
  });

  it("keeps the exact worktree request when the worktree disappears after an unconfirmed send", async () => {
    const fixture = worktreeFixture();
    const project = { id: worktree.projectId, slug: "matrix-os", name: "Matrix OS", kind: "scratch" as const };
    useBoard.setState({ projects: [project] });
    let deleted = false;
    const get = vi.fn(async (path: string) => {
      if (path === "/api/projects/matrix-os/worktrees") {
        return { worktrees: deleted ? [] : [{ id: worktree.worktreeId, projectSlug: project.slug }] };
      }
      if (path === "/api/projects/matrix-os") return { project };
      throw new Error("Unexpected fixture request");
    });
    const { client } = fixture;
    vi.mocked(client.admitTurn).mockRejectedValue(new AppError("server", { httpStatus: 503 }));
    render(<CanonicalChatWorkspace client={client} api={{ get } as unknown as ApiClient}
      projectId={project.id} initialChatId={fixture.detail.record.chat.id} initialView="conversation"
      active catalog={fixture.providerCatalog} />);
    const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
    await setSharedComposerText(editor, "Continue the original request.");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Message status is unconfirmed. You can retry safely.");
    const request = vi.mocked(client.admitTurn).mock.calls[0]![1];
    expect(request.executionRoot).toEqual(worktree);
    deleted = true;
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(client.admitTurn).toHaveBeenCalledTimes(2));
    expect(vi.mocked(client.admitTurn).mock.calls[1]![1]).toEqual(request);
    expect(screen.queryByRole("button", { name: "Use project checkout" })).toBeNull();
  });

  it("never dispatches with the previous Chat's root while navigation is loading", async () => {
    const fixture = worktreeFixture();
    const { result } = renderHook(() => useCanonicalChatRouteController({ client: fixture.client,
      projectId: "matrix-os", active: true, initialChatId: fixture.detail.record.chat.id }));
    await waitFor(() => expect(result.current.detail?.record.chat.id).toBe(fixture.detail.record.chat.id));
    const staleSubmit = result.current.submitTurn;
    let finishLoad!: (detail: CanonicalChatDetailResponse) => void;
    vi.mocked(fixture.client.getDetail).mockImplementationOnce(() => new Promise(resolve => { finishLoad = resolve; }));
    act(() => result.current.selectChat("chat_other"));
    const input = { parts: [{ type: "text", text: "Continue only the selected Chat." }] as const,
      selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
      interactionMode: "default" as const, permissionMode: "full_access" as const };
    await act(async () => { await staleSubmit({ ...input, parts: [...input.parts] }, "Follow-up"); });
    expect(fixture.client.admitTurn).not.toHaveBeenCalled();
    const next: CanonicalChatDetailResponse = { ...fixture.detail,
      record: { ...fixture.detail.record, chat: { ...fixture.detail.record.chat, id: "chat_other" } },
      runs: [{ ...fixture.detail.runs[0]!, chatId: "chat_other",
        executionRoot: { ...worktree, worktreeId: "wt_00000000000b" } }] };
    await act(async () => finishLoad(next));
    await act(async () => { await result.current.submitTurn({ ...input, parts: [...input.parts] }, "Follow-up"); });
    expect(fixture.client.admitTurn).toHaveBeenCalledWith("chat_other",
      expect.objectContaining({ executionRoot: next.runs[0]!.executionRoot, permissionMode: "full_access" }),
      { chatScope: "project" });
  });

  it("resets the inherited worktree when starting a new Chat", async () => {
    const fixture = worktreeFixture();
    const { result } = renderHook(() => useCanonicalChatRouteController({ client: fixture.client,
      projectId: "matrix-os", active: true, initialChatId: fixture.detail.record.chat.id }));
    await waitFor(() => expect(result.current.detail).not.toBeNull());
    vi.mocked(fixture.client.create).mockResolvedValue({ ...fixture.detail.record,
      chat: { ...fixture.detail.record.chat, id: "chat_new" } });
    act(() => result.current.selectChat(null));
    await act(async () => { await result.current.submitTurn({ parts: [{ type: "text", text: "A fresh Chat." }],
      selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
      interactionMode: "default", permissionMode: "full_access" }, "New Chat"); });
    expect(fixture.client.create).toHaveBeenCalledOnce();
    expect(fixture.client.admitTurn).toHaveBeenCalledWith("chat_new",
      expect.objectContaining({ permissionMode: "full_access" }), { chatScope: "project" });
    expect(vi.mocked(fixture.client.admitTurn).mock.calls[0]![1]).not.toHaveProperty("executionRoot");
  });
});

const input: Omit<CanonicalCreateChatTurnRequest, "clientRequestId" | "baseRevision"> = {
  parts: [{ type: "text", text: "Continue here." }], selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
  interactionMode: "default", permissionMode: "full_access",
};
function context(state: "running" | "completed" = "completed"): CanonicalChatDetailResponse {
  const { snapshot } = createCanonicalChatFixture(state);
  const { project, providerBinding, activeRun, ...chat } = snapshot.chat;
  return { record: { chat, projectId: project.projectId, providerBinding, ...(activeRun ? { activeRun } : {}) },
    messages: snapshot.messages, turns: snapshot.turns,
    runs: snapshot.runs.map(run => ({ ...run, executionRoot: worktree })), activities: [] };
}

describe("canonical Chat continuation scope", () => {
  it.each([
    { result: { worktrees: [] }, projectId: "replacement_project" },
    { result: { worktrees: [{ id: "unreadable", projectSlug: "matrix-os" }] }, projectId: worktree.projectId },
    { result: { worktrees: [{ id: "wt_00000000000b", projectSlug: "different-project" }] }, projectId: worktree.projectId },
    { result: undefined, projectId: worktree.projectId },
  ])("requires an intact inventory and the same project identity before offering recovery", async ({ result, projectId }) => {
    const get = vi.fn(async (path: string) => {
      if (path.endsWith("/worktrees")) {
        if (!result) throw new AppError("server", { httpStatus: 503 });
        return result;
      }
      return { project: { id: projectId, slug: "matrix-os" } };
    });
    await expect(isHistoricalWorktreeMissing({ get } as unknown as ApiClient, "matrix-os", worktree, () => true))
      .resolves.toBe(false);
  });

  it("preserves an explicit project/skill selection over the inherited worktree", () => {
    const detail = context();
    const explicit = { ...input, executionRoot: { kind: "project", projectId: "matrix-os" } as const };
    expect(withChatContinuationRoot(explicit, detail, detail.record.chat.id)).toBe(explicit);
  });

  it("uses the active run's binding rather than a different historical run", () => {
    const detail = context("running");
    detail.runs.push({ ...detail.runs[0]!, id: "run_history", executionRoot: { kind: "project", projectId: "matrix-os" } });
    expect(withChatContinuationRoot(input, detail, detail.record.chat.id)).toEqual({ ...input, executionRoot: worktree });
    expect(input).not.toHaveProperty("executionRoot");
  });

  it.each(["missing active run", "foreign active turn", "foreign Chat", "changed project", "removed project"])("refuses %s without a project-root fallback", invalid => {
    const detail = context("running");
    if (invalid === "missing active run") detail.runs = [];
    if (invalid === "foreign active turn") detail.runs[0]!.turnId = "turn_foreign";
    if (invalid === "foreign Chat") detail.runs[0]!.chatId = "chat_foreign";
    if (invalid === "changed project") detail.record.projectId = "project_foreign";
    if (invalid === "removed project") delete detail.record.projectId;
    expect(() => withChatContinuationRoot(input, detail, detail.record.chat.id)).toThrow(AppError);
  });

  it.each(["project_new", undefined])("refuses an explicit stale worktree after a change to %s", projectId => {
    const detail = context();
    detail.record.projectId = projectId;
    expect(() => withChatContinuationRoot({ ...input, executionRoot: worktree }, detail, detail.record.chat.id)).toThrow(AppError);
  });

  it("preserves an explicit worktree that still belongs to the Chat's project", () => {
    const detail = context();
    const explicit = { ...input, executionRoot: worktree };
    expect(withChatContinuationRoot(explicit, detail, detail.record.chat.id)).toBe(explicit);
  });

  it("rejects missing or different selected-Chat detail, including explicit roots", () => {
    const detail = context();
    expect(() => withChatContinuationRoot(input, null, detail.record.chat.id)).toThrow(AppError);
    expect(() => withChatContinuationRoot({ ...input, executionRoot: worktree }, detail, "chat_other")).toThrow(AppError);
  });

  it("leaves new, legacy and shared Chats on their existing admission path", () => {
    const detail = context();
    expect(withChatContinuationRoot(input, detail, null)).toBe(input);
    delete detail.runs[0]!.executionRoot;
    expect(withChatContinuationRoot(input, detail, detail.record.chat.id)).toBe(input);
    detail.runs[0]!.executionRoot = worktree;
    detail.record.chat.ownerScope = { type: "organization", ownerId: "org_shared" };
    expect(withChatContinuationRoot(input, detail, detail.record.chat.id)).toBe(input);
  });

  it("continues an explicitly private Chat without inheriting shared or Bot workspace policy", () => {
    const detail = context();
    detail.record.chat.collaboration = { mode: "private" };
    expect(withChatContinuationRoot(input, detail, detail.record.chat.id)).toEqual({ ...input, executionRoot: worktree });
    detail.record.chat.collaboration = { mode: "shared", membership: { role: "owner", memberCount: 2 } };
    expect(withChatContinuationRoot(input, detail, detail.record.chat.id)).toBe(input);
    delete detail.record.chat.collaboration;
    detail.runs[0]!.executionRoot = { kind: "bot_workspace", botId: "bot_00000000" };
    expect(withChatContinuationRoot(input, detail, detail.record.chat.id)).toBe(input);
  });
});
