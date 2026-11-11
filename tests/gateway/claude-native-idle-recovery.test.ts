import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createClaudeNativeSessionPool } from "../../packages/gateway/src/chat/claude-native-session.js";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import { loadChatResumeState } from "../../packages/gateway/src/chat/resume-checkpoint.js";
import { input, NativeChild, ready, setup } from "./claude-native-session-fixture.js";

const prompt = "native scheduled prompt";
const job = {
  id: "abcdef01",
  cron: "* * * * *",
  promptSha256: createHash("sha256").update(prompt).digest("hex"),
  recurring: true,
};
const tickId = "c9c2e1c3-2cab-42f9-ac46-c20f8f3dd98f";
const nextTickId = "091a91b3-2509-480d-983b-1db15d329da7";
const wakeupId = "a32b8b8d-39cb-48e1-ab99-5bc4b02a4da3";

class IdleChild extends NativeChild {
  ack(requestId: string) {
    this.emitFrame({ type: "control_response", response: { subtype: "success", request_id: requestId,
      response: { added: [], removed: [], errors: {} } } });
  }
}

function fixture(child = new IdleChild(), settings = {}) {
  child.initialized = true; // Idle resume need not emit system/init before its first prompt.
  const defaultAdmit = vi.fn(async () => {});
  const admitRecoveredPhase = vi.fn(async () => {});
  const launchProtected = vi.fn(() => child);
  const pool = createClaudeNativeSessionPool({ protocolQualified: true, onScheduledPhase: defaultAdmit, ...settings });
  const restore = {
    input: input(), sessionId: "native_1", sourceFingerprint: "source_a",
    deadlineMs: Date.now() + 10_000, jobs: [job], launchProtected, admitRecoveredPhase,
  };
  return { child, defaultAdmit, admitRecoveredPhase, launchProtected, pool, restore };
}

describe("private native Claude idle recovery", () => {
  it("marks a protected phase checkpoint and only resumes it on the same live protected child", async () => {
    const f = fixture();
    const spawnFn = vi.fn(() => new NativeChild());
    const adapter = createClaudeChatProviderAdapter({
      homePath: "/owner", nativeSessions: f.pool, spawnFn,
      resolveNativeProtocol: async () => ({ command: "/qualified/claude", qualified: true }),
      resolveSessionSource: async () => ({ fingerprint: "source_a", schedulingAllowed: true }),
      resolveCredentialEnv: async () => ({ HOME: "/owner", ANTHROPIC_API_KEY: "key" }),
    });
    const turn = input("run_followup");
    const state = { sessionId: f.restore.sessionId, canonicalHistoryRequired: true } as const;
    let checkpoint: { sessionId: string; canonicalHistoryRequired?: true } = { sessionId: state.sessionId };
    const load = (request = turn) => loadChatResumeState({
      repository: { getLatestAdapterStateForChat: async () => ({ schemaVersion: 1, state: checkpoint, settings: turn }) },
      ...request, adapter, instanceId: request.selection.instanceId, executionRootFingerprint: null, mode: "follow_up",
    });
    try {
      await f.pool.restoreIdle(f.restore);
      // The original pre-recovery source is a legacy unmarked checkpoint.
      const changeModel = { ...turn, selection: { ...turn.selection, model: "sonnet" } };
      const changePermission = { ...turn, permissionMode: "full_access" };
      expect(await load(changeModel)).toBeUndefined();
      expect(await load()).toEqual(state);
      const events = Array.fromAsync(adapter.resume!({ ...turn, resumeState: checkpoint }));
      await vi.waitFor(() => expect(f.child.frames.some(frame => frame.response?.request_id === "request_foreground_1")).toBe(true));
      f.child.result();
      expect(await events).toEqual(expect.arrayContaining([{ type: "state.updated", state }, { type: "run.completed", outcome: "completed" }]));
      checkpoint = state;
      expect(await load()).toEqual(state);
      expect(await load(changeModel)).toBeUndefined();
      expect(await load(changePermission)).toBeUndefined();
      expect(await load({ ...turn, context: { version: 1, requestHash: "a".repeat(64), chats: [],
        drives: [{ kind: "drive", organizationId: "org_company", scopeId: "00000000-0000-4000-8000-000000000001" }] },
      })).toBeUndefined();
      expect(await load({ ...turn, owner: { ...turn.owner, ownerId: "foreign_owner" } })).toBeUndefined();
      expect(await load({ ...turn, chatId: "chat_foreign" })).toBeUndefined();
      const continued = Array.fromAsync(adapter.resume!({ ...turn, runId: "run_marked", resumeState: state }));
      await vi.waitFor(() => expect(f.child.frames.some(frame => frame.response?.request_id === "request_foreground_2")).toBe(true));
      f.child.result();
      expect((await continued).at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
      f.child.exit();
      expect(await load()).toBeUndefined();
      const late = await Array.fromAsync(adapter.resume!({ ...turn, runId: "run_late", resumeState: state }));
      expect(late.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
      expect(spawnFn).not.toHaveBeenCalled();
    } finally {
      await f.pool.close();
    }
  });

  it("initializes the recovered child with no foreground prompt or MCP grants", async () => {
    const f = fixture();
    try {
      await f.pool.restoreIdle(f.restore);
      expect(f.launchProtected).toHaveBeenCalledOnce();
      expect(f.child.frames.map(frame => frame.request?.subtype)).toEqual(["initialize", "mcp_set_servers"]);
      expect(f.child.frames[1]?.request.servers).toEqual({});
      f.child.prompt("due", tickId, prompt);
      await ready();
      expect(f.admitRecoveredPhase).toHaveBeenCalledExactlyOnceWith({
        owner: f.restore.input.owner, chatId: "chat_1", sourceRunId: "run_1",
        sessionId: "native_1", promptId: tickId, prompt,
      }, job);
      expect(f.defaultAdmit).not.toHaveBeenCalled();
      expect(f.child.frames.some(frame => frame.type === "user" || frame.response?.request_id === "due")).toBe(false);
    } finally {
      await f.pool.close();
    }
  });

  it.each([true, false])("blocks only a matching due callback during qualification (initialize ACK observed: %s)", async initialized => {
    const f = fixture();
    f.child.autoMcpAck = false;
    const pending = f.pool.restoreIdle(f.restore);
    const settled = pending.catch((error: unknown) => error);
    try {
      if (initialized) await ready();
      f.child.emitFrame({ type: "command_lifecycle", command_uuid: wakeupId, state: "started",
        wakeup_source: "schedule_wakeup", uuid: "c06bb68e-7d52-4fe6-8a27-03311a0b391e", session_id: f.restore.sessionId });
      f.child.prompt("early", tickId, prompt);
      await ready();
      expect(f.admitRecoveredPhase).not.toHaveBeenCalled();
      expect(f.child.frames.find(frame => frame.response?.request_id === "early")?.response.response)
        .toMatchObject({ decision: "block" });
      expect(f.child.kill).not.toHaveBeenCalled();
      f.child.emitFrame({ type: "command_lifecycle", command_uuid: wakeupId, state: "completed",
        uuid: "b19b4af2-196b-4d46-b76e-57bcae0fe96d", session_id: f.restore.sessionId });
      const mcpRequest = f.child.frames.find(frame => frame.request?.subtype === "mcp_set_servers");
      expect(mcpRequest).toBeDefined();
      f.child.ack(mcpRequest.request_id);
      expect(await settled).toBeUndefined();
      f.child.prompt("next", nextTickId, prompt);
      await ready();
      expect(f.admitRecoveredPhase).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ promptId: nextTickId }), job);
    } finally {
      await f.pool.close();
    }
  });

  it("rejects duplicate ownership and an unknown callback arriving before empty MCP is acknowledged", async () => {
    const f = fixture();
    f.child.autoMcpAck = false;
    const pending = f.pool.restoreIdle(f.restore);
    const rejected = expect(pending).rejects.toThrow();
    try {
      await ready();
      await expect(f.pool.restoreIdle(f.restore)).rejects.toThrow();
      expect(f.launchProtected).toHaveBeenCalledOnce();
      f.child.prompt("early", tickId, "unverified native prompt");
      await rejected;
      expect(f.admitRecoveredPhase).not.toHaveBeenCalled();
      expect(f.child.frames.find(frame => frame.response?.request_id === "early")?.response.response)
        .toMatchObject({ decision: "block" });
      expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      await f.pool.close();
    }
  });

  it("rejects expired and ambiguous receipts before launching a child", async () => {
    const f = fixture();
    try {
      await expect(f.pool.restoreIdle({ ...f.restore, deadlineMs: Date.now() - 1 })).rejects.toThrow();
      await expect(f.pool.restoreIdle({ ...f.restore, jobs: [job, { ...job, id: "abcdef02" }] })).rejects.toThrow();
      expect(f.launchProtected).not.toHaveBeenCalled();
    } finally {
      await f.pool.close();
    }
  });

  it("stops an adjacent native version even if it acknowledges hooks and MCP", async () => {
    const f = fixture();
    f.child.version = "2.1.316";
    try {
      await expect(f.pool.restoreIdle(f.restore)).rejects.toThrow();
      expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(f.admitRecoveredPhase).not.toHaveBeenCalled();
    } finally {
      await f.pool.close();
    }
  });

  it("refuses to arm if the child reports unexpected MCP additions", async () => {
    const f = fixture(new NativeChild());
    try {
      await expect(f.pool.restoreIdle(f.restore)).rejects.toThrow("Native idle MCP configuration unavailable");
      expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(f.admitRecoveredPhase).not.toHaveBeenCalled();
    } finally {
      await f.pool.close();
    }
  });

  it("expires a restored process at the original deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.pool.restoreIdle({ ...f.restore, deadlineMs: Date.now() + 100 });
      await vi.advanceTimersByTimeAsync(100);
      expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      await f.pool.close();
    }
  });

  it("blocks the due prompt when fresh recovery admission refuses it", async () => {
    const f = fixture();
    f.admitRecoveredPhase.mockRejectedValueOnce(new Error("Stale recovery claim"));
    try {
      await f.pool.restoreIdle(f.restore);
      f.child.prompt("due", tickId, prompt);
      await ready();
      expect(f.admitRecoveredPhase).toHaveBeenCalledOnce();
      expect(f.child.frames.find(frame => frame.response?.request_id === "due")?.response.response)
        .toMatchObject({ decision: "block" });
      expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      await f.pool.close();
    }
  });

  it("fails closed when the verified child reports a different session", async () => {
    const f = fixture(new IdleChild(), { maxSessions: 1 });
    try {
      await f.pool.restoreIdle(f.restore);
      const other = fixture();
      await expect(f.pool.restoreIdle({ ...other.restore, input: input("run_2", "chat_2") })).rejects.toThrow();
      expect(other.launchProtected).not.toHaveBeenCalled();
      f.child.emitFrame({ type: "system", subtype: "init", session_id: "different", claude_code_version: "2.1.317" });
      expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(f.admitRecoveredPhase).not.toHaveBeenCalled();
    } finally {
      await f.pool.close();
    }
  });
});

describe("protected Claude native shutdown inventory", () => {
  const evidence = { ...job, assistantUuid: "09f23651-fd98-4642-8b79-6dc2e5688c8e",
    receiptUuid: "40c465b2-37e0-4eb4-b51d-d8bef1c69a1b" };

  it("hands off verified idle inventory only after process close", async () => {
    const f = fixture();
    const handoff = vi.fn(async () => {});
    f.child.kill.mockImplementation(() => {});
    await f.pool.restoreIdle({ ...f.restore, evidence: [evidence] });
    const closed = f.pool.close(handoff);
    expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
    f.child.emit("exit", null, "SIGTERM");
    await ready();
    expect(handoff).not.toHaveBeenCalled();
    f.child.emit("close", null, "SIGTERM");
    await closed;
    expect(handoff).toHaveBeenCalledExactlyOnceWith({
      ownerId: "owner_1", chatId: "chat_1", sourceRunId: "run_1", sessionId: "native_1",
      deadlineAt: new Date(f.restore.deadlineMs).toISOString(), sourceFingerprint: "source_a", jobs: [evidence],
    });
  });

  it("does not hand off a due prompt that was still held at shutdown", async () => {
    const f = fixture();
    const handoff = vi.fn(async () => {});
    await f.pool.restoreIdle({ ...f.restore, evidence: [evidence] });
    f.child.prompt("due", tickId, prompt);
    await f.pool.close(handoff);
    expect(f.admitRecoveredPhase).toHaveBeenCalledOnce();
    expect(handoff).not.toHaveBeenCalled();
  });

  it("does not hand off a child whose scope is unconfirmed after the process closes", async () => {
    const f = fixture();
    const handoff = vi.fn(async () => {});
    f.child.confirmScopeClosed.mockResolvedValue(false);
    await f.pool.restoreIdle({ ...f.restore, evidence: [evidence] });
    await f.pool.close(handoff);
    expect(f.child.confirmScopeClosed).toHaveBeenCalledOnce();
    expect(handoff).not.toHaveBeenCalled();
  });
});

it("can hand off a fresh recurring receipt with a correlated tool authorization", async () => {
  const f = setup();
  const turn = f.turn();
  await ready();
  const child = f.children[0]!;
  const assistantUuid = "09f23651-fd98-4642-8b79-6dc2e5688c8e";
  const receiptUuid = "40c465b2-37e0-4eb4-b51d-d8bef1c69a1b";
  const tool = { cron: job.cron, prompt, recurring: true };
  child.emitFrame({ type: "assistant", uuid: assistantUuid, message: { content: [
    { type: "tool_use", id: "tool_cron", name: "CronCreate", input: tool },
  ] } });
  child.toolHook("CronCreate", "tool_cron", tool);
  await ready();
  child.emitFrame({ type: "user", uuid: receiptUuid,
    tool_use_result: { id: job.id, recurring: true, durable: false, nextFireAt: Date.now() + 60_000 },
    message: { content: [
      { type: "tool_result", tool_use_id: "tool_cron", content: "Scheduled recurring job abcdef01." },
    ] },
  });
  child.result();
  await turn.promise;
  const handoff = vi.fn(async () => {});
  await f.pool.close(handoff);
  expect(handoff).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    sourceRunId: "run_1", jobs: [{ ...job, assistantUuid, receiptUuid }],
  }));
});
