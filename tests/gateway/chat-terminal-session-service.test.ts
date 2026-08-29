import { describe, expect, it, vi } from "vitest";
import { createChatTerminalSessionService } from "../../packages/gateway/src/chat/terminal-session-service.js";

describe("Chat terminal session service", () => {
  it("resolves an owned worktree to a home-relative terminal cwd", async () => {
    const repository = {
      getLatestRunForTerminalBinding: vi.fn(async () => ({
        id: "run_selected",
        executionRoot: { kind: "worktree", projectId: "project_stable", worktreeId: "wt_owned" },
      })),
      getChatForTerminalBinding: vi.fn(async () => null),
      bindTerminalSession: vi.fn(async () => true),
    };
    const executionRoots = {
      resolve: vi.fn(async () => ({
        primaryWorkspaceRoot: "/home/matrix/worktrees/matrix-os/wt_owned",
      })),
    };
    const service = createChatTerminalSessionService({
      homePath: "/home/matrix",
      repository,
      executionRoots,
    });

    await expect(service.prepare(
      { userId: "owner_test", source: "jwt" },
      "chat_selected",
    )).resolves.toEqual({
      runId: "run_selected",
      cwd: "worktrees/matrix-os/wt_owned",
    });
    expect(executionRoots.resolve).toHaveBeenCalledWith(
      { type: "personal", ownerId: "owner_test" },
      { kind: "worktree", projectId: "project_stable", worktreeId: "wt_owned" },
    );

    await service.bind(
      { userId: "owner_test", source: "jwt" },
      {
        chatId: "chat_selected",
        runId: "run_selected",
        sessionId: "chat-calm-otter",
        sessionCreatedAt: "2026-08-28T10:00:00.000Z",
      },
    );
    expect(repository.bindTerminalSession).toHaveBeenCalledWith(
      { type: "personal", ownerId: "owner_test" },
      {
        chatId: "chat_selected",
        runId: "run_selected",
        sessionId: "chat-calm-otter",
        sessionCreatedAt: "2026-08-28T10:00:00.000Z",
      },
    );
  });

  it("uses the Matrix home for Global Chat terminals", async () => {
    const repository = {
      getLatestRunForTerminalBinding: vi.fn(async () => ({ id: "run_global" })),
      getChatForTerminalBinding: vi.fn(async () => null),
      bindTerminalSession: vi.fn(async () => true),
    };
    const executionRoots = { resolve: vi.fn() };
    const service = createChatTerminalSessionService({
      homePath: "/home/matrix",
      repository,
      executionRoots,
    });

    await expect(service.prepare(
      { userId: "owner_test", source: "jwt" },
      "chat_global",
    )).resolves.toEqual({ runId: "run_global" });
    expect(executionRoots.resolve).not.toHaveBeenCalled();
  });

  it("uses the Matrix home for an empty Global Chat before its first run", async () => {
    const repository = {
      getLatestRunForTerminalBinding: vi.fn(async () => null),
      getChatForTerminalBinding: vi.fn(async () => ({})),
      bindTerminalSession: vi.fn(async () => true),
    };
    const executionRoots = { resolve: vi.fn() };
    const service = createChatTerminalSessionService({
      homePath: "/home/matrix",
      repository,
      executionRoots,
    });

    await expect(service.prepare(
      { userId: "owner_test", source: "jwt" },
      "chat_empty_global",
    )).resolves.toEqual({});
    expect(repository.getChatForTerminalBinding).toHaveBeenCalledWith(
      { type: "personal", ownerId: "owner_test" },
      "chat_empty_global",
    );
    expect(executionRoots.resolve).not.toHaveBeenCalled();
  });

  it("prepares an empty Project Chat terminal from the Project root before its first run", async () => {
    const repository = {
      getLatestRunForTerminalBinding: vi.fn(async () => null),
      getChatForTerminalBinding: vi.fn(async () => ({ projectId: "project_stable" })),
      bindTerminalSession: vi.fn(async () => true),
    };
    const executionRoots = {
      resolve: vi.fn(async () => ({ primaryWorkspaceRoot: "/home/matrix/projects/matrix-os" })),
    };
    const service = createChatTerminalSessionService({
      homePath: "/home/matrix",
      repository,
      executionRoots,
    });

    await expect(service.prepare(
      { userId: "owner_test", source: "jwt" },
      "chat_empty_project",
    )).resolves.toEqual({ cwd: "projects/matrix-os" });
    expect(executionRoots.resolve).toHaveBeenCalledWith(
      { type: "personal", ownerId: "owner_test" },
      { kind: "project", projectId: "project_stable" },
    );

    await service.bind(
      { userId: "owner_test", source: "jwt" },
      {
        chatId: "chat_empty_project",
        sessionId: "chat-draft-terminal",
        sessionCreatedAt: "2026-08-28T10:05:00.000Z",
      },
    );
    expect(repository.bindTerminalSession).toHaveBeenCalledWith(
      { type: "personal", ownerId: "owner_test" },
      {
        chatId: "chat_empty_project",
        sessionId: "chat-draft-terminal",
        sessionCreatedAt: "2026-08-28T10:05:00.000Z",
      },
    );
  });
});
