import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";
import { parseCodexExecJsonLine } from "../../packages/gateway/src/coding-agents/codex-events.js";
import { parseCodingAgentProviderEvents, parseCodingAgentProviderEventBatch } from "../../packages/gateway/src/coding-agents/provider-adapter.js";

it("routes real-protocol child lifecycle through the runner without mixing assistant streams", async () => {
  const home = await mkdtemp("/tmp/codex-subagent-test-");
  const eventPath = codexProviderEventPath(home, "sess_subagent_test");
  const fake = join(home, "provider.mjs");
  const marker = (kind: string) => ({ method: "item/completed", params: {
    threadId: "native-parent", turnId: "parent-turn", item: {
      type: "subAgentActivity", id: `marker-${kind}`, kind, agentThreadId: "native-child", agentPath: "/root/arithmetic",
    },
  } });
  // Reduced from the 0.153.4 live spike, with identifiers replaced.
  const notifications = [
    marker("started"),
    { method: "turn/started", params: { threadId: "native-child", turn: { id: "child-turn", status: "inProgress", items: [] } } },
    { method: "item/agentMessage/delta", params: { threadId: "native-child", turnId: "child-turn", itemId: "child-message", delta: "437" } },
    { method: "thread/status/changed", params: { threadId: "native-child", status: { type: "idle" } } },
    { method: "turn/completed", params: { threadId: "native-child", turn: { id: "child-turn", status: "completed", items: [
      { type: "agentMessage", id: "child-message", text: "437", phase: "final_answer" },
    ] } } },
    marker("completed"),
    { method: "item/completed", params: { threadId: "native-parent", turnId: "parent-turn", item: { type: "agentMessage", id: "parent-message", text: "493", phase: "final_answer" } } },
    { method: "turn/completed", params: { threadId: "native-parent", turn: { id: "parent-turn", status: "completed", items: [] } } },
  ];
  await writeFile(fake, `import { createInterface } from 'node:readline';
const send = (value) => console.log(JSON.stringify(value));
let metadataReads = 0;
for await (const line of createInterface({ input: process.stdin })) {
 const message = JSON.parse(line);
 if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'test' } });
 if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'native-parent' } } });
 if (message.method === 'thread/read') send({ id: message.id, result: { thread: { id: message.params.threadId, parentThreadId: 'native-parent', agentRole: ++metadataReads === 1 ? null : 'explorer' } } });
 if (message.method === 'turn/start') {
   send({ id: message.id, result: { turn: { id: 'parent-turn' } } });
   setTimeout(() => { for (const [index, item] of ${JSON.stringify(notifications)}.entries()) setTimeout(() => send(item), index * 30); }, 30);
 }
}
`);
  const config = Buffer.from(JSON.stringify({ prompt: "Protocol test", approvalPolicy: "never", sandbox: "read-only", writableRoots: [home] })).toString("base64");
  const child = spawn(process.execPath, [join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs"), eventPath,
    process.version.slice(1), process.execPath, fake, config], { cwd: home, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const deadline = Date.now() + 8_000;
    let transcript = "";
    while (Date.now() < deadline) {
      transcript = await readFile(eventPath, "utf8").catch(() => "");
      if (transcript.includes('"type":"turn.completed"')) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(transcript).toContain('"type":"turn.completed"');
    let sequence = 0;
    const events = transcript.trim().split("\n").flatMap((line) => parseCodexExecJsonLine(line, {
      threadId: "thread_matrix", now: () => new Date(), nextEventId: () => `evt_${++sequence}`,
    }).events);
    expect(() => parseCodingAgentProviderEvents(events, "thread_matrix")).not.toThrow();
    const childEvents = events.filter((event) => event.type === "subagent.activity");
    expect(childEvents.at(-1)).toMatchObject({ subagent: { name: "arithmetic", status: "completed", result: "437", role: "explorer" } });
    expect(new Set(childEvents.map((event) => event.activityId)).size).toBe(1);
    expect(events.filter((event) => event.type === "assistant.text.delta").map((event) => event.delta)).toEqual(["493"]);
    expect(JSON.stringify(childEvents)).not.toMatch(/native-child|child-turn|\/root/);
    // The provider allowlist must admit the new event as well as the JSON parser.
    expect(() => parseCodingAgentProviderEventBatch({ events: childEvents }, "thread_matrix")).not.toThrow();
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.once("close", () => resolve()); });
    await rm(home, { recursive: true, force: true });
  }
}, 12_000);
