import { describe, expect, it, vi } from "vitest";
import { createWorkspaceEventPublisher } from "../../packages/gateway/src/workspace-event-publisher.js";

describe("workspace event publisher", () => {
  it("publishes task, preview, and session lifecycle events through one helper", async () => {
    const eventStore = {
      publishEvent: vi.fn(async () => ({ ok: true, event: { id: "evt_abc123" } })),
    };
    const publisher = createWorkspaceEventPublisher({ eventStore });

    await publisher.publishTaskCreated({
      id: "task_abc123",
      projectSlug: "repo",
      title: "Fix auth",
      status: "running",
    });
    await publisher.publishPreviewUpdated({
      id: "prev_abc123",
      projectSlug: "repo",
      taskId: "task_abc123",
      sessionId: "sess_abc123",
      lastStatus: "ok",
      updatedAt: "2026-04-29T00:00:00.000Z",
    });
    await publisher.publishSessionStarted({
      id: "sess_abc123",
      kind: "agent",
      projectSlug: "repo",
      taskId: "task_abc123",
      worktreeId: "wt_abc123def456",
      pr: 42,
      agent: "codex",
      runtime: { type: "zellij", status: "running" },
      terminalSessionId: "term_sess_abc123",
    });
    await publisher.publishSessionStopped({
      id: "sess_abc123",
      kind: "agent",
      projectSlug: "repo",
      taskId: "task_abc123",
      worktreeId: "wt_abc123def456",
      pr: 42,
      agent: "codex",
      runtime: { type: "zellij", status: "exited" },
      terminalSessionId: "term_sess_abc123",
    });

    expect(eventStore.publishEvent).toHaveBeenNthCalledWith(1, {
      type: "task.created",
      scope: { projectSlug: "repo", taskId: "task_abc123" },
      payload: { title: "Fix auth", status: "running" },
    });
    expect(eventStore.publishEvent).toHaveBeenNthCalledWith(2, {
      type: "preview.updated",
      scope: {
        projectSlug: "repo",
        taskId: "task_abc123",
        sessionId: "sess_abc123",
        previewId: "prev_abc123",
      },
      payload: { lastStatus: "ok", updatedAt: "2026-04-29T00:00:00.000Z" },
    });
    expect(eventStore.publishEvent).toHaveBeenNthCalledWith(3, {
      type: "session.started",
      scope: {
        projectSlug: "repo",
        taskId: "task_abc123",
        sessionId: "sess_abc123",
      },
      payload: {
        agent: "codex",
        kind: "agent",
        pr: 42,
        runtimeStatus: "running",
        terminalSessionId: "term_sess_abc123",
        worktreeId: "wt_abc123def456",
      },
    });
    expect(eventStore.publishEvent).toHaveBeenNthCalledWith(4, {
      type: "session.stopped",
      scope: {
        projectSlug: "repo",
        taskId: "task_abc123",
        sessionId: "sess_abc123",
      },
      payload: {
        agent: "codex",
        kind: "agent",
        pr: 42,
        runtimeStatus: "exited",
        terminalSessionId: "term_sess_abc123",
        worktreeId: "wt_abc123def456",
      },
    });
  });

  it("logs and suppresses event-store failures so mutations keep their own result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const eventStore = {
      publishEvent: vi.fn(async () => ({
        ok: false,
        status: 400,
        error: { code: "invalid_event_scope", message: "Workspace event scope is invalid" },
      })),
    };
    const publisher = createWorkspaceEventPublisher({ eventStore });

    await expect(publisher.publishTaskDeleted("repo", "task_abc123")).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith("[workspace-event-publisher] Failed to publish workspace event:", "invalid_event_scope");
  });

  it("logs and suppresses thrown event-store errors after primary mutations", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const eventStore = {
      publishEvent: vi.fn(async () => {
        throw new Error("disk full");
      }),
    };
    const publisher = createWorkspaceEventPublisher({ eventStore });

    await expect(publisher.publishTaskDeleted("repo", "task_abc123")).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith("[workspace-event-publisher] Unexpected workspace event publish error:", "disk full");
  });
});
