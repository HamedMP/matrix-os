import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AgentThreadEventSchema,
  AgentThreadSnapshotSchema,
  AgentThreadSummarySchema,
  SafeSetupActionSchema,
  type AgentThreadEvent,
} from "../../packages/contracts/src/index.js";
import { createCodingAgentProviderRegistry } from "../../packages/gateway/src/coding-agents/provider-registry.js";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import {
  createWorkspaceCodingAgentProvider,
  createWorkspaceCodingAgentProviderSet,
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
  it.each([
    ["claude", "@anthropic-ai/claude-code@latest", "claude"],
    ["codex", "@openai/codex@latest", "codex login"],
  ] as const)("returns bounded foreground install and connect actions for %s", async (
    agent,
    installPackage,
    connectCommand,
  ) => {
    const provider = createWorkspaceCodingAgentProvider({
      providerId: agent,
      agent,
      runtime: {
        startSession: vi.fn(),
        stopSession: vi.fn(),
      },
    });

    const actions = await provider.buildSetupAction?.({
      principal: ownerPrincipal,
      now: () => baseNow,
      signal: AbortSignal.timeout(1_000),
    });

    expect(actions).toHaveLength(2);
    expect(actions?.map((action) => SafeSetupActionSchema.parse(action))).toEqual([
      expect.objectContaining({
        id: `${agent}_install`,
        kind: "foreground_terminal",
        label: `Install ${agent === "claude" ? "Claude" : "Codex"}`,
        command: expect.stringContaining(installPackage),
      }),
      expect.objectContaining({
        id: `${agent}_connect`,
        kind: "foreground_terminal",
        label: `Connect ${agent === "claude" ? "Claude" : "Codex"}`,
        command: expect.stringContaining(connectCommand),
      }),
    ]);
    for (const action of actions ?? []) {
      expect(action.command).toContain(
        'MATRIX_NODE_PREFIX="${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}"',
      );
      expect(action.command).toContain('PATH="$MATRIX_NODE_PREFIX/bin:$PATH"');
    }
    expect(JSON.stringify(actions)).not.toMatch(/api[_ -]?key|bearer|token|secret|password/i);
  });

  it("projects setup actions through the registry for a missing configured provider", async () => {
    const provider = createWorkspaceCodingAgentProvider({
      providerId: "claude",
      agent: "claude",
      runtime: {
        startSession: vi.fn(),
        stopSession: vi.fn(),
      },
    });
    const registry = createCodingAgentProviderRegistry({
      providers: [provider],
      agentCredentials: {
        getStatus: vi.fn(async () => ({
          systemAgent: "hermes" as const,
          activeAgents: ["hermes"] as const,
          routingExplanation: "Provider state is runtime-owned.",
          agents: [{
            agent: "claude" as const,
            status: "missing" as const,
            coordinationRole: "core_agent" as const,
            workflows: ["core_agent" as const],
            degradedWorkflows: ["core_agent" as const],
            verifiedAt: null,
            nextAction: "Connect the configured provider",
          }],
        })),
      },
      now: () => baseNow,
    });

    const [summary] = await registry.listProviders(ownerPrincipal);

    expect(summary).toMatchObject({
      id: "claude",
      availability: "setup_required",
      installStatus: "missing",
      authStatus: "missing",
      setupActions: [
        expect.objectContaining({ id: "claude_install", kind: "foreground_terminal" }),
        expect.objectContaining({ id: "claude_connect", kind: "foreground_terminal" }),
      ],
    });
  });

  it("keeps Claude registry-visible but excludes it from executable providers until sandboxed", async () => {
    const runtime = {
      startSession: vi.fn(),
      stopSession: vi.fn(),
    };

    const providers = createWorkspaceCodingAgentProviderSet({
      agents: ["claude", "codex"],
      runtime,
    });

    expect(providers.registryProviders.map((provider) => provider.providerId)).toEqual(["claude", "codex"]);
    expect(providers.executionProviders.map((provider) => provider.providerId)).toEqual(["codex"]);

    const claude = providers.registryProviders[0]!;
    expect(await claude.getSummary?.({
      principal: ownerPrincipal,
      now: () => baseNow,
      signal: AbortSignal.timeout(1_000),
    })).toMatchObject({
      id: "claude",
      availability: "unavailable",
    });
    await expect(claude.startThread({
      principal: ownerPrincipal,
      thread: AgentThreadSummarySchema.parse({
        id: "thread_claude_blocked",
        providerId: "claude",
        title: "Coding agent run",
        status: "queued",
        attention: "none",
        projectId: createBody.projectId,
        taskId: createBody.taskId,
        createdAt: baseNow.toISOString(),
        updatedAt: baseNow.toISOString(),
      }),
      request: {
        ...createBody,
        providerId: "claude",
        clientRequestId: "req_workspace_claude_blocked",
      },
      now: () => baseNow,
      nextEventId: () => "event_claude_blocked",
    })).rejects.toThrow("Workspace provider execution unavailable");
    expect(runtime.startSession).not.toHaveBeenCalled();
  });

  it("rejects Claude thread starts without invoking the shared workspace runtime", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-workspace-provider-"));
    const runtime = {
      startSession: vi.fn(),
      stopSession: vi.fn(async () => ({ ok: true, session: workspaceSession() })),
    };
    const providers = createWorkspaceCodingAgentProviderSet({
      agents: ["codex", "claude"],
      runtime,
    });
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => baseNow,
      providers: providers.executionProviders,
    });

    await expect(threads.createThread(ownerPrincipal, {
      ...createBody,
      providerId: "claude",
      clientRequestId: "req_workspace_claude_1",
    })).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(runtime.startSession).not.toHaveBeenCalled();
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
