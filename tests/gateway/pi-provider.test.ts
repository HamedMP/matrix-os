import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentProviderSummarySchema,
  AgentThreadEventSchema,
  type AgentThreadEvent,
  type AgentThreadSummary,
  type CreateAgentThreadRequest,
} from "../../packages/contracts/src/index.js";
import { parseCodingAgentProviderRunResult } from "../../packages/gateway/src/coding-agents/provider-adapter.js";
import {
  createPiCodingAgentProvider,
  type PiSpawnFn,
} from "../../packages/gateway/src/coding-agents/pi-provider.js";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";

const ownerPrincipal: RequestPrincipal = { userId: "owner_user", source: "jwt" };
const baseNow = new Date("2026-07-23T12:00:00.000Z");
const SESSION_ID = "019f8e9c-1e8c-7bed-bd12-eda826fd072d";

function threadSummary(overrides: Partial<AgentThreadSummary> = {}): AgentThreadSummary {
  return {
    id: "thread_019f8e9c1e8c7bedbd12eda826fd07",
    providerId: "pi",
    title: "Coding agent run",
    status: "queued",
    attention: "none",
    projectId: "repo-main",
    createdAt: baseNow.toISOString(),
    updatedAt: baseNow.toISOString(),
    ...overrides,
  };
}

function createRequest(prompt: string, overrides: Record<string, unknown> = {}): CreateAgentThreadRequest {
  return {
    providerId: "pi",
    prompt,
    projectId: "repo-main",
    clientRequestId: "req_pi_1",
    ...overrides,
  } as CreateAgentThreadRequest;
}

// --- NDJSON fixtures modeled on the verified `pi --mode json -p` stream (v0.81.0) ---

function sessionLine(sid: string): string {
  return JSON.stringify({ type: "session", version: 3, id: sid, timestamp: "2026-07-23T10:53:43.948Z", cwd: "/work/repo" });
}

function userMessageLines(prompt: string): string[] {
  const message = { role: "user", content: [{ type: "text", text: prompt }], timestamp: 1784804024143 };
  return [
    JSON.stringify({ type: "message_start", message }),
    JSON.stringify({ type: "message_end", message }),
  ];
}

function assistantTextLines(text: string, deltas?: string[]): string[] {
  const chunks = deltas ?? [text];
  const lines = [
    JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }),
    ...chunks.map((delta) =>
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } })
    ),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text } }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }] },
    }),
  ];
  return lines;
}

function toolExecutionLines(input: {
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  resultText: string;
  isError?: boolean;
  partialText?: string;
}): string[] {
  const lines = [
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 } }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0 } }),
    JSON.stringify({
      type: "tool_execution_start",
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: input.args ?? {},
    }),
  ];
  if (input.partialText !== undefined) {
    lines.push(JSON.stringify({
      type: "tool_execution_update",
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: input.args ?? {},
      partialResult: { content: [{ type: "text", text: input.partialText }] },
    }));
  }
  lines.push(JSON.stringify({
    type: "tool_execution_end",
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    result: { content: [{ type: "text", text: input.resultText }] },
    isError: input.isError === true,
  }));
  return lines;
}

function textRunLines(sid: string, prompt: string, text: string): string[] {
  return [
    sessionLine(sid),
    JSON.stringify({ type: "agent_start" }),
    JSON.stringify({ type: "turn_start" }),
    ...userMessageLines(prompt),
    ...assistantTextLines(text),
    JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] }),
    JSON.stringify({ type: "agent_end", messages: [], willRetry: false }),
    JSON.stringify({ type: "agent_settled" }),
  ];
}

function toolRunLines(sid: string, prompt: string): string[] {
  return [
    sessionLine(sid),
    JSON.stringify({ type: "agent_start" }),
    JSON.stringify({ type: "turn_start" }),
    ...userMessageLines(prompt),
    ...toolExecutionLines({
      toolCallId: "call_l0cx06xQ4NQoJg0pNL1BIesg|fc_04e56c1aa6cf13d3016a61f2e4316881919a24cea055fd0b62",
      toolName: "read",
      args: { path: "sample.txt" },
      resultText: "testfile-content\n",
      partialText: "testfile-content\n",
    }),
    ...assistantTextLines("The file contains testfile-content."),
    JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] }),
    JSON.stringify({ type: "agent_end", messages: [], willRetry: false }),
    JSON.stringify({ type: "agent_settled" }),
  ];
}

// --- Fake child process -------------------------------------------------

interface FakeScript {
  lines: string[];
  exitCode?: number | null;
  exitSignal?: string | null;
  stderrText?: string;
  hang?: boolean;
  spawnError?: Error;
  // When true, rewrite the session event id to the --session-id arg, matching
  // real pi behavior (it echoes the requested id back).
  echoSessionId?: boolean;
}

function fakeSpawn(script: FakeScript) {
  const calls: Array<{ command: string; args: string[]; cwd: string; env: Record<string, string> }> = [];
  const kills: string[] = [];
  const spawnFn: PiSpawnFn = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env });
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
    const errorListeners: Array<(err: Error) => void> = [];
    let exited = false;
    const emitExit = (code: number | null, signal: string | null) => {
      if (exited) return;
      exited = true;
      for (const listener of exitListeners) listener(code, signal);
    };
    const proc = {
      stdout,
      stderr,
      kill(signal: NodeJS.Signals) {
        kills.push(signal);
        queueMicrotask(() => emitExit(null, signal));
      },
      once(event: "exit" | "error", listener: never) {
        if (event === "exit") exitListeners.push(listener);
        else errorListeners.push(listener);
      },
    };
    queueMicrotask(() => {
      if (script.spawnError) {
        for (const listener of errorListeners) listener(script.spawnError);
        emitExit(-2, null);
        return;
      }
      if (script.hang) return; // only exits via kill()
      const requestedSessionId = args[args.indexOf("--session-id") + 1];
      const lines = script.echoSessionId && typeof requestedSessionId === "string"
        ? script.lines.map((line) => line.includes('"type":"session"') ? sessionLine(requestedSessionId) : line)
        : script.lines;
      for (const line of lines) {
        stdout.emit("data", Buffer.from(`${line}\n`, "utf-8"));
      }
      if (script.stderrText) stderr.emit("data", Buffer.from(script.stderrText, "utf-8"));
      emitExit(script.exitCode ?? 0, script.exitSignal ?? null);
    });
    return proc;
  };
  return { calls, kills, spawnFn };
}

let homePath: string;
beforeEach(async () => {
  homePath = await mkdtemp(join(tmpdir(), "matrix-pi-provider-"));
});
afterEach(async () => {
  await rm(homePath, { recursive: true, force: true });
});

function providerFor(spawnFn: PiSpawnFn, overrides: Record<string, unknown> = {}) {
  return createPiCodingAgentProvider({
    homePath,
    spawnFn,
    resolveProjectPath: async () => "/work/repo",
    killGraceMs: 5,
    ...overrides,
  });
}

function nextEventIdFactory() {
  let counter = 0;
  return () => `evt_${++counter}_pi_test`;
}

describe("pi provider adapter — spawn contract", () => {
  it("spawns pi in json print mode with an exact session id and the prompt as trailing argv", async () => {
    const fake = fakeSpawn({ lines: textRunLines(SESSION_ID, "Say hi", "hello") });
    const provider = providerFor(fake.spawnFn);

    await provider.startThread({
      principal: ownerPrincipal,
      thread: threadSummary(),
      request: createRequest("Say hi"),
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    });

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.command).toBe("pi");
    expect(call.cwd).toBe("/work/repo");
    // pi rejects "--" as an unknown option, so the prompt is the bare
    // trailing positional argument.
    expect(call.args).toEqual([
      "--mode", "json",
      "--print",
      "--no-approve",
      "--session-id", expect.stringMatching(/^[0-9a-f-]{36}$/),
      "Say hi",
    ]);
  });

  it.each([
    ["- list three colors", " - list three colors"],
    ["@hamed thanks", " @hamed thanks"],
    ["plain prompt", "plain prompt"],
  ])("protects leading option/file-like prompts: %j", async (prompt, expected) => {
    const fake = fakeSpawn({ lines: textRunLines(SESSION_ID, prompt, "ok") });
    const provider = providerFor(fake.spawnFn);

    await provider.startThread({
      principal: ownerPrincipal,
      thread: threadSummary(),
      request: createRequest(prompt),
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    });

    expect(fake.calls[0]!.args.at(-1)).toBe(expected);
  });

  it("passes shell metacharacters through as a single prompt argument", async () => {
    const prompt = "a\"; $(rm -rf /); `whoami`\nmultiline";
    const fake = fakeSpawn({ lines: textRunLines(SESSION_ID, prompt, "ok") });
    const provider = providerFor(fake.spawnFn);

    await provider.startThread({
      principal: ownerPrincipal,
      thread: threadSummary(),
      request: createRequest(prompt),
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    });

    expect(fake.calls[0]!.args.at(-1)).toBe(prompt);
    expect(fake.calls[0]!.args.filter((arg) => arg === prompt)).toHaveLength(1);
  });

  it("does not add provider secrets to argv or env", async () => {
    const fake = fakeSpawn({ lines: textRunLines(SESSION_ID, "Say hi", "hello") });
    const provider = providerFor(fake.spawnFn, { env: { PI_SAFE_TEST: "1" } });

    await provider.startThread({
      principal: ownerPrincipal,
      thread: threadSummary(),
      request: createRequest("Say hi"),
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    });

    const call = fake.calls[0]!;
    expect(call.args.join(" ")).not.toMatch(/api[_ -]?key|bearer|token|secret|password/i);
    expect(call.env.PI_SAFE_TEST).toBe("1");
  });

  it("uses homePath as cwd when the thread has no project", async () => {
    const fake = fakeSpawn({ lines: textRunLines(SESSION_ID, "Say hi", "hello") });
    const provider = providerFor(fake.spawnFn);

    await provider.startThread({
      principal: ownerPrincipal,
      thread: threadSummary({ projectId: undefined }),
      request: createRequest("Say hi", { projectId: undefined }),
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    });

    expect(fake.calls[0]!.cwd).toBe(homePath);
  });

  it("fails the thread safely when the project path cannot be resolved", async () => {
    const fake = fakeSpawn({ lines: [] });
    const provider = providerFor(fake.spawnFn, { resolveProjectPath: async () => null });

    const result = await provider.startThread({
      principal: ownerPrincipal,
      thread: threadSummary(),
      request: createRequest("Say hi"),
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    });
    const parsed = parseCodingAgentProviderRunResult(result, threadSummary().id);

    expect(fake.calls).toHaveLength(0);
    expect(parsed.events.some((event) => event.type === "thread.error")).toBe(true);
    expect(parsed.events.at(-1)).toMatchObject({ type: "thread.completed", outcome: "failed" });
  });
});

describe("pi provider adapter — event normalization", () => {
  it("maps a text-only run into the normalized lifecycle", async () => {
    const fake = fakeSpawn({ lines: textRunLines(SESSION_ID, "Say hi", "hello") });
    const provider = providerFor(fake.spawnFn);
    const thread = threadSummary();

    const result = await provider.startThread({
      principal: ownerPrincipal,
      thread,
      request: createRequest("Say hi"),
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    });
    const parsed = parseCodingAgentProviderRunResult(result, thread.id);

    const types = parsed.events.map((event) => event.type);
    expect(types).toEqual([
      "thread.status",
      "assistant.text.delta",
      "assistant.text.completed",
      "thread.status",
      "thread.completed",
    ]);
    expect(parsed.events[0]).toMatchObject({ type: "thread.status", status: "running" });
    expect(parsed.events[1]).toMatchObject({ type: "assistant.text.delta", delta: "hello" });
    expect(parsed.events.at(-1)).toMatchObject({ type: "thread.completed", outcome: "completed" });
    for (const event of parsed.events) {
      AgentThreadEventSchema.parse(event);
      expect(event.threadId).toBe(thread.id);
    }
    expect(parsed.events.some((event) => event.type === "user.message")).toBe(false);
    expect(parsed.resumeState?.conversationId).toBeTruthy();
  });

  it("chunks long assistant text into bounded deltas", async () => {
    const longText = "x".repeat(9_000);
    const fake = fakeSpawn({ lines: textRunLines(SESSION_ID, "Say hi", longText) });
    const provider = providerFor(fake.spawnFn);

    const result = await provider.startThread({
      principal: ownerPrincipal,
      thread: threadSummary(),
      request: createRequest("Say hi"),
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    });
    const parsed = parseCodingAgentProviderRunResult(result, threadSummary().id);

    const deltas = parsed.events.filter((event) => event.type === "assistant.text.delta");
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    for (const delta of deltas) {
      AgentThreadEventSchema.parse(delta);
      expect(delta.type === "assistant.text.delta" && delta.delta.length <= 4000).toBe(true);
    }
    const joined = deltas.map((event) => event.type === "assistant.text.delta" ? event.delta : "").join("");
    expect(joined).toBe(longText);
  });

  it("maps tool execution into started/output/completed with sanitized ids", async () => {
    const fake = fakeSpawn({ lines: toolRunLines(SESSION_ID, "Read sample.txt") });
    const provider = providerFor(fake.spawnFn);
    const thread = threadSummary();

    const result = await provider.startThread({
      principal: ownerPrincipal,
      thread,
      request: createRequest("Read sample.txt"),
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    });
    const parsed = parseCodingAgentProviderRunResult(result, thread.id);

    const started = parsed.events.find((event) => event.type === "tool.started");
    const output = parsed.events.find((event) => event.type === "tool.output");
    const completed = parsed.events.find((event) => event.type === "tool.completed");
    expect(started).toBeTruthy();
    expect(output).toBeTruthy();
    expect(completed).toBeTruthy();
    if (started?.type !== "tool.started" || completed?.type !== "tool.completed") {
      throw new Error("tool events missing");
    }
    expect(started.toolCallId).not.toContain("|");
    expect(started.toolCallId.length).toBeLessThanOrEqual(128);
    expect(started.displayName).toBe("read");
    expect(started.kind).toBe("read");
    expect(completed.toolCallId).toBe(started.toolCallId);
    expect(completed.outcome).toBe("success");
    for (const event of parsed.events) AgentThreadEventSchema.parse(event);
  });

  it("maps tool errors to a failed outcome", async () => {
    const lines = [
      sessionLine(SESSION_ID),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "turn_start" }),
      ...toolExecutionLines({
        toolCallId: "call_abc|fc_def",
        toolName: "bash",
        args: { command: "exit 3" },
        resultText: "command failed",
        isError: true,
      }),
      JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] }),
      JSON.stringify({ type: "agent_end", messages: [], willRetry: false }),
      JSON.stringify({ type: "agent_settled" }),
    ];
    const fake = fakeSpawn({ lines });
    const provider = providerFor(fake.spawnFn);

    const result = await provider.startThread({
      principal: ownerPrincipal,
      thread: threadSummary(),
      request: createRequest("Run a failing command"),
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    });
    const parsed = parseCodingAgentProviderRunResult(result, threadSummary().id);

    const completed = parsed.events.find((event) => event.type === "tool.completed");
    expect(completed).toMatchObject({ type: "tool.completed", outcome: "failed" });
  });

  it("caps tool output and marks truncation", async () => {
    const hugeOutput = "y".repeat(60_000);
    const lines = [
      sessionLine(SESSION_ID),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "turn_start" }),
      ...toolExecutionLines({
        toolCallId: "call_big|fc_big",
        toolName: "bash",
        resultText: hugeOutput,
      }),
      JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] }),
      JSON.stringify({ type: "agent_end", messages: [], willRetry: false }),
      JSON.stringify({ type: "agent_settled" }),
    ];
    const fake = fakeSpawn({ lines });
    const provider = providerFor(fake.spawnFn);

    const result = await provider.startThread({
      principal: ownerPrincipal,
      thread: threadSummary(),
      request: createRequest("Dump a huge file"),
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    });
    const parsed = parseCodingAgentProviderRunResult(result, threadSummary().id);

    const outputs = parsed.events.filter((event) => event.type === "tool.output");
    for (const event of outputs) AgentThreadEventSchema.parse(event);
    const total = outputs.reduce((sum, event) => sum + (event.type === "tool.output" ? event.text.length : 0), 0);
    expect(total).toBeLessThan(hugeOutput.length);
    expect(outputs.some((event) => event.type === "tool.output" && event.truncated === true)).toBe(true);
  });

  it("skips unknown and malformed lines without failing the run", async () => {
    const lines = [
      "not json at all",
      sessionLine(SESSION_ID),
      JSON.stringify({ type: "queue_update", steering: [], followUp: [] }),
      JSON.stringify({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 500, errorMessage: "rate limit" }),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "turn_start" }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" } }),
      ...assistantTextLines("recovered"),
      JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] }),
      JSON.stringify({ type: "agent_end", messages: [], willRetry: false }),
      JSON.stringify({ type: "agent_settled" }),
      '{"type":"message_update"',
    ];
    const fake = fakeSpawn({ lines });
    const provider = providerFor(fake.spawnFn);

    const result = await provider.startThread({
      principal: ownerPrincipal,
      thread: threadSummary(),
      request: createRequest("Say hi"),
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    });
    const parsed = parseCodingAgentProviderRunResult(result, threadSummary().id);

    expect(parsed.events.at(-1)).toMatchObject({ type: "thread.completed", outcome: "completed" });
    expect(parsed.events.some((event) => event.type === "assistant.text.delta")).toBe(true);
  });

  it("stays within the provider event cap for very chatty runs", async () => {
    const deltas = Array.from({ length: 2_000 }, (_, index) => `d${index}`);
    const lines = [
      sessionLine(SESSION_ID),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "turn_start" }),
      ...assistantTextLines(deltas.join(""), deltas),
      JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] }),
      JSON.stringify({ type: "agent_end", messages: [], willRetry: false }),
      JSON.stringify({ type: "agent_settled" }),
    ];
    const fake = fakeSpawn({ lines });
    const provider = providerFor(fake.spawnFn);

    const result = await provider.startThread({
      principal: ownerPrincipal,
      thread: threadSummary(),
      request: createRequest("Say hi"),
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    });
    const parsed = parseCodingAgentProviderRunResult(result, threadSummary().id);
    expect(parsed.events.length).toBeLessThanOrEqual(500);
  });
});

describe("pi provider adapter — resume", () => {
  it("returns a resume state that resumeTurn reuses for the next turn", async () => {
    const first = fakeSpawn({ lines: textRunLines(SESSION_ID, "Remember PINEAPPLE", "OK"), echoSessionId: true });
    const provider = providerFor(first.spawnFn);
    const thread = threadSummary({ status: "running" });

    const started = parseCodingAgentProviderRunResult(await provider.startThread({
      principal: ownerPrincipal,
      thread,
      request: createRequest("Remember PINEAPPLE"),
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    }), thread.id);
    expect(started.resumeState?.conversationId).toBeTruthy();

    const second = fakeSpawn({ lines: textRunLines(SESSION_ID, "What word?", "PINEAPPLE"), echoSessionId: true });
    const resumedProvider = createPiCodingAgentProvider({
      homePath,
      spawnFn: second.spawnFn,
      resolveProjectPath: async () => "/work/repo",
      killGraceMs: 5,
    });
    const turnResult = parseCodingAgentProviderRunResult(await resumedProvider.resumeTurn!({
      principal: ownerPrincipal,
      thread,
      turn: { turnId: "turn_019f8e9c1e8c7bedbd12eda826fd08", message: "What word?" },
      resumeState: started.resumeState!,
      signal: AbortSignal.timeout(5_000),
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    }), thread.id);

    expect(turnResult.outcome).toBe("completed");
    const call = second.calls[0]!;
    const sessionFlagIndex = call.args.indexOf("--session-id");
    expect(sessionFlagIndex).toBeGreaterThanOrEqual(0);
    expect(call.args[sessionFlagIndex + 1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.args[sessionFlagIndex + 1]).toBe(
      first.calls[0]!.args[first.calls[0]!.args.indexOf("--session-id") + 1],
    );
    expect(call.cwd).toBe("/work/repo");
    expect(call.args.at(-1)).toBe("What word?");
    // Turn events must not include store-owned lifecycle events.
    expect(turnResult.events.some((event) =>
      event.type === "thread.completed" ||
      event.type === "thread.created" ||
      event.type === "turn.status" ||
      event.type === "turn.accepted"
    )).toBe(false);
    for (const event of turnResult.events) AgentThreadEventSchema.parse(event);
  });

  it("scopes assistant message ids per turn", async () => {
    const first = fakeSpawn({ lines: textRunLines(SESSION_ID, "One", "first") });
    const provider = providerFor(first.spawnFn);
    const thread = threadSummary({ status: "running" });

    const started = parseCodingAgentProviderRunResult(await provider.startThread({
      principal: ownerPrincipal,
      thread,
      request: createRequest("One"),
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    }), thread.id);
    const resumed = parseCodingAgentProviderRunResult(await provider.resumeTurn!({
      principal: ownerPrincipal,
      thread,
      turn: { turnId: "turn_019f8e9c1e8c7bedbd12eda826fd09", message: "Two" },
      resumeState: started.resumeState!,
      signal: AbortSignal.timeout(5_000),
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    }), thread.id);

    const startMessageIds = started.events
      .filter((event) => event.type === "assistant.text.delta")
      .map((event) => event.type === "assistant.text.delta" ? event.messageId : "");
    const turnMessageIds = resumed.events
      .filter((event) => event.type === "assistant.text.delta")
      .map((event) => event.type === "assistant.text.delta" ? event.messageId : "");
    expect(startMessageIds.length).toBeGreaterThan(0);
    expect(turnMessageIds.length).toBeGreaterThan(0);
    expect(turnMessageIds.some((id) => startMessageIds.includes(id))).toBe(false);
  });

  it("fails safely when the resume state is corrupt", async () => {
    const fake = fakeSpawn({ lines: [] });
    const provider = providerFor(fake.spawnFn);

    const result = parseCodingAgentProviderRunResult(await provider.resumeTurn!({
      principal: ownerPrincipal,
      thread: threadSummary({ status: "running" }),
      turn: { turnId: "turn_019f8e9c1e8c7bedbd12eda826fd0a", message: "Hi again" },
      resumeState: { conversationId: "not-a-pi-resume-state" },
      signal: AbortSignal.timeout(5_000),
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    }), threadSummary().id);

    expect(result.outcome).toBe("failed");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("pi provider adapter — failures", () => {
  it("maps a non-zero exit into a safe failure without leaking stderr", async () => {
    const fake = fakeSpawn({
      lines: [sessionLine(SESSION_ID)],
      exitCode: 1,
      stderrText: 'Error: Model "nonexistent-model-xyz" not found. Config at /home/test/.pi/agent/auth.json',
    });
    const provider = providerFor(fake.spawnFn);

    const result = await provider.startThread({
      principal: ownerPrincipal,
      thread: threadSummary(),
      request: createRequest("Say hi"),
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    });
    const parsed = parseCodingAgentProviderRunResult(result, threadSummary().id);

    expect(parsed.events.at(-1)).toMatchObject({ type: "thread.completed", outcome: "failed" });
    const errorEvent = parsed.events.find((event) => event.type === "thread.error");
    expect(errorEvent).toBeTruthy();
    const serialized = JSON.stringify(parsed.events);
    expect(serialized).not.toMatch(/nonexistent-model|\/home\/|auth\.json|openai|anthropic/i);
  });

  it("maps a spawn failure into a safe failure instead of throwing", async () => {
    const fake = fakeSpawn({
      lines: [],
      spawnError: Object.assign(new Error("spawn pi ENOENT"), { code: "ENOENT" }),
    });
    const provider = providerFor(fake.spawnFn);

    const result = await provider.startThread({
      principal: ownerPrincipal,
      thread: threadSummary(),
      request: createRequest("Say hi"),
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    });
    const parsed = parseCodingAgentProviderRunResult(result, threadSummary().id);

    expect(parsed.events.at(-1)).toMatchObject({ type: "thread.completed", outcome: "failed" });
    expect(JSON.stringify(parsed.events)).not.toMatch(/ENOENT|spawn pi/);
  });
});

describe("pi provider adapter — abort and timeout", () => {
  it("kills the child with SIGTERM when the turn signal aborts", async () => {
    const fake = fakeSpawn({ lines: [sessionLine(SESSION_ID)], hang: true });
    const provider = providerFor(fake.spawnFn);
    const controller = new AbortController();

    const pending = provider.resumeTurn!({
      principal: ownerPrincipal,
      thread: threadSummary({ status: "running" }),
      turn: { turnId: "turn_019f8e9c1e8c7bedbd12eda826fd0b", message: "Long work" },
      resumeState: { conversationId: JSON.stringify({ s: SESSION_ID, c: "/work/repo" }) },
      signal: controller.signal,
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const result = parseCodingAgentProviderRunResult(await pending, threadSummary().id);

    expect(fake.kills).toContain("SIGTERM");
    expect(result.outcome).toBe("aborted");
  });

  it("times out a hung startThread run and fails the thread", async () => {
    const fake = fakeSpawn({ lines: [sessionLine(SESSION_ID)], hang: true });
    const provider = providerFor(fake.spawnFn, { runTimeoutMs: 20 });

    const result = await provider.startThread({
      principal: ownerPrincipal,
      thread: threadSummary(),
      request: createRequest("Say hi"),
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    });
    const parsed = parseCodingAgentProviderRunResult(result, threadSummary().id);

    expect(fake.kills).toContain("SIGTERM");
    expect(parsed.events.at(-1)).toMatchObject({ type: "thread.completed", outcome: "failed" });
  });

  it("abortThread kills a tracked active process and returns default abort events", async () => {
    const fake = fakeSpawn({ lines: [sessionLine(SESSION_ID)], hang: true });
    const provider = providerFor(fake.spawnFn);
    const thread = threadSummary({ status: "running" });

    const pending = provider.resumeTurn!({
      principal: ownerPrincipal,
      thread,
      turn: { turnId: "turn_019f8e9c1e8c7bedbd12eda826fd0c", message: "Long work" },
      resumeState: { conversationId: JSON.stringify({ s: SESSION_ID, c: "/work/repo" }) },
      signal: AbortSignal.timeout(5_000),
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const abortEvents = await provider.abortThread!({
      principal: ownerPrincipal,
      thread,
      clientRequestId: "req_abort_1",
      now: () => baseNow,
      nextEventId: nextEventIdFactory(),
    });
    await pending;

    expect(fake.kills).toContain("SIGTERM");
    const parsed = parseCodingAgentProviderRunResult({ events: abortEvents }, thread.id);
    expect(parsed.events.map((event) => event.type)).toEqual(["thread.status", "thread.completed"]);
    expect(parsed.events[0]).toMatchObject({ type: "thread.status", status: "aborted" });
    expect(parsed.events[1]).toMatchObject({ type: "thread.completed", outcome: "aborted" });
  });
});

describe("pi provider adapter — availability and summary", () => {
  it("reports installed and authenticated when the binary answers --version", async () => {
    const provider = createPiCodingAgentProvider({
      homePath,
      spawnFn: fakeSpawn({ lines: [] }).spawnFn,
      runCommand: async () => ({ stdout: "0.81.0\n", stderr: "" }),
    });

    const summary = AgentProviderSummarySchema.parse(await provider.getSummary!({
      principal: ownerPrincipal,
      now: () => baseNow,
      signal: AbortSignal.timeout(1_000),
    }));

    expect(summary).toMatchObject({
      id: "pi",
      displayName: "Pi",
      kind: "pi",
      availability: "available",
      installStatus: "installed",
      authStatus: "authenticated",
      supportedModes: ["default"],
      defaultMode: "default",
    });
    expect(await provider.healthCheck!({
      principal: ownerPrincipal,
      now: () => baseNow,
      signal: AbortSignal.timeout(1_000),
    })).toEqual({ ok: true });
  });

  it("reports the provider missing when the binary probe fails", async () => {
    const provider = createPiCodingAgentProvider({
      homePath,
      spawnFn: fakeSpawn({ lines: [] }).spawnFn,
      runCommand: async () => {
        throw Object.assign(new Error("spawn pi ENOENT"), { code: "ENOENT" });
      },
    });

    const summary = AgentProviderSummarySchema.parse(await provider.getSummary!({
      principal: ownerPrincipal,
      now: () => baseNow,
      signal: AbortSignal.timeout(1_000),
    }));

    expect(summary).toMatchObject({
      id: "pi",
      availability: "unavailable",
      installStatus: "missing",
      authStatus: "unknown",
    });
    expect(await provider.healthCheck!({
      principal: ownerPrincipal,
      now: () => baseNow,
      signal: AbortSignal.timeout(1_000),
    })).toEqual({ ok: false });
  });

  it("returns bounded foreground install and connect actions without secrets", async () => {
    const provider = createPiCodingAgentProvider({
      homePath,
      spawnFn: fakeSpawn({ lines: [] }).spawnFn,
      runCommand: async () => ({ stdout: "0.81.0\n", stderr: "" }),
    });

    const actions = await provider.buildSetupAction!({
      principal: ownerPrincipal,
      now: () => baseNow,
      signal: AbortSignal.timeout(1_000),
    });

    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ kind: "foreground_terminal" });
    expect(JSON.stringify(actions)).toContain("@earendil-works/pi-coding-agent");
    expect(JSON.stringify(actions)).not.toMatch(/api[_ -]?key|bearer|token|secret|password/i);
  });
});

describe("pi provider adapter — thread store integration", () => {
  it("runs a full thread and follow-up turn through the store", async () => {
    const fake = fakeSpawn({ lines: textRunLines(SESSION_ID, "Say hi", "hello from pi") });
    const provider = providerFor(fake.spawnFn);
    const store = createCodingAgentThreadStore({
      homePath,
      providers: [provider],
      relationValidator: { validateCreate: async () => undefined, validateThread: async () => undefined },
      now: () => baseNow,
    });

    const created = await store.createThread(ownerPrincipal, createRequest("Say hi"));
    expect(created.snapshot.thread.status).toBe("completed");
    const textEvents = created.snapshot.events.items.filter((event: AgentThreadEvent) =>
      event.type === "assistant.text.delta"
    );
    expect(textEvents.length).toBeGreaterThan(0);

    const accepted = await store.acceptTurn(ownerPrincipal, created.snapshot.thread.id, {
      message: "One more",
      clientRequestId: "req_pi_turn_1",
    });
    expect(accepted.status).toBe("accepted");
    await vi.waitFor(async () => {
      const snapshot = await store.getThread(ownerPrincipal, created.snapshot.thread.id);
      expect(snapshot.thread.status).toBe("completed");
    }, { timeout: 2_000, interval: 20 });
    const snapshot = await store.getThread(ownerPrincipal, created.snapshot.thread.id);
    expect(snapshot.events.items.some((event: AgentThreadEvent) => event.type === "turn.status")).toBe(true);
    await store.shutdownTurns();
  });
});
