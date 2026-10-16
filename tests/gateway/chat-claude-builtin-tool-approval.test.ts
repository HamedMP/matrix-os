import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import { createClaudeInputController } from "../../packages/gateway/src/chat/claude-input-control.js";
import {
  CLAUDE_BUILTIN_TOOL_APPROVAL_TTL_MS,
  createClaudeBuiltinToolApprovalControl,
} from "../../packages/gateway/src/chat/claude-builtin-tool-approval.js";
import type { CustomMcpApprovalClient } from "../../packages/gateway/src/chat/custom-mcp-approval-client.js";
import type { CanonicalCliSpawn } from "../../packages/gateway/src/chat/cli-process.js";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";

const input = {
  owner: { type: "personal" as const, ownerId: "owner_claude" },
  chatId: "chat_1", turnId: "cturn_1", runId: "run_1",
  prompt: "Find the Matrix OS docs",
  parts: [{ type: "text" as const, text: "Find the Matrix OS docs" }],
  selection: { instanceId: "claude_code_default", model: "claude-sonnet-4-5" },
  interactionMode: "default" as const,
  permissionMode: "supervised" as const,
  signal: new AbortController().signal,
};

function spawnTool(toolName: string, toolInput: Record<string, unknown>, responses: unknown[]) {
  return vi.fn<CanonicalCliSpawn>(() => {
    const child = new EventEmitter() as ReturnType<CanonicalCliSpawn>;
    child.stdout = new EventEmitter() as typeof child.stdout;
    child.stderr = new EventEmitter() as typeof child.stderr;
    child.kill = vi.fn();
    child.stdin = { write(chunk: string, callback?: (error?: Error | null) => void) {
      callback?.();
      const frame = JSON.parse(chunk) as { type: string; response?: { response: unknown } };
      if (frame.type === "user") queueMicrotask(() => child.stdout!.emit("data", Buffer.from(`${JSON.stringify({
        type: "control_request", request_id: "native_web", request: { subtype: "can_use_tool",
          tool_name: toolName, input: toolInput },
      })}\n`)));
      if (frame.type === "control_response" && frame.response) {
        responses.push(frame.response.response);
        queueMicrotask(() => {
          child.stdout!.emit("data", Buffer.from(`${JSON.stringify({ type: "result", subtype: "success", result: "done" })}\n`));
          child.emit("exit", 0, null);
        });
      }
      return true;
    }, end() {} } as typeof child.stdin;
    return child;
  });
}

function approvalClient(verify: (input: unknown) => Promise<boolean>): CustomMcpApprovalClient {
  return { verifyIntegrationDecision: vi.fn(verify) } as unknown as CustomMcpApprovalClient;
}

describe("Claude Supervised built-in tool approval", () => {
  it("keeps the stdio callback from approving itself when nothing claims the tool", async () => {
    const frames: Array<{ response: { response: { behavior: string } } }> = [];
    const controller = createClaudeInputController({
      write: async frame => { frames.push(JSON.parse(frame) as typeof frames[number]); },
      emit: () => {},
      onToolPermission: () => false,
    });
    expect(controller.handle({ type: "control_request", request_id: "native_web", request: {
      subtype: "can_use_tool", tool_name: "WebSearch", input: { query: "matrix os" },
    } })).toBe(true);
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]?.response.response).toEqual({
      behavior: "deny", message: "Tool approval is unavailable in this Chat connection.",
    });
    expect(JSON.stringify(frames)).not.toContain("allow");
  });

  it("asks the owner before a Supervised WebSearch and continues only with a proven decision", async () => {
    const responses: unknown[] = [];
    const verify = vi.fn(async () => true);
    const adapter = createClaudeChatProviderAdapter({
      homePath: "/home/matrix/home", spawnFn: spawnTool("WebSearch", { query: "matrix os" }, responses),
      customMcpApprovalClient: approvalClient(verify), resolveCredentialEnv: async () => ({}),
    });
    const events: CanonicalProviderRunEvent[] = [];
    for await (const event of adapter.start(input)) {
      events.push(event);
      if (event.type !== "approval.requested") continue;
      expect(responses).toEqual([]);
      expect(event.title).toBe("Search the web · “matrix os”");
      expect(event.title).not.toContain("WebSearch");
      expect(event.safeDescription).toContain("Nothing is sent or changed.");
      expect(event.risk).toBe("low");
      expect(event.allowedDecisions).toEqual(["approve", "approve_for_session", "decline", "cancel"]);
      await expect(adapter.submitApproval?.({
        owner: { type: "personal", ownerId: "wrong_owner" }, chatId: input.chatId, runId: input.runId,
        approvalId: event.approvalId, decision: "approve", clientRequestId: "req_wrong",
        platformApprovalProof: "forged",
      })).rejects.toThrow();
      await expect(adapter.submitApproval?.({
        owner: input.owner, chatId: input.chatId, runId: input.runId,
        approvalId: event.approvalId, decision: "approve", clientRequestId: "req_1",
      })).rejects.toThrow();
      expect(responses).toEqual([]);
      await adapter.submitApproval?.({
        owner: input.owner, chatId: input.chatId, runId: input.runId,
        approvalId: event.approvalId, decision: "approve", clientRequestId: "req_1",
        platformApprovalProof: "signed-human-decision",
      });
    }
    expect(events.map(event => event.type)).toEqual(expect.arrayContaining(["approval.requested", "approval.resolved"]));
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "chat_1", runId: "run_1", decision: "approve", clientRequestId: "req_1",
      platformApprovalProof: "signed-human-decision",
    }));
    expect(responses).toEqual([{ behavior: "allow", updatedInput: { query: "matrix os" } }]);
  });

  it("tells the model when the owner declines", async () => {
    const responses: unknown[] = [];
    const verify = vi.fn(async () => true);
    const adapter = createClaudeChatProviderAdapter({
      homePath: "/home/matrix/home", spawnFn: spawnTool("WebFetch", { url: "https://example.com/docs" }, responses),
      customMcpApprovalClient: approvalClient(verify), resolveCredentialEnv: async () => ({}),
    });
    for await (const event of adapter.start(input)) {
      if (event.type !== "approval.requested") continue;
      expect(event.title).toBe("Open a web page · “example.com/docs”");
      await adapter.submitApproval?.({
        owner: input.owner, chatId: input.chatId, runId: input.runId,
        approvalId: event.approvalId, decision: "decline", clientRequestId: "req_decline",
        platformApprovalProof: "signed-decline",
      });
    }
    expect(responses).toEqual([{ behavior: "deny", message: "The owner declined this tool request." }]);
  });

  it("keeps the immediate denial when the run is not Supervised or no proof verifier exists", async () => {
    const unsupervised: unknown[] = [];
    const unsupervisedAdapter = createClaudeChatProviderAdapter({
      homePath: "/home/matrix/home", spawnFn: spawnTool("WebSearch", { query: "matrix os" }, unsupervised),
      customMcpApprovalClient: approvalClient(async () => true), resolveCredentialEnv: async () => ({}),
    });
    const unsupervisedEvents: string[] = [];
    for await (const event of unsupervisedAdapter.start({ ...input, permissionMode: "auto" })) unsupervisedEvents.push(event.type);
    expect(unsupervisedEvents).not.toContain("approval.requested");
    expect(unsupervised).toEqual([{ behavior: "deny", message: "Tool approval is unavailable in this Chat connection." }]);

    const unverified: unknown[] = [];
    const unverifiedAdapter = createClaudeChatProviderAdapter({
      homePath: "/home/matrix/home", spawnFn: spawnTool("WebSearch", { query: "matrix os" }, unverified),
      resolveCredentialEnv: async () => ({}),
    });
    const unverifiedEvents: string[] = [];
    for await (const event of unverifiedAdapter.start(input)) unverifiedEvents.push(event.type);
    expect(unverifiedEvents).not.toContain("approval.requested");
    expect(unverified).toEqual([{ behavior: "deny", message: "Tool approval is unavailable in this Chat connection." }]);
  });
});

describe("Claude built-in tool approval control", () => {
  function control(verify: (input: unknown) => Promise<boolean> = async () => true) {
    const events: CanonicalProviderRunEvent[] = [];
    const responses: unknown[] = [];
    const approval = createClaudeBuiltinToolApprovalControl({
      runId: "run_1", chatId: "chat_1", homePath: "/home/matrix/home",
      verify: vi.fn(verify),
      emit: event => { events.push(event); },
      onError: () => {},
    });
    return { approval, events, responses, respond: async (value: unknown) => { responses.push(value); } };
  }

  it("does not claim Matrix tool calls or approve when the proof is rejected", async () => {
    const { approval, events, responses, respond } = control(async () => false);
    expect(approval.onToolPermission({
      nativeRequestId: "native_mcp", toolName: "mcp__matrix-integrations__call_service", input: {},
    }, respond)).toBe(false);
    expect(events).toEqual([]);
    expect(approval.onToolPermission({
      nativeRequestId: "native_web", toolName: "WebSearch", input: { query: "matrix os" },
    }, respond)).toBe(true);
    const requested = events[0];
    if (requested?.type !== "approval.requested") throw new Error("Approval was not requested");
    await expect(approval.submit(requested.approvalId, "approve", {
      chatId: "chat_1", clientRequestId: "req_1", platformApprovalProof: "rejected",
    })).rejects.toThrow();
    expect(responses).toEqual([]);
    expect(events.some(event => event.type === "approval.resolved")).toBe(false);
  });

  it("resolves an unanswered request when it expires", async () => {
    vi.useFakeTimers();
    try {
      const { approval, events, responses, respond } = control();
      expect(approval.onToolPermission({
        nativeRequestId: "native_web", toolName: "Bash", input: { command: "pwd" },
      }, respond)).toBe(true);
      const requested = events[0];
      if (requested?.type !== "approval.requested") throw new Error("Approval was not requested");
      expect(requested.title).toBe("Run a command · “pwd”");
      await vi.advanceTimersByTimeAsync(CLAUDE_BUILTIN_TOOL_APPROVAL_TTL_MS);
      expect(responses).toEqual([{ behavior: "deny", message: "This tool request expired before a decision." }]);
      expect(events.at(-1)).toMatchObject({ type: "approval.resolved", approvalId: requested.approvalId, decision: "cancel", reason: "expired" });
      expect(approval.has(requested.approvalId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires a request whose proof check is still running at the deadline", async () => {
    vi.useFakeTimers();
    try {
      let rejectVerify: (error: Error) => void = () => {};
      const verify = new Promise<boolean>((_resolve, reject) => { rejectVerify = reject; });
      const { approval, events, responses, respond } = control(() => verify);
      expect(approval.onToolPermission({
        nativeRequestId: "native_web", toolName: "WebSearch", input: { query: "matrix os" },
      }, respond)).toBe(true);
      const requested = events[0];
      if (requested?.type !== "approval.requested") throw new Error("Approval was not requested");
      const pending = approval.submit(requested.approvalId, "approve", {
        chatId: "chat_1", clientRequestId: "req_1", platformApprovalProof: "signed",
      });
      await vi.advanceTimersByTimeAsync(CLAUDE_BUILTIN_TOOL_APPROVAL_TTL_MS);
      expect(responses).toEqual([]);
      rejectVerify(new Error("proof failed"));
      await expect(pending).rejects.toThrow();
      expect(responses).toEqual([{ behavior: "deny", message: "This tool request expired before a decision." }]);
      expect(events.at(-1)).toMatchObject({
        type: "approval.resolved", approvalId: requested.approvalId, decision: "cancel", reason: "expired",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  async function allowInChat(target: ReturnType<typeof control>, nativeRequestId: string, toolName: string, toolInput: Record<string, unknown>) {
    expect(target.approval.onToolPermission({ nativeRequestId, toolName, input: toolInput }, target.respond)).toBe(true);
    const requested = target.events.at(-1);
    if (requested?.type !== "approval.requested") throw new Error("Approval was not requested");
    await target.approval.submit(requested.approvalId, "approve_for_session", {
      chatId: "chat_1", clientRequestId: `req_${nativeRequestId}`, platformApprovalProof: "signed-chat",
    });
    expect(target.responses.at(-1)).toEqual({ behavior: "allow", updatedInput: toolInput });
    return requested.approvalId;
  }

  function asksAgain(target: ReturnType<typeof control>, nativeRequestId: string, toolName: string, toolInput: Record<string, unknown>) {
    const before = target.events.length;
    expect(target.approval.onToolPermission({ nativeRequestId, toolName, input: toolInput }, target.respond)).toBe(true);
    return target.events.slice(before).some((event) => event.type === "approval.requested");
  }

  it("limits Allow in this chat to the exact tool that was approved", async () => {
    const run = control();
    await allowInChat(run, "native_kill", "KillShell", { shell_id: "1" });
    // Unmapped tools share the fallback card title; a grant for one must not cover another.
    expect(asksAgain(run, "native_todo", "TodoWrite", { todos: [] })).toBe(true);
    await allowInChat(run, "native_edit", "Edit", { file_path: "notes.md" });
    // Edit and Write share the "Update a file" card; the grant still names only Edit.
    expect(asksAgain(run, "native_write", "Write", { file_path: "other.md" })).toBe(true);
    expect(asksAgain(run, "native_edit_again", "Edit", { file_path: "later.md" })).toBe(false);
  });

  it("keeps Allow in this chat to its run and drops it on Undo", async () => {
    const first = control();
    const approvalId = await allowInChat(first, "native_web", "WebSearch", { query: "pricing" });
    const allowed: unknown[] = [];
    expect(first.approval.onToolPermission({
      nativeRequestId: "native_later", toolName: "WebSearch", input: { query: "later" },
    }, async (value) => { allowed.push(value); })).toBe(true);
    await vi.waitFor(() => expect(allowed).toEqual([{ behavior: "allow", updatedInput: { query: "later" } }]));
    expect(asksAgain(first, "native_bash", "Bash", { command: "pwd" })).toBe(true);

    // A later run in the same chat has no grant it could not undo.
    const nextRun = control();
    expect(asksAgain(nextRun, "native_next", "WebSearch", { query: "next" })).toBe(true);
    expect(nextRun.approval.has(approvalId)).toBe(false);

    await first.approval.submit(approvalId, "decline", {
      chatId: "chat_1", clientRequestId: "req_undo", platformApprovalProof: "signed-undo",
    });
    expect(first.events.at(-1)).toMatchObject({
      type: "approval.resolved", approvalId, decision: "approve_for_session", reason: "session_revoked",
    });
    expect(asksAgain(first, "native_again", "WebSearch", { query: "again" })).toBe(true);
  });

  it("forgets its grants when the run closes", async () => {
    const run = control();
    const approvalId = await allowInChat(run, "native_web", "WebSearch", { query: "pricing" });
    run.approval.close();
    expect(run.approval.has(approvalId)).toBe(false);
    await expect(run.approval.submit(approvalId, "decline", {
      chatId: "chat_1", clientRequestId: "req_late_undo", platformApprovalProof: "signed-undo",
    })).rejects.toThrow();
  });
});
