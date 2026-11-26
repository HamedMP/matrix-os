import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import Ajv from "ajv";
import { expect, it } from "vitest";
import { codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";
import { createCodexControlClient } from "../../packages/gateway/src/coding-agents/codex-control-client.js";

it.each([false, true])("pins automatic, full and human permissions through the native runner (resume=%s)", async resume => {
  const homePath = await mkdtemp("/tmp/codex-native-permissions-");
  const nativePath = join(homePath, "provider.mjs"), framesPath = join(homePath, "frames.jsonl");
  const eventPath = codexProviderEventPath(homePath, "sess_permissions");
  const runnerPath = join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs");
  const schema = JSON.parse(gunzipSync(await readFile(new URL("../fixtures/codex-0162/app-server-schema-0162.json.gz", import.meta.url))).toString());
  const ajv = new Ajv();
  for (const [name, minimum, maximum] of [
    ["uint64", 0, Number.MAX_SAFE_INTEGER], ["uint", 0, Number.MAX_SAFE_INTEGER],
    ["int64", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], ["uint32", 0, 2 ** 32 - 1],
    ["int32", -(2 ** 31), 2 ** 31 - 1], ["uint16", 0, 65535], ["uint8", 0, 255],
  ] as const) ajv.addFormat(name, { type: "number", validate: (value: number) => Number.isInteger(value) && value >= minimum && value <= maximum });
  ajv.addFormat("double", { type: "number", validate: Number.isFinite });
  const validate = (name: string, value: unknown) => {
    const check = ajv.compile({ definitions: schema.definitions, $ref: `#/definitions/v2/${name}` });
    expect(check(value), JSON.stringify(check.errors)).toBe(true);
  };
  await writeFile(nativePath, `
    import { appendFile } from 'node:fs/promises';
    import { createInterface } from 'node:readline';
    let turn = 0;
    for await (const line of createInterface({ input: process.stdin })) {
      const message = JSON.parse(line);
      if (message.id === undefined) continue;
      await appendFile(${JSON.stringify(framesPath)}, JSON.stringify(message) + '\\n');
      let result = {};
      if (message.method === 'initialize') result = { userAgent: 'fixture', platformFamily: 'unix', platformOs: 'linux', codexHome: '/tmp' };
      if (message.method === 'thread/start' || message.method === 'thread/resume') result = { thread: { id: message.params.threadId ?? 'native_permissions' }, modelProvider: 'openai' };
      if (message.method === 'turn/start') result = { turn: { id: 'native-' + (++turn), status: 'inProgress', items: [] } };
      console.log(JSON.stringify({ id: message.id, result }));
      if (message.method === 'turn/start') console.log(JSON.stringify({ method: 'turn/completed', params: { turn: { ...result.turn, status: 'completed' } } }));
    }
  `);
  const config = Buffer.from(JSON.stringify({ prompt: "First turn", ...(resume ? { providerThreadId: "native_permissions" } : {}),
    approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write", writableRoots: [homePath] })).toString("base64");
  const child = spawn(process.execPath, [runnerPath, eventPath, process.version.slice(1), process.execPath, nativePath, config],
    { cwd: homePath, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  const frames = async () => {
    try { return (await readFile(framesPath, "utf8")).trim().split("\n").map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  const control = createCodexControlClient({ homePath });
  try {
    await expect.poll(async () => (await frames()).filter(frame => frame.method === "turn/start").length).toBe(1);
    const started = (await frames()).find(frame => frame.method === (resume ? "thread/resume" : "thread/start"));
    validate(resume ? "ThreadResumeParams" : "ThreadStartParams", started.params);
    expect(started.params).toMatchObject({ approvalsReviewer: "auto_review", approvalPolicy: "on-request", sandbox: "workspace-write" });
    await control.submitTurn({ sessionId: "sess_permissions", turnId: "turn_full", prompt: "Full access",
      modelOptions: [], approvalPolicy: "never", sandboxMode: "full_access" });
    await expect.poll(async () => (await frames()).filter(frame => frame.method === "turn/start").length).toBe(2);
    await control.submitTurn({ sessionId: "sess_permissions", turnId: "turn_human", prompt: "Ask me again",
      modelOptions: [], approvalPolicy: "on_request", sandboxMode: "workspace_write" });
    await expect.poll(async () => (await frames()).filter(frame => frame.method === "turn/start").length).toBe(3);
    const turns = (await frames()).filter(frame => frame.method === "turn/start").map(frame => frame.params);
    for (const turn of turns) validate("TurnStartParams", turn);
    expect(turns).toMatchObject([
      { approvalsReviewer: "auto_review", approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false } },
      { approvalsReviewer: "user", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
      { approvalsReviewer: "user", approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", writableRoots: [homePath], networkAccess: false } },
    ]);
  } finally {
    child.kill("SIGTERM");
    await exited;
    await rm(homePath, { recursive: true, force: true });
  }
}, 20_000);
