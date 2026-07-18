import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";

interface FakeRuntime {
  child: ChildProcess;
  controlPath: string;
  eventPath: string;
  homePath: string;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await lstat(path).then(() => true).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for runtime file");
}

async function waitForTranscript(path: string, pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const transcript = await readFile(path, "utf8").catch(() => "");
    if (pattern.test(transcript)) return transcript;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for provider transcript");
}

async function waitForExit(child: ChildProcess, timeoutMs = 3_000): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return Promise.race([
    new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }),
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Runner did not exit")), timeoutMs);
      timer.unref();
    }),
  ]);
}

async function sendControl(path: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.end(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("error", reject);
    socket.once("close", () => resolve(JSON.parse(response)));
  });
}

async function startFakeRuntime(
  name: string,
  handlerLines: string[],
  options: { initialTranscriptBytes?: number } = {},
): Promise<FakeRuntime> {
  const shortName = name.slice(0, 8);
  const homePath = await mkdtemp(join(tmpdir(), `mx-${shortName}-`));
  const fakePath = join(homePath, "fake-codex.mjs");
  const eventPath = codexProviderEventPath(homePath, `sess_${shortName}`);
  const controlPath = eventPath.replace(/\.jsonl$/, ".sock");
  if (options.initialTranscriptBytes) {
    await mkdir(dirname(eventPath), { recursive: true });
    await writeFile(eventPath, "x".repeat(options.initialTranscriptBytes), "utf8");
  }
  await writeFile(fakePath, [
    "#!/usr/bin/env node",
    "import { createInterface } from 'node:readline';",
    "const input = createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "for await (const line of input) {",
    "  const message = JSON.parse(line);",
    ...handlerLines.map((line) => `  ${line}`),
    "}",
  ].join("\n"), "utf8");
  await chmod(fakePath, 0o700);
  const config = Buffer.from(JSON.stringify({
    prompt: "Fix the route.",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    writableRoots: [homePath],
  }), "utf8").toString("base64");
  const runnerPath = join(
    process.cwd(),
    "packages/gateway/src/coding-agents/codex-app-server-runner.mjs",
  );
  const child = spawn(process.execPath, [
    runnerPath,
    eventPath,
    process.version.slice(1),
    process.execPath,
    fakePath,
    config,
  ], {
    cwd: homePath,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { child, controlPath, eventPath, homePath };
}

async function cleanup(runtime: FakeRuntime, socket?: Socket): Promise<void> {
  socket?.destroy();
  runtime.child.kill("SIGKILL");
  await rm(runtime.homePath, { recursive: true, force: true });
}

const initialize = "if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: { userAgent: 'fake', platformFamily: 'unix', platformOs: 'linux', codexHome: '/private/codex' } }));";
const startThread = "else if (message.method === 'thread/start') console.log(JSON.stringify({ id: message.id, result: { thread: { id: 'native-thread' }, model: 'codex', modelProvider: 'openai', cwd: '/private/project', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: {} } }));";

describe("Codex app-server runner reliability", () => {
  it("answers duplicate input questions with a fail-closed empty result", async () => {
    const runtime = await startFakeRuntime("duplicate_questions", [
      initialize,
      startThread,
      "else if (message.method === 'turn/start') {",
      "  console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'native-turn' } } }));",
      "  console.log(JSON.stringify({ id: 42, method: 'item/tool/requestUserInput', params: { threadId: 'native-thread', turnId: 'native-turn', itemId: 'native-item', questions: [{ id: 'duplicate', header: 'First', question: 'First question' }, { id: 'duplicate', header: 'Second', question: 'Second question' }] } }));",
      "} else if (message.id === 42 && JSON.stringify(message.result) === JSON.stringify({ answers: {} })) {",
      "  console.log(JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'completed' } } }));",
      "  process.exit(0);",
      "}",
    ]);

    try {
      await expect(waitForExit(runtime.child)).resolves.toBe(0);
      expect(await readFile(runtime.eventPath, "utf8")).not.toContain("user_input.requested");
    } finally {
      await cleanup(runtime);
    }
  });

  it("ignores unknown approval variants while preserving one safe known decision", async () => {
    const runtime = await startFakeRuntime("unknown_decision", [
      initialize,
      startThread,
      "else if (message.method === 'turn/start') {",
      "  console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'native-turn' } } }));",
      "  console.log(JSON.stringify({ id: 42, method: 'item/commandExecution/requestApproval', params: { threadId: 'native-thread', turnId: 'native-turn', itemId: 'native-item', availableDecisions: [{ futureGrant: { private: true } }, 'decline'] } }));",
      "} else if (message.id === 42 && message.result?.decision === 'decline') {",
      "  console.log(JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'completed' } } }));",
      "  process.exit(0);",
      "}",
    ]);

    try {
      const transcript = await waitForTranscript(runtime.eventPath, /approval\.requested/);
      const approval = transcript.trim().split("\n").map((line) => JSON.parse(line))[0];
      expect(approval.allowedDecisions).toEqual(["decline"]);
      await expect(sendControl(runtime.controlPath, {
        type: "approval",
        approvalId: approval.approvalId,
        decision: "decline",
        clientRequestId: "req_unknown_variant_decline",
      })).resolves.toEqual({ ok: true });
      await expect(waitForExit(runtime.child)).resolves.toBe(0);
    } finally {
      await cleanup(runtime);
    }
  });

  it("fails ambiguous native session grants closed", async () => {
    const runtime = await startFakeRuntime("ambiguous_grants", [
      initialize,
      startThread,
      "else if (message.method === 'turn/start') {",
      "  console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'native-turn' } } }));",
      "  console.log(JSON.stringify({ id: 42, method: 'item/commandExecution/requestApproval', params: { threadId: 'native-thread', turnId: 'native-turn', itemId: 'native-item', availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git status'] } }, { applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'allow', host: 'example.com' } } }, 'decline', 'cancel'] } }));",
      "} else if (message.id === 42) {",
      "  console.log(JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'completed' } } }));",
      "  process.exit(0);",
      "}",
    ]);

    try {
      const transcript = await waitForTranscript(runtime.eventPath, /approval\.requested/);
      const approval = transcript.trim().split("\n").map((line) => JSON.parse(line))[0];
      expect(approval.allowedDecisions).toEqual(["decline", "cancel"]);
      await expect(sendControl(runtime.controlPath, {
        type: "approval",
        approvalId: approval.approvalId,
        decision: "approve_for_session",
        clientRequestId: "req_ambiguous_grant",
      })).resolves.toEqual({ ok: false });
      await expect(sendControl(runtime.controlPath, {
        type: "approval",
        approvalId: approval.approvalId,
        decision: "decline",
        clientRequestId: "req_decline_ambiguous_grant",
      })).resolves.toEqual({ ok: true });
      await expect(waitForExit(runtime.child)).resolves.toBe(0);
    } finally {
      await cleanup(runtime);
    }
  });

  it("flushes a final frame without a newline before provider exit", async () => {
    const runtime = await startFakeRuntime("final_frame", [
      initialize,
      startThread,
      "else if (message.method === 'turn/start') {",
      "  console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'native-turn' } } }));",
      "  process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'completed' } } }));",
      "  process.stdout.end();",
      "  setTimeout(() => process.exit(0), 50);",
      "}",
    ]);

    try {
      await expect(waitForExit(runtime.child)).resolves.toBe(0);
      expect(await readFile(runtime.eventPath, "utf8")).toContain('"type":"turn.completed"');
    } finally {
      await cleanup(runtime);
    }
  });

  it("stops the long-lived provider on completed and failed turns", async () => {
    for (const terminalMethod of ["turn/completed", "turn/failed"] as const) {
      const runtime = await startFakeRuntime(`terminal_${terminalMethod.split("/")[1]}`, [
        initialize,
        startThread,
        "else if (message.method === 'turn/start') {",
        "  console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'native-turn' } } }));",
        `  console.log(JSON.stringify({ method: '${terminalMethod}', params: { turn: { status: 'failed' } } }));`,
        "  setInterval(() => {}, 1000);",
        "}",
      ]);

      try {
        const code = await waitForExit(runtime.child);
        const transcript = await readFile(runtime.eventPath, "utf8");
        expect(code).toBe(terminalMethod === "turn/completed" ? 0 : 1);
        expect(transcript).toContain(terminalMethod === "turn/completed"
          ? '"type":"turn.completed"'
          : '"type":"turn.failed"');
      } finally {
        await cleanup(runtime);
      }
    }
  });

  it("persists a failure when the provider exits after accepting a turn", async () => {
    const runtime = await startFakeRuntime("mid_turn_exit", [
      initialize,
      startThread,
      "else if (message.method === 'turn/start') {",
      "  console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'native-turn' } } }));",
      "  setTimeout(() => process.exit(7), 20);",
      "}",
    ]);

    try {
      await expect(waitForExit(runtime.child)).resolves.toBe(1);
      expect((await readFile(runtime.eventPath, "utf8")).slice(-1000))
        .toContain('"type":"turn.failed"');
    } finally {
      await cleanup(runtime);
    }
  });

  it("drains stalled control clients during terminal cleanup", async () => {
    const runtime = await startFakeRuntime("stalled_control", [
      initialize,
      startThread,
      "else if (message.method === 'turn/start') {",
      "  console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'native-turn' } } }));",
      "  setTimeout(() => console.log(JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'completed' } } })), 200);",
      "  setInterval(() => {}, 1000);",
      "}",
    ]);
    let socket: Socket | undefined;

    try {
      await waitForFile(runtime.controlPath);
      socket = createConnection(runtime.controlPath);
      await new Promise<void>((resolve, reject) => {
        socket?.once("connect", resolve);
        socket?.once("error", reject);
      });
      await expect(waitForExit(runtime.child, 4_000)).resolves.toBe(0);
      await expect(lstat(runtime.controlPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await cleanup(runtime, socket);
    }
  });

  it("handles provider output failures through terminal cleanup", async () => {
    const runtime = await startFakeRuntime("output_failure", [
      initialize,
      startThread,
      "else if (message.method === 'turn/start') {",
      "  console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'native-turn' } } }));",
      "  console.log(JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'a'.repeat(1000) } }));",
      "  setInterval(() => {}, 1000);",
      "}",
    ], { initialTranscriptBytes: 16 * 1024 * 1024 - 100 });

    try {
      await expect(waitForExit(runtime.child)).resolves.toBe(1);
      expect((await readFile(runtime.eventPath, "utf8")).slice(-1000))
        .toContain('"type":"turn.failed"');
      await expect(lstat(runtime.controlPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await cleanup(runtime);
    }
  });
});
