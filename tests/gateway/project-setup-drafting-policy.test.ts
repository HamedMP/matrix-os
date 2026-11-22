import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { AgentThreadSnapshotSchema } from "@matrix-os/contracts";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter.js";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import type { CanonicalCliSpawn } from "../../packages/gateway/src/chat/cli-process.js";
import type { CanonicalProviderRunInput } from "../../packages/gateway/src/chat/provider-adapter.js";

const occurredAt = "2026-11-22T00:00:00.000Z";
const setupContext = {
  version: 1 as const,
  requestHash: "a".repeat(64),
  chats: [],
  projectSetupDraft: { revision: 3 },
};

function input(permissionMode: string, setup: boolean): CanonicalProviderRunInput {
  return {
    owner: { type: "personal", ownerId: "owner_setup" },
    chatId: "chat_setup", turnId: "cturn_setup", runId: "run_setup",
    prompt: "Draft project guidance for review.",
    parts: [{ type: "text", text: "Draft project guidance for review." }],
    selection: { instanceId: "codex_default", model: "test-model" },
    interactionMode: "default", permissionMode, projectSlug: "project-setup",
    executionRoot: "/safe/project", signal: new AbortController().signal,
    ...(setup ? { context: setupContext } : {}),
  };
}

function codingThreads() {
  const snapshot = AgentThreadSnapshotSchema.parse({
    thread: {
      id: "thread_setup", providerId: "codex", title: "Project setup",
      status: "completed", attention: "none", projectId: "project-setup",
      createdAt: occurredAt, updatedAt: occurredAt,
    },
    events: {
      items: [{ type: "thread.completed", eventId: "evt_setup", threadId: "thread_setup", occurredAt, outcome: "completed" }],
      hasMore: false, limit: 200,
    },
  });
  const createThread = vi.fn(async () => ({ snapshot, existing: false }));
  const threads = {
    createThread,
    acceptTurn: vi.fn(async () => ({ threadId: "thread_setup", turnId: "turn_setup", status: "accepted" as const, acceptedAt: occurredAt })),
    getThread: vi.fn(async () => snapshot),
    latestTurnRequestId: vi.fn(async () => undefined),
    abortThread: vi.fn(async () => snapshot),
    steerTurn: vi.fn(async () => undefined),
    submitApproval: vi.fn(async () => snapshot),
    submitInput: vi.fn(async () => snapshot),
    registerEventSink: vi.fn(() => ({ dispose: vi.fn() })),
  } satisfies Parameters<typeof createCanonicalCodingChatProviderAdapter>[0]["threads"];
  return { threads, createThread };
}

function successfulClaudeProcess(): ReturnType<CanonicalCliSpawn> {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
    stdin: { write: (_chunk: string, callback?: (error?: Error | null) => void) => { callback?.(); return true; }, end: vi.fn() },
  });
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "result", subtype: "success", result: "Draft ready.", session_id: "session_setup" })}\n`));
    child.emit("exit", 0, null);
  });
  return child;
}

describe("project setup generation launch boundaries", () => {
  it.each(["supervised", "auto_accept_edits", "full_access"])("launches setup Codex read-only even when the saved choice is %s", async permissionMode => {
    const { threads, createThread } = codingThreads();
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads });
    const events = [];
    for await (const event of adapter.start(input(permissionMode, true))) events.push(event);
    expect(events).toContainEqual({ type: "run.completed", outcome: "completed" });
    expect(createThread).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sandboxMode: "read_only", approvalPolicy: "never" }));
  });

  it.each([
    ["supervised", "workspace_write", "on_request"],
    ["full_access", "full_access", "never"],
  ])("keeps normal Codex %s admission after setup", async (permissionMode, sandboxMode, approvalPolicy) => {
    const { threads, createThread } = codingThreads();
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads });
    for await (const _event of adapter.start(input(permissionMode, false))) { /* Drain the actual adapter. */ }
    expect(createThread).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sandboxMode, approvalPolicy }));
  });

  it.each([
    [true, "plan", "chat_discovery", false],
    [false, "bypassPermissions", "chat_call", true],
  ] as const)("uses Claude setup=%s permission and MCP scope", async (setup, mode, scope, fullAccess) => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: "owner_setup" });
    const issue = vi.spyOn(registry, "issue");
    const spawnFn = vi.fn<CanonicalCliSpawn>(() => successfulClaudeProcess());
    const adapter = createClaudeChatProviderAdapter({
      homePath: "/safe/home", spawnFn, resolveCredentialEnv: async () => ({}), matrixMcpCapabilityIssuer: registry,
    });
    try {
      const events = [];
      for await (const event of adapter.start({ ...input("full_access", setup), selection: { instanceId: "claude_code_default", model: "claude-test" } })) events.push(event);
      expect(events).toContainEqual({ type: "run.completed", outcome: "completed" });
      expect(spawnFn).toHaveBeenCalledOnce();
      const args = spawnFn.mock.calls[0]![1];
      expect(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", mode]);
      expect(issue).toHaveBeenCalledWith(expect.objectContaining({ scope, fullAccess }));
    } finally {
      registry.close();
    }
  });
});
