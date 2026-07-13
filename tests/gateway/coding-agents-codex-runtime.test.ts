import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildAgentLaunch } from "../../packages/gateway/src/agent-launcher.js";
import {
  codexProviderEventPath,
  createCodexEventBridge,
} from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createWorkspaceCodingAgentProvider } from "../../packages/gateway/src/coding-agents/workspace-provider.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";

const principal: RequestPrincipal = { userId: "owner_user", source: "jwt" };

function runProcess(command: string, args: string[], cwd: string, input = ""): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe("Codex structured event runtime", () => {
  it("wraps Codex exec with the Matrix event runner and forces JSONL output", () => {
    const launch = buildAgentLaunch({
      agent: "codex",
      cwd: "/home/matrix/home/projects/repo",
      prompt: "Fix the failing route.",
      approvalPolicy: "never",
      sandbox: {
        enabled: true,
        mode: "workspace-write",
        writableRoots: ["/home/matrix/home/projects/repo"],
      },
      providerEventPath: "/home/matrix/home/system/coding-agents/provider-events/sess_test.jsonl",
    });

    expect(launch.command).toBe(process.execPath);
    expect(launch.args[0]).toMatch(/coding-agents\/codex-runner\.mjs$/);
    expect(launch.args.slice(1, 3)).toEqual([
      "/home/matrix/home/system/coding-agents/provider-events/sess_test.jsonl",
      "codex",
    ]);
    expect(launch.args).toContain("--json");
    expect(launch.args).not.toContain("sh");
    expect(launch.args).not.toContain("-c");
  });

  it("runs a real child process, persists raw complete JSONL, and prints only safe terminal output", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-codex-runner-"));
    const fakeCodexPath = join(homePath, "fake-codex.mjs");
    const eventPath = codexProviderEventPath(homePath, "sess_runner_1");
    await writeFile(fakeCodexPath, [
      "#!/usr/bin/env node",
      "process.stderr.write('token sk-private at /home/matrix/private\\n');",
      "console.log(JSON.stringify({type:'thread.started',thread_id:'019f-runner-thread'}));",
      "console.log(JSON.stringify({type:'item.started',item:{id:'item_cmd',type:'command_execution',command:'cat /home/matrix/private',aggregated_output:'',exit_code:null,status:'in_progress'}}));",
      "console.log(JSON.stringify({type:'item.completed',item:{id:'item_msg',type:'agent_message',text:'The route is fixed.'}}));",
      "console.log(JSON.stringify({type:'turn.completed'}));",
    ].join("\n"), "utf-8");
    await chmod(fakeCodexPath, 0o700);

    try {
      const runnerPath = join(
        process.cwd(),
        "packages/gateway/src/coding-agents/codex-runner.mjs",
      );
      const result = await runProcess(process.execPath, [
        runnerPath,
        eventPath,
        process.execPath,
        fakeCodexPath,
        "exec",
        "--json",
        "--",
        "Fix the route.",
      ], homePath);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("The route is fixed.");
      expect(result.stdout).toContain("Running command");
      expect(result.stdout).not.toMatch(/sk-private|\/home\/matrix\/private|cat \/home/);
      expect(result.stderr).not.toMatch(/sk-private|\/home\/matrix\/private/);
      const persisted = (await readFile(eventPath, "utf-8")).trim().split("\n");
      expect(persisted).toHaveLength(4);
      expect(persisted.map((line) => JSON.parse(line).type)).toEqual([
        "thread.started",
        "item.started",
        "item.completed",
        "turn.completed",
      ]);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("queues a follow-up and resumes the exact provider thread", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-codex-runner-resume-"));
    const fakeCodexPath = join(homePath, "fake-codex-resume.mjs");
    const callsPath = join(homePath, "calls.jsonl");
    const eventPath = codexProviderEventPath(homePath, "sess_runner_resume_1");
    await writeFile(fakeCodexPath, [
      "#!/usr/bin/env node",
      "import { appendFile } from 'node:fs/promises';",
      `await appendFile(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      "const resumed = process.argv.includes('resume');",
      "if (!resumed) console.log(JSON.stringify({type:'thread.started',thread_id:'019f-resume-thread'}));",
      "if (resumed) console.log(JSON.stringify({type:'item.completed',item:{id:'item_resume',type:'agent_message',text:'Continued.'}}));",
      "console.log(JSON.stringify({type:'turn.completed'}));",
    ].join("\n"), "utf-8");
    await chmod(fakeCodexPath, 0o700);

    try {
      const runnerPath = join(process.cwd(), "packages/gateway/src/coding-agents/codex-runner.mjs");
      const result = await runProcess(process.execPath, [
        runnerPath,
        eventPath,
        process.execPath,
        fakeCodexPath,
        "--ask-for-approval",
        "never",
        "exec",
        "--json",
        "--",
        "Start.",
      ], homePath, "Continue.\r");

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Continued.");
      const calls = (await readFile(callsPath, "utf-8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual([
        "--ask-for-approval",
        "never",
        "exec",
        "resume",
        "--json",
        "--skip-git-repo-check",
        "019f-resume-thread",
        "--",
        "Continue.",
      ]);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("refuses unverified installed versions before creating a watcher", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-codex-bridge-"));
    const bridge = createCodexEventBridge({
      homePath,
      pollIntervalMs: 60_000,
      runVersionCommand: vi.fn(async () => ({ stdout: "codex-cli 0.145.0\n", stderr: "" })),
    });
    try {
      await expect(bridge.watch({
        principal,
        threadId: "thread_version_1",
        sessionId: "sess_version_1",
      })).rejects.toThrow("Codex structured events are unavailable");
      expect(bridge.watcherCount()).toBe(0);
    } finally {
      await bridge.shutdown();
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("retries failed ingestion with stable event ids then advances the transcript cursor", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-codex-bridge-"));
    const eventPath = codexProviderEventPath(homePath, "sess_bridge_1");
    const batches: Array<{ events: Array<{ eventId: string; type: string }>; providerThreadId?: string }> = [];
    let shouldFail = true;
    const ingestProviderEvents = vi.fn(async (
      _principal: RequestPrincipal,
      _threadId: string,
      batch: { events: Array<{ eventId: string; type: string }>; providerThreadId?: string },
    ) => {
      batches.push(batch);
      if (shouldFail) throw new Error("temporary store failure");
      return {};
    });
    const bridge = createCodexEventBridge({
      homePath,
      pollIntervalMs: 60_000,
      runVersionCommand: vi.fn(async () => ({ stdout: "codex-cli 0.144.1\n", stderr: "" })),
    });
    bridge.attachThreadStore({ ingestProviderEvents });
    try {
      await bridge.watch({
        principal,
        threadId: "thread_bridge_1",
        sessionId: "sess_bridge_1",
      });
      await writeFile(eventPath, [
        JSON.stringify({ type: "thread.started", thread_id: "019f-bridge-thread" }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_1", type: "agent_message", text: "A real response." },
        }),
        JSON.stringify({ type: "turn.completed" }),
        "",
      ].join("\n"), "utf-8");

      await bridge.drain();
      const firstAttemptIds = batches.flatMap((batch) => batch.events.map((event) => event.eventId));
      expect(firstAttemptIds.length).toBeGreaterThan(0);

      shouldFail = false;
      batches.length = 0;
      await bridge.drain();
      const retryIds = batches.flatMap((batch) => batch.events.map((event) => event.eventId));
      expect(retryIds).toEqual(firstAttemptIds);
      expect(batches).toEqual(expect.arrayContaining([
        expect.objectContaining({ providerThreadId: "019f-bridge-thread" }),
        expect.objectContaining({
          events: expect.arrayContaining([
            expect.objectContaining({ type: "assistant.text.delta" }),
            expect.objectContaining({ type: "assistant.text.completed" }),
            expect.objectContaining({ type: "thread.completed", outcome: "completed" }),
          ]),
        }),
      ]));

      batches.length = 0;
      await bridge.drain();
      expect(batches).toEqual([]);
    } finally {
      await bridge.shutdown();
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("durably drains final provider records before removing an aborted session watcher", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-codex-runtime-abort-"));
    const batches: CodingAgentProviderEventBatch[] = [];
    const bridge = createCodexEventBridge({
      homePath,
      pollIntervalMs: 60_000,
      runVersionCommand: vi.fn(async () => ({ stdout: "codex-cli 0.144.1\n", stderr: "" })),
    });
    bridge.attachThreadStore({
      async ingestProviderEvents(_principal, _threadId, batch) {
        batches.push(batch);
      },
    });
    try {
      const sessionId = "sess_abort_final_1";
      await bridge.watch({ principal, threadId: "thread_abort_final_1", sessionId });
      await writeFile(codexProviderEventPath(homePath, sessionId), [
        JSON.stringify({ type: "thread.started", thread_id: "019f-abort-final" }),
        JSON.stringify({ type: "turn.failed", error: { message: "provider secret" } }),
        "",
      ].join("\n"), "utf-8");

      bridge.markStopped(sessionId);
      expect(bridge.watcherCount()).toBe(1);
      await bridge.drain();

      expect(bridge.watcherCount()).toBe(0);
      expect(batches).toEqual(expect.arrayContaining([
        expect.objectContaining({ providerThreadId: "019f-abort-final" }),
        expect.objectContaining({
          events: expect.arrayContaining([
            expect.objectContaining({ type: "thread.error" }),
            expect.objectContaining({ type: "thread.completed", outcome: "failed" }),
          ]),
        }),
      ]));
      expect(JSON.stringify(batches)).not.toContain("provider secret");
    } finally {
      await bridge.shutdown();
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("streams a real provider transcript through durable replay and event publication", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-codex-runtime-integration-"));
    const bridge = createCodexEventBridge({
      homePath,
      pollIntervalMs: 60_000,
      runVersionCommand: vi.fn(async () => ({ stdout: "codex-cli 0.144.1\n", stderr: "" })),
    });
    const runtime = {
      startSession: vi.fn(async () => ({
        ok: true as const,
        status: 201,
        session: {
          id: "sess_runtime_integration_1",
          runtime: { status: "running", zellijSession: "matrix-agent-runtime-integration" },
        },
      })),
      sendInput: vi.fn(async () => ({ ok: true as const, session: {} })),
      stopSession: vi.fn(async () => ({ ok: true as const, session: {} })),
    };
    const store = createCodingAgentThreadStore({
      homePath,
      providers: [createWorkspaceCodingAgentProvider({
        providerId: "codex",
        agent: "codex",
        runtime,
        codexEvents: bridge,
      })],
      now: () => new Date("2026-07-13T12:00:00.000Z"),
    });
    bridge.attachThreadStore(store);
    const sink = vi.fn();
    store.registerEventSink(sink);
    try {
      const created = await store.createThread(principal, {
        providerId: "codex",
        prompt: "Fix the route.",
        mode: "default",
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
        clientRequestId: "req_runtime_integration_1",
      });
      expect(created.snapshot.events.items.map((event) => event.type)).toEqual([
        "thread.created",
        "thread.status",
        "terminal.bound",
      ]);
      sink.mockClear();
      const sessionId = `sess_${created.snapshot.thread.id.slice("thread_".length)}`;
      await writeFile(codexProviderEventPath(homePath, sessionId), [
        JSON.stringify({ type: "thread.started", thread_id: "019f-runtime-integration" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.started",
          item: {
            id: "item_command_1",
            type: "command_execution",
            command: "pnpm test",
            aggregated_output: "",
            exit_code: null,
            status: "in_progress",
          },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_message_1", type: "agent_message", text: "The route is fixed." },
        }),
        JSON.stringify({ type: "turn.completed" }),
        "",
      ].join("\n"), "utf-8");

      await bridge.drain();

      const replay = await store.getThread(principal, created.snapshot.thread.id);
      expect(replay.thread.status).toBe("completed");
      expect(replay.events.items.map((event) => event.type)).toEqual(expect.arrayContaining([
        "thread.status",
        "tool.started",
        "assistant.text.delta",
        "assistant.text.completed",
        "thread.completed",
      ]));
      expect(sink).toHaveBeenCalledWith(expect.objectContaining({
        ownerId: principal.userId,
        threadId: created.snapshot.thread.id,
        events: expect.arrayContaining([
          expect.objectContaining({ type: "assistant.text.delta", delta: "The route is fixed." }),
        ]),
      }));
    } finally {
      await store.shutdownTurns();
      await bridge.shutdown();
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
