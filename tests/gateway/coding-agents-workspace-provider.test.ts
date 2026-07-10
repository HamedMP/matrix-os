import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AgentThreadEventSchema,
  AgentThreadSnapshotSchema,
  AgentThreadSummarySchema,
  type AgentThreadEvent,
} from "../../packages/contracts/src/index.js";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import {
  createWorkspaceCodingAgentProvider,
  createWorkspaceCodingAgentProviders,
} from "../../packages/gateway/src/coding-agents/workspace-provider.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";

const ownerPrincipal: RequestPrincipal = { userId: "owner_user", source: "jwt" };
const baseNow = new Date("2026-07-06T12:00:00.000Z");

const createBody = {
  providerId: "codex",
  prompt: "Inspect the failing tests and propose a small fix.",
  projectId: "repo-main",
  taskId: "task_abc123",
  worktreeId: "wt_abc123def456",
  mode: "default",
  approvalPolicy: "on_request",
  sandboxMode: "workspace_write",
  clientRequestId: "req_workspace_1",
} as const;

function workspaceSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "sess_workspace_1",
    kind: "agent",
    projectSlug: "repo-main",
    taskId: "task_abc123",
    worktreeId: "wt_abc123def456",
    agent: "codex",
    runtime: {
      type: "zellij",
      status: "running",
      zellijSession: "matrix-agent-workspace-1",
    },
    terminalSessionId: "term_sess_workspace_1",
    ...overrides,
  };
}

describe("coding agent workspace provider", () => {
  it("creates one provider adapter per configured workspace agent", () => {
    const runtime = {
      startSession: vi.fn(),
      stopSession: vi.fn(),
    };

    const providers = createWorkspaceCodingAgentProviders({
      agents: ["claude", "codex"],
      runtime,
    });

    expect(providers.map((provider) => provider.providerId)).toEqual(["claude", "codex"]);
  });

  it("starts the selected Claude provider through the shared workspace runtime", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-workspace-provider-"));
    const runtime = {
      startSession: vi.fn(async () => ({
        ok: true,
        status: 201,
        session: workspaceSession({ agent: "claude" }),
      })),
      stopSession: vi.fn(async () => ({ ok: true, session: workspaceSession() })),
    };
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => baseNow,
      providers: createWorkspaceCodingAgentProviders({
        agents: ["codex", "claude"],
        runtime,
      }),
    });

    const created = await threads.createThread(ownerPrincipal, {
      ...createBody,
      providerId: "claude",
      clientRequestId: "req_workspace_claude_1",
    });

    expect(runtime.startSession).toHaveBeenCalledWith({
      ownerScope: { type: "user", id: "owner_user" },
      request: expect.objectContaining({
        agent: "claude",
        kind: "agent",
        prompt: createBody.prompt,
        runtimePreference: "zellij",
      }),
    });
    expect(created.snapshot.thread).toMatchObject({
      providerId: "claude",
      status: "running",
    });
  });

  it("starts a workspace agent session and binds the terminal reference to the stored thread", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-workspace-provider-"));
    const runtime = {
      startSession: vi.fn(async () => ({ ok: true, status: 201, session: workspaceSession() })),
      stopSession: vi.fn(async () => ({ ok: true, session: workspaceSession({ runtime: { type: "zellij", status: "exited" } }) })),
    };
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => baseNow,
      providers: [
        createWorkspaceCodingAgentProvider({
          providerId: "codex",
          agent: "codex",
          runtime,
        }),
      ],
    });

    const created = await threads.createThread(ownerPrincipal, createBody);
    const snapshot = AgentThreadSnapshotSchema.parse(created.snapshot);

    expect(runtime.startSession).toHaveBeenCalledWith({
      ownerScope: { type: "user", id: "owner_user" },
      request: expect.objectContaining({
        agent: "codex",
        kind: "agent",
        projectSlug: "repo-main",
        taskId: "task_abc123",
        worktreeId: "wt_abc123def456",
        prompt: createBody.prompt,
        runtimePreference: "zellij",
        sessionId: expect.stringMatching(/^sess_[A-Za-z0-9_-]+$/),
        mode: "default",
        approvalPolicy: "on_request",
        sandboxMode: "workspace_write",
      }),
    });
    expect(snapshot.thread).toMatchObject({
      providerId: "codex",
      projectId: "repo-main",
      taskId: "task_abc123",
      terminalSessionId: "matrix-agent-workspace-1",
      status: "running",
      attention: "none",
    });
    expect(snapshot.events.items.map((event) => event.type)).toEqual([
      "thread.created",
      "thread.status",
      "terminal.bound",
      "assistant.text.delta",
    ]);
  });

  it("forwards structured review references to the workspace runtime session", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-workspace-provider-"));
    const runtime = {
      startSession: vi.fn(async () => ({ ok: true, status: 201, session: workspaceSession() })),
      stopSession: vi.fn(async () => ({ ok: true, session: workspaceSession({ runtime: { type: "zellij", status: "exited" } }) })),
    };
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => baseNow,
      providers: [
        createWorkspaceCodingAgentProvider({
          providerId: "codex",
          agent: "codex",
          runtime,
        }),
      ],
    });

    await threads.createThread(ownerPrincipal, {
      ...createBody,
      clientRequestId: "req_workspace_attachment_1",
      attachments: [
        {
          id: "review:rev_desktop_1:hunk:hunk_1",
          kind: "structured_ref",
          label: "Review hunk 1",
          path: "packages/gateway/src/coding-agents/routes.ts",
        },
      ],
    });

    expect(runtime.startSession).toHaveBeenCalledWith({
      ownerScope: { type: "user", id: "owner_user" },
      request: expect.objectContaining({
        attachments: [
          expect.objectContaining({
            kind: "structured_ref",
            label: "Review hunk 1",
            path: "packages/gateway/src/coding-agents/routes.ts",
          }),
        ],
      }),
    });
  });

  it("maps workspace session startup failures to safe thread errors", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-workspace-provider-"));
    const runtime = {
      startSession: vi.fn(async () => ({
        ok: false,
        status: 503,
        error: { code: "runtime_unavailable", message: "zellij failed in /home/matrix/private" },
      })),
      stopSession: vi.fn(async () => ({ ok: true, session: workspaceSession() })),
    };
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => baseNow,
      providers: [
        createWorkspaceCodingAgentProvider({
          providerId: "codex",
          agent: "codex",
          runtime,
        }),
      ],
    });

    const created = await threads.createThread(ownerPrincipal, createBody);

    expect(created.snapshot.thread).toMatchObject({ status: "failed", attention: "failed" });
    expect(created.snapshot.events.items.map((event) => event.type)).toEqual([
      "thread.created",
      "thread.error",
      "thread.completed",
    ]);
    expect(JSON.stringify(created.snapshot)).not.toMatch(/zellij|\/home\/matrix|private/);
  });

  it("aborts the deterministic workspace session for a thread", async () => {
    const runtime = {
      startSession: vi.fn(async () => ({ ok: true, status: 201, session: workspaceSession() })),
      stopSession: vi.fn(async () => ({ ok: true, session: workspaceSession({ runtime: { type: "zellij", status: "exited" } }) })),
    };
    const provider = createWorkspaceCodingAgentProvider({
      providerId: "codex",
      agent: "codex",
      runtime,
    });
    const thread = AgentThreadSummarySchema.parse({
      id: "thread_workspace_1",
      providerId: "codex",
      title: "Coding agent run",
      status: "running",
      attention: "none",
      terminalSessionId: "matrix-agent-workspace-1",
      createdAt: baseNow.toISOString(),
      updatedAt: baseNow.toISOString(),
    });
    let eventIndex = 0;
    const events = await provider.abortThread?.({
      principal: ownerPrincipal,
      thread,
      clientRequestId: "req_abort_workspace",
      now: () => baseNow,
      nextEventId: () => `evt_abort_${++eventIndex}`,
    });

    expect(runtime.stopSession).toHaveBeenCalledWith("sess_workspace_1");
    expect((events ?? []).map((event: AgentThreadEvent) => AgentThreadEventSchema.parse(event).type)).toEqual([
      "thread.status",
      "thread.completed",
    ]);
    expect(events?.at(-1)).toMatchObject({ type: "thread.completed", outcome: "aborted" });
  });
});
