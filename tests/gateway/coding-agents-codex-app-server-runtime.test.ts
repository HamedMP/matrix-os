import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";
import { parseCodexExecJsonLine } from "../../packages/gateway/src/coding-agents/codex-events.js";

async function waitForTranscript(path: string, pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await readFile(path, "utf8").catch(() => "");
    if (pattern.test(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for Codex transcript");
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
}

async function sendControl(path: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Control response timed out"));
    }, 2_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.end(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("error", reject);
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve(JSON.parse(response));
    });
  });
}

describe("Codex app-server control runtime", () => {
  it("durably publishes a safe approval before accepting one idempotent decision", async () => {
    const homePath = await mkdtemp(join("/tmp", "codex-appr-"));
    const fakeCodexPath = join(homePath, "fake-codex-app-server.mjs");
    const responsesPath = join(homePath, "responses.jsonl");
    const eventPath = codexProviderEventPath(homePath, "sess_appr_1");
    const controlPath = eventPath.replace(/\.jsonl$/, ".sock");
    await writeFile(fakeCodexPath, [
      "#!/usr/bin/env node",
      "import { appendFile } from 'node:fs/promises';",
      "import { createInterface } from 'node:readline';",
      `const responsesPath = ${JSON.stringify(responsesPath)};`,
      "const input = createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "for await (const line of input) {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') {",
      "    console.log(JSON.stringify({ id: message.id, result: { userAgent: 'fake', platformFamily: 'unix', platformOs: 'linux', codexHome: '/private/codex' } }));",
      "  } else if (message.method === 'thread/start') {",
      "    console.log(JSON.stringify({ id: message.id, result: { thread: { id: 'native-thread-secret' }, model: 'codex', modelProvider: 'openai', cwd: '/private/project', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: {} } }));",
      "  } else if (message.method === 'turn/start') {",
      "    console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'native-turn-secret' } } }));",
      "    console.log(JSON.stringify({ id: 42, method: 'item/commandExecution/requestApproval', params: { threadId: 'native-thread-secret', turnId: 'native-turn-secret', itemId: 'native-item-secret', command: 'cat /home/matrix/.codex/auth.json', cwd: '/private/project', availableDecisions: [{ applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'allow', host: 'private.internal' } } }, 'decline', 'cancel'] } }));",
      "  } else if (message.id === 42) {",
      "    await appendFile(responsesPath, JSON.stringify(message) + '\\n');",
      "    console.log(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'native-thread-secret', turnId: 'native-turn-secret', itemId: 'message-1', delta: 'Approved and continuing.' } }));",
      "    console.log(JSON.stringify({ method: 'turn/completed', params: { threadId: 'native-thread-secret', turn: { id: 'native-turn-secret', status: 'completed', items: [] } } }));",
      "    process.exit(0);",
      "  }",
      "}",
    ].join("\n"), "utf8");
    await chmod(fakeCodexPath, 0o700);

    const runnerPath = join(
      process.cwd(),
      "packages/gateway/src/coding-agents/codex-app-server-runner.mjs",
    );
    const config = Buffer.from(JSON.stringify({
      prompt: "Fix the route.",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      writableRoots: [homePath],
    }), "utf8").toString("base64");
    const child = spawn(process.execPath, [
      runnerPath,
      eventPath,
      process.version.slice(1),
      process.execPath,
      fakeCodexPath,
      config,
    ], {
      cwd: homePath,
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const beforeDecision = await waitForTranscript(eventPath, /matrix\.codex\.approval\.requested/);
      const approval = beforeDecision.trim().split("\n").map((line) => JSON.parse(line))
        .find((event) => event.type === "matrix.codex.approval.requested");
      expect(approval.approvalId).toMatch(/^appr_codex_[a-f0-9]{32}$/);
      expect(beforeDecision).not.toMatch(/auth\.json|private\/project|private\.internal|native-|"42"|:42/);

      const control = {
        type: "approval",
        approvalId: approval.approvalId,
        decision: "approve_for_session",
        clientRequestId: "req_control_1",
      };
      await expect(sendControl(controlPath, {
        ...control,
        approvalId: "appr_codex_00000000000000000000000000000000",
        clientRequestId: "req_control_unknown",
      })).resolves.toEqual({ ok: false });
      await expect(sendControl(controlPath, control)).resolves.toEqual({ ok: true });
      await expect(sendControl(controlPath, control)).resolves.toEqual({ ok: true, replayed: true });
      await expect(sendControl(controlPath, { ...control, decision: "decline" })).resolves.toEqual({ ok: false });
      await expect(waitForExit(child)).resolves.toBe(0);

      const responses = (await readFile(responsesPath, "utf8")).trim().split("\n");
      expect(responses).toHaveLength(1);
      expect(JSON.parse(responses[0]!)).toEqual({
        id: 42,
        result: {
          decision: {
            applyNetworkPolicyAmendment: {
              network_policy_amendment: { action: "allow", host: "private.internal" },
            },
          },
        },
      });
      await expect(lstat(controlPath)).rejects.toMatchObject({ code: "ENOENT" });
      const transcript = await readFile(eventPath, "utf8");
      expect(transcript).toContain('"type":"matrix.codex.assistant.delta"');
      expect(transcript).toContain('"type":"turn.completed"');
      expect(transcript).not.toMatch(/auth\.json|private\/project|native-/);
    } finally {
      child.kill("SIGTERM");
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("maps structured answers to native questions without persisting secret input", async () => {
    const homePath = await mkdtemp(join("/tmp", "codex-input-"));
    const fakeCodexPath = join(homePath, "fake-codex-input.mjs");
    const responsesPath = join(homePath, "responses.jsonl");
    const eventPath = codexProviderEventPath(homePath, "sess_input_1");
    const controlPath = eventPath.replace(/\.jsonl$/, ".sock");
    await writeFile(fakeCodexPath, [
      "#!/usr/bin/env node",
      "import { appendFile } from 'node:fs/promises';",
      "import { createInterface } from 'node:readline';",
      `const responsesPath = ${JSON.stringify(responsesPath)};`,
      "const input = createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "for await (const line of input) {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: { userAgent: 'fake', platformFamily: 'unix', platformOs: 'linux', codexHome: '/private/codex' } }));",
      "  else if (message.method === 'thread/start') console.log(JSON.stringify({ id: message.id, result: { thread: { id: 'native-thread-input' }, model: 'codex', modelProvider: 'openai', cwd: '/private/project', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: {} } }));",
      "  else if (message.method === 'turn/start') {",
      "    console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'native-turn-input' } } }));",
      "    console.log(JSON.stringify({ id: 'rpc-input-secret', method: 'item/tool/requestUserInput', params: { threadId: 'native-thread-input', turnId: 'native-turn-input', itemId: 'native-item-input', questions: [{ id: 'native-approach', header: 'Approach', question: 'Which approach for /home/matrix/private-question?', options: [{ label: 'Minimal', description: 'Use /home/matrix/private-question.' }], isOther: true, isSecret: false }, { id: 'native-secret', header: 'Secret', question: 'Enter the temporary value.', options: null, isOther: false, isSecret: true }] } }));",
      "  } else if (message.id === 'rpc-input-secret') {",
      "    await appendFile(responsesPath, JSON.stringify(message) + '\\n');",
      "    console.log(JSON.stringify({ method: 'turn/completed', params: { threadId: 'native-thread-input', turn: { id: 'native-turn-input', status: 'completed', items: [] } } }));",
      "    process.exit(0);",
      "  }",
      "}",
    ].join("\n"), "utf8");
    await chmod(fakeCodexPath, 0o700);

    const runnerPath = join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs");
    const config = Buffer.from(JSON.stringify({
      prompt: "Ask before continuing.",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      writableRoots: [homePath],
    }), "utf8").toString("base64");
    const child = spawn(process.execPath, [
      runnerPath,
      eventPath,
      process.version.slice(1),
      process.execPath,
      fakeCodexPath,
      config,
    ], {
      cwd: homePath,
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const beforeAnswer = await waitForTranscript(eventPath, /matrix\.codex\.user_input\.requested/);
      const request = beforeAnswer.trim().split("\n").map((line) => JSON.parse(line))
        .find((event) => event.type === "matrix.codex.user_input.requested");
      expect(request.requestId).toMatch(/^req_codex_[a-f0-9]{32}$/);
      expect(request.questions).toHaveLength(2);
      expect(request.questions[0]).toMatchObject({
        question: "The coding agent needs an answer.",
        options: [{ label: "Minimal", description: "Choose this option." }],
      });
      expect(beforeAnswer).not.toMatch(/native-|rpc-input-secret|private\/project|private-question/);

      const [approach, secret] = request.questions;
      await expect(sendControl(controlPath, {
        type: "input",
        requestId: request.requestId,
        structuredAnswers: {
          [approach.questionId]: ["Minimal"],
          [secret.questionId]: ["temporary-secret-value"],
        },
        clientRequestId: "req_control_input_1",
      })).resolves.toEqual({ ok: true });
      await expect(waitForExit(child)).resolves.toBe(0);

      const providerResponse = JSON.parse((await readFile(responsesPath, "utf8")).trim());
      expect(providerResponse).toEqual({
        id: "rpc-input-secret",
        result: {
          answers: {
            "native-approach": { answers: ["Minimal"] },
            "native-secret": { answers: ["temporary-secret-value"] },
          },
        },
      });
      const transcript = await readFile(eventPath, "utf8");
      expect(transcript).not.toContain("temporary-secret-value");
      expect(transcript).not.toMatch(/native-|rpc-input-secret|private\/project/);
    } finally {
      child.kill("SIGTERM");
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("caps pending requests and fails the excess request closed", async () => {
    const homePath = await mkdtemp(join("/tmp", "codex-cap-"));
    const fakeCodexPath = join(homePath, "fake-codex-cap.mjs");
    const responsesPath = join(homePath, "responses.jsonl");
    const eventPath = codexProviderEventPath(homePath, "sess_cap_1");
    await writeFile(fakeCodexPath, [
      "#!/usr/bin/env node",
      "import { appendFile } from 'node:fs/promises';",
      "import { createInterface } from 'node:readline';",
      `const responsesPath = ${JSON.stringify(responsesPath)};`,
      "const input = createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "for await (const line of input) {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: { userAgent: 'fake', platformFamily: 'unix', platformOs: 'linux', codexHome: '/private/codex' } }));",
      "  else if (message.method === 'thread/start') console.log(JSON.stringify({ id: message.id, result: { thread: { id: 'native-thread-cap' }, model: 'codex', modelProvider: 'openai', cwd: '/private/project', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: {} } }));",
      "  else if (message.method === 'turn/start') {",
      "    console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'native-turn-cap' } } }));",
      "    for (let index = 0; index < 21; index += 1) console.log(JSON.stringify({ id: 100 + index, method: 'item/commandExecution/requestApproval', params: { threadId: 'native-thread-cap', turnId: 'native-turn-cap', itemId: `native-item-${index}`, availableDecisions: ['accept', 'cancel'] } }));",
      "  } else if (message.id >= 100) {",
      "    await appendFile(responsesPath, JSON.stringify(message) + '\\n');",
      "    console.log(JSON.stringify({ method: 'turn/completed', params: { threadId: 'native-thread-cap', turn: { id: 'native-turn-cap', status: 'completed', items: [] } } }));",
      "    process.exit(0);",
      "  }",
      "}",
    ].join("\n"), "utf8");
    await chmod(fakeCodexPath, 0o700);
    const runnerPath = join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs");
    const config = Buffer.from(JSON.stringify({
      prompt: "Exercise the request cap.",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      writableRoots: [homePath],
    }), "utf8").toString("base64");
    const child = spawn(process.execPath, [
      runnerPath,
      eventPath,
      process.version.slice(1),
      process.execPath,
      fakeCodexPath,
      config,
    ], {
      cwd: homePath,
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await expect(waitForExit(child)).resolves.toBe(0);
      const responses = (await readFile(responsesPath, "utf8")).trim().split("\n");
      expect(responses.map((line) => JSON.parse(line))).toEqual([
        { id: 120, result: { decision: "cancel" } },
      ]);
      const transcript = (await readFile(eventPath, "utf8")).trim().split("\n");
      expect(transcript.filter((line) => JSON.parse(line).type === "matrix.codex.approval.requested"))
        .toHaveLength(20);
      expect(transcript.join("\n")).not.toContain("native-");
    } finally {
      child.kill("SIGTERM");
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("publishes typed app-server items without exposing provider payloads", async () => {
    const homePath = await mkdtemp(join("/tmp", "codex-items-"));
    const fakeCodexPath = join(homePath, "fake-codex-items.mjs");
    const eventPath = codexProviderEventPath(homePath, "sess_items_1");
    await writeFile(fakeCodexPath, [
      "#!/usr/bin/env node",
      "import { createInterface } from 'node:readline';",
      "const input = createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "for await (const line of input) {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: { userAgent: 'fake', platformFamily: 'unix', platformOs: 'linux', codexHome: '/private/codex' } }));",
      "  else if (message.method === 'thread/start') console.log(JSON.stringify({ id: message.id, result: { thread: { id: 'native-thread-items' }, model: 'codex', modelProvider: 'openai', cwd: '/private/project', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: {} } }));",
      "  else if (message.method === 'turn/start') {",
      "    console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'native-turn-items' } } }));",
      "    console.log(JSON.stringify({ method: 'item/started', params: { threadId: 'native-thread-items', turnId: 'native-turn-items', item: { id: 'native-commentary-item', type: 'agentMessage', text: '', phase: 'commentary' } } }));",
      "    for (const delta of ['I will ', 'inspect ', 'the repository.']) console.log(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'native-thread-items', turnId: 'native-turn-items', itemId: 'native-commentary-item', delta } }));",
      "    console.log(JSON.stringify({ method: 'item/completed', params: { threadId: 'native-thread-items', turnId: 'native-turn-items', item: { id: 'native-commentary-item', type: 'agentMessage', text: 'I will inspect the repository.', phase: 'commentary' } } }));",
      "    console.log(JSON.stringify({ method: 'item/started', params: { threadId: 'native-thread-items', turnId: 'native-turn-items', item: { id: 'native-command-item', type: 'commandExecution', command: 'cat /home/matrix/.codex/auth.json', cwd: '/private/project', aggregatedOutput: '', exitCode: null, status: 'inProgress', durationMs: null } } }));",
      "    console.log(JSON.stringify({ method: 'item/commandExecution/outputDelta', params: { threadId: 'native-thread-items', turnId: 'native-turn-items', itemId: 'native-command-item', delta: 'secret-token-output' } }));",
      "    console.log(JSON.stringify({ method: 'item/completed', params: { threadId: 'native-thread-items', turnId: 'native-turn-items', item: { id: 'native-command-item', type: 'commandExecution', command: 'cat /home/matrix/.codex/auth.json', cwd: '/private/project', aggregatedOutput: 'secret-token-output', exitCode: 0, status: 'completed', durationMs: 12 } } }));",
      "    console.log(JSON.stringify({ method: 'item/started', params: { threadId: 'native-thread-items', turnId: 'native-turn-items', item: { id: 'native-final-item', type: 'agentMessage', text: '', phase: 'final_answer' } } }));",
      "    console.log(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'native-thread-items', turnId: 'native-turn-items', itemId: 'native-final-item', delta: 'The repository is ready.' } }));",
      "    console.log(JSON.stringify({ method: 'item/completed', params: { threadId: 'native-thread-items', turnId: 'native-turn-items', item: { id: 'native-final-item', type: 'agentMessage', text: 'The repository is ready.', phase: 'final_answer' } } }));",
      "    console.log(JSON.stringify({ method: 'turn/completed', params: { threadId: 'native-thread-items', turn: { id: 'native-turn-items', status: 'completed', items: [] } } }));",
      "  }",
      "}",
    ].join("\n"), "utf8");
    await chmod(fakeCodexPath, 0o700);
    const runnerPath = join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs");
    const config = Buffer.from(JSON.stringify({
      prompt: "Inspect the repository.",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      writableRoots: [homePath],
    }), "utf8").toString("base64");
    const child = spawn(process.execPath, [
      runnerPath,
      eventPath,
      process.version.slice(1),
      process.execPath,
      fakeCodexPath,
      config,
    ], { cwd: homePath, stdio: ["ignore", "pipe", "pipe"] });
    try {
      const transcript = await waitForTranscript(eventPath, /The repository is ready/);
      expect(transcript).not.toMatch(/native-|auth\.json|private\/project|secret-token-output/);

      let sequence = 0;
      const events = transcript.trim().split("\n").flatMap((line) => parseCodexExecJsonLine(line, {
        threadId: "thread_matrix_1",
        now: () => new Date("2026-08-21T10:00:00.000Z"),
        nextEventId: () => `evt_${++sequence}`,
      }).events);
      expect(events.map((event) => event.type)).toEqual([
        "assistant.text.delta",
        "assistant.text.completed",
        "tool.started",
        "tool.output",
        "tool.completed",
        "assistant.text.delta",
        "assistant.text.completed",
      ]);
      const [commentaryDelta, commentaryCompleted, toolStarted, toolOutput, toolCompleted, finalDelta, finalCompleted] = events;
      expect(commentaryDelta).toMatchObject({ type: "assistant.text.delta", delta: "I will inspect the repository." });
      expect(commentaryCompleted).toMatchObject({
        type: "assistant.text.completed",
        messageId: commentaryDelta && "messageId" in commentaryDelta ? commentaryDelta.messageId : undefined,
      });
      expect(toolStarted).toMatchObject({ type: "tool.started", displayName: "Run command", kind: "command" });
      expect(toolOutput).toMatchObject({ type: "tool.output", text: "Command produced output.", truncated: true });
      expect(toolCompleted).toMatchObject({ type: "tool.completed", outcome: "success" });
      expect(finalDelta).toMatchObject({ type: "assistant.text.delta", delta: "The repository is ready." });
      expect(finalCompleted).toMatchObject({
        type: "assistant.text.completed",
        messageId: finalDelta && "messageId" in finalDelta ? finalDelta.messageId : undefined,
      });
      expect(commentaryDelta && "messageId" in commentaryDelta ? commentaryDelta.messageId : undefined)
        .not.toBe(finalDelta && "messageId" in finalDelta ? finalDelta.messageId : undefined);
      expect(toolStarted && "toolCallId" in toolStarted ? toolStarted.toolCallId : undefined)
        .toBe(toolCompleted && "toolCallId" in toolCompleted ? toolCompleted.toolCallId : undefined);
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child).catch(() => undefined);
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("keeps one provider thread alive for queued Matrix turns and applies each turn selection", async () => {
    const homePath = await mkdtemp(join("/tmp", "codex-turns-"));
    const fakeCodexPath = join(homePath, "fake-codex-turns.mjs");
    const requestsPath = join(homePath, "turn-requests.jsonl");
    const eventPath = codexProviderEventPath(homePath, "sess_turns_1");
    await writeFile(fakeCodexPath, [
      "#!/usr/bin/env node",
      "import { appendFile } from 'node:fs/promises';",
      "import { createInterface } from 'node:readline';",
      `const requestsPath = ${JSON.stringify(requestsPath)};`,
      "const input = createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "let turn = 0;",
      "for await (const line of input) {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: { userAgent: 'fake', platformFamily: 'unix', platformOs: 'linux', codexHome: '/private/codex' } }));",
      "  else if (message.method === 'thread/start') console.log(JSON.stringify({ id: message.id, result: { thread: { id: 'native-thread-turns' }, model: message.params.model, modelProvider: 'openai', cwd: '/private/project', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: {} } }));",
      "  else if (message.method === 'turn/start') {",
      "    turn += 1;",
      "    await appendFile(requestsPath, JSON.stringify(message.params) + '\\n');",
      "    console.log(JSON.stringify({ id: message.id, result: { turn: { id: `native-turn-${turn}` } } }));",
      "    console.log(JSON.stringify({ method: 'item/agentMessage/delta', params: { turnId: `native-turn-${turn}`, itemId: `native-message-${turn}`, delta: `answer-${turn}` } }));",
      "    console.log(JSON.stringify({ method: 'turn/completed', params: { turn: { id: `native-turn-${turn}`, status: 'completed', items: [] } } }));",
      "  }",
      "}",
    ].join("\n"), "utf8");
    await chmod(fakeCodexPath, 0o700);
    const runnerPath = join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs");
    const config = Buffer.from(JSON.stringify({
      prompt: "First turn.",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      writableRoots: [homePath],
      model: "gpt-5.6-sol",
      effort: "low",
      serviceTier: "fast",
    }), "utf8").toString("base64");
    const child = spawn(process.execPath, [
      runnerPath,
      eventPath,
      process.version.slice(1),
      process.execPath,
      fakeCodexPath,
      config,
    ], { cwd: homePath, stdio: ["pipe", "pipe", "pipe"] });
    const secondTurn = Buffer.from(JSON.stringify({
      prompt: "Second turn.",
      model: "gpt-5.6-terra",
      modelOptions: [
        { id: "effort", value: "high" },
        { id: "service_tier", value: "standard" },
      ],
    }), "utf8").toString("base64");
    child.stdin?.write(`matrix-turn-v2:${secondTurn}\n`);

    try {
      await waitForTranscript(eventPath, /answer-2/);
      const requests = (await readFile(requestsPath, "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        threadId: "native-thread-turns",
        input: [{ type: "text", text: "First turn.", text_elements: [] }],
        model: "gpt-5.6-sol",
        effort: "low",
        serviceTier: "fast",
      });
      expect(requests[1]).toMatchObject({
        threadId: "native-thread-turns",
        input: [{ type: "text", text: "Second turn.", text_elements: [] }],
        model: "gpt-5.6-terra",
        effort: "high",
        serviceTier: "standard",
      });
      const transcript = await readFile(eventPath, "utf8");
      expect(transcript.match(/"type":"turn.completed"/g)).toHaveLength(2);
      expect(transcript).toContain("answer-1");
      expect(transcript).toContain("answer-2");
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child).catch(() => undefined);
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("keeps accepting Turns through the control socket after terminal stdin closes", async () => {
    const homePath = await mkdtemp(join("/tmp", "codex-control-turns-"));
    const fakeCodexPath = join(homePath, "fake-codex-control-turns.mjs");
    const eventPath = codexProviderEventPath(homePath, "sess_control_turns_1");
    const controlPath = eventPath.replace(/\.jsonl$/, ".sock");
    await writeFile(fakeCodexPath, [
      "#!/usr/bin/env node",
      "import { createInterface } from 'node:readline';",
      "const input = createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "let turn = 0;",
      "for await (const line of input) {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: { userAgent: 'fake', platformFamily: 'unix', platformOs: 'linux', codexHome: '/private/codex' } }));",
      "  else if (message.method === 'thread/start') console.log(JSON.stringify({ id: message.id, result: { thread: { id: 'native-thread-control' }, modelProvider: 'openai', cwd: '/private/project', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: {} } }));",
      "  else if (message.method === 'turn/start') {",
      "    turn += 1;",
      "    console.log(JSON.stringify({ id: message.id, result: { turn: { id: `native-turn-${turn}` } } }));",
      "    console.log(JSON.stringify({ method: 'item/agentMessage/delta', params: { turnId: `native-turn-${turn}`, itemId: `native-message-${turn}`, delta: `control-answer-${turn}` } }));",
      "    console.log(JSON.stringify({ method: 'turn/completed', params: { turn: { id: `native-turn-${turn}`, status: 'completed', items: [] } } }));",
      "  }",
      "}",
    ].join("\n"), "utf8");
    await chmod(fakeCodexPath, 0o700);
    const runnerPath = join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs");
    const config = Buffer.from(JSON.stringify({
      prompt: "First turn.",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      writableRoots: [homePath],
    }), "utf8").toString("base64");
    const child = spawn(process.execPath, [
      runnerPath,
      eventPath,
      process.version.slice(1),
      process.execPath,
      fakeCodexPath,
      config,
    ], { cwd: homePath, stdio: ["ignore", "pipe", "pipe"] });

    try {
      await waitForTranscript(eventPath, /control-answer-1/);
      await expect(sendControl(controlPath, {
        type: "turn",
        prompt: "Second turn.",
        modelOptions: [],
        clientRequestId: "req_control_turn_2",
      })).resolves.toEqual({ ok: true });
      const transcript = await waitForTranscript(eventPath, /control-answer-2/);
      expect(transcript.match(/"type":"turn.completed"/g)).toHaveLength(2);
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child).catch(() => undefined);
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("persists a generic failure and removes the control socket when the provider exits", async () => {
    const homePath = await mkdtemp(join("/tmp", "codex-exit-"));
    const fakeCodexPath = join(homePath, "fake-codex-exit.mjs");
    const eventPath = codexProviderEventPath(homePath, "sess_exit_1");
    const controlPath = eventPath.replace(/\.jsonl$/, ".sock");
    await writeFile(fakeCodexPath, [
      "#!/usr/bin/env node",
      "import { createInterface } from 'node:readline';",
      "const input = createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "for await (const line of input) {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') {",
      "    console.log(JSON.stringify({ id: message.id, result: { userAgent: 'fake', platformFamily: 'unix', platformOs: 'linux', codexHome: '/private/codex' } }));",
      "    process.stderr.write('token-secret at /private/project\\n');",
      "  } else if (message.method === 'thread/start') process.exit(7);",
      "}",
    ].join("\n"), "utf8");
    await chmod(fakeCodexPath, 0o700);
    const runnerPath = join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs");
    const config = Buffer.from(JSON.stringify({
      prompt: "Start a turn.",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      writableRoots: [homePath],
    }), "utf8").toString("base64");
    const child = spawn(process.execPath, [
      runnerPath,
      eventPath,
      process.version.slice(1),
      process.execPath,
      fakeCodexPath,
      config,
    ], {
      cwd: homePath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    try {
      await expect(waitForExit(child)).resolves.toBe(1);
      expect(await readFile(eventPath, "utf8")).toBe('{"type":"turn.failed"}\n');
      expect(stderr).not.toMatch(/token-secret|private\/project/);
      await expect(lstat(controlPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      child.kill("SIGTERM");
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
