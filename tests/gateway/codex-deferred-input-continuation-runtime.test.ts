import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCodexControlClient } from "../../packages/gateway/src/coding-agents/codex-control-client.js";
import { codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";

async function transcript(path: string, pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await readFile(path, "utf8").catch(error => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (pattern.test(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Native transcript did not arrive");
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.kill("SIGTERM");
  await exited;
}

it("delivers a deferred answer over the production Codex socket into the exact active turn", async () => {
  const homePath = await mkdtemp("/tmp/codex-deferred-answer-");
  const nativePath = join(homePath, "fake-native.mjs");
  const sessionId = "sess_deferred_answer";
  const eventPath = codexProviderEventPath(homePath, sessionId);
  await writeFile(nativePath, [
    "import { createInterface } from 'node:readline';",
    "const input = createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "let starts = 0; let deferred = false;",
    "for await (const line of input) {",
    "  const message = JSON.parse(line);",
    "  if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: { userAgent: 'fake', platformFamily: 'unix', platformOs: 'linux', codexHome: '/private/codex' } }));",
    "  else if (message.method === 'thread/start') console.log(JSON.stringify({ id: message.id, result: { thread: { id: 'native-thread-answer' }, modelProvider: 'openai', cwd: '/private/project', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: {} } }));",
    "  else if (message.method === 'turn/start') {",
    "    starts++;",
    "    console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'native-turn-answer' } } }));",
    "    console.log(JSON.stringify({ id: 'native-input', method: 'item/tool/requestUserInput', params: { threadId: 'native-thread-answer', turnId: 'native-turn-answer', itemId: 'native-input-item', questions: [{ id: 'label', header: 'Label', question: 'Alpha or Beta?', options: [{ label: 'Alpha', description: 'Alpha' }, { label: 'Beta', description: 'Beta' }], isOther: false, isSecret: false }] } }));",
    "  } else if (message.id === 'native-input') {",
    "    if (!message.result.answers.label.answers[0].includes('user has NOT answered')) process.exit(44);",
    "    deferred = true;",
    "    // Ordinary wait-for-answer work deliberately stays in this active turn.",
    "  } else if (message.method === 'turn/steer') {",
    "    const same = deferred && starts === 1 && message.params.threadId === 'native-thread-answer' && message.params.expectedTurnId === 'native-turn-answer' && message.params.clientUserMessageId === 'req_answer_live' && message.params.input[0].text.includes('Alpha');",
    "    if (!same) console.log(JSON.stringify({ id: message.id, error: { code: -32600, message: 'wrong turn' } }));",
    "    else {",
    "      console.log(JSON.stringify({ id: message.id, result: { turnId: 'native-turn-answer' } }));",
    "      console.log(JSON.stringify({ method: 'item/agentMessage/delta', params: { turnId: 'native-turn-answer', itemId: 'native-answer', delta: 'QA_NORMAL_ALPHA' } }));",
    "      console.log(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'native-turn-answer', status: 'completed', items: [] } } }));",
    "    }",
    "  }",
    "}",
  ].join("\n"), "utf8");
  await chmod(nativePath, 0o700);
  const config = Buffer.from(JSON.stringify({ prompt: "Ask Alpha or Beta. Wait for my answer, then echo it.", approvalPolicy: "on-request", sandbox: "workspace-write", writableRoots: [homePath] })).toString("base64");
  const child = spawn(process.execPath, [join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs"), eventPath, process.version.slice(1), process.execPath, nativePath, config], { cwd: homePath, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const before = await transcript(eventPath, /matrix\.codex\.user_input\.requested/);
    const question = before.trim().split("\n").map(line => JSON.parse(line)).find(event => event.type === "matrix.codex.user_input.requested");
    const controls = createCodexControlClient({ homePath, timeoutMs: 3_000 });
    await controls.deferInput({ sessionId, inputRequestId: question.requestId, clientRequestId: `defer_${question.requestId}` });
    expect(await readFile(eventPath, "utf8")).not.toContain('"type":"turn.completed"');
    await controls.steerTurn({ sessionId, clientRequestId: "req_answer_live", prompt: `[Matrix: answer]\n${JSON.stringify({ requestId: question.requestId, answers: { label: ["Alpha"] } })}` });
    const completed = await transcript(eventPath, /"type":"turn\.completed"/);
    expect(completed).toContain("QA_NORMAL_ALPHA");
    expect(completed.match(/"type":"turn\.completed"/g)).toHaveLength(1);
    expect(completed).not.toContain('"outcome":"aborted"');
    expect(child.exitCode).toBeNull();
  } finally {
    await stop(child); await rm(homePath, { recursive: true, force: true });
  }
});
