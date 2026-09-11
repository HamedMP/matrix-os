import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const statePath = process.env.TEST_CODEX_STARTUP_STATE;
const requestsPath = process.env.TEST_CODEX_STARTUP_REQUESTS;
let previous = 0;
try { previous = Number(await readFile(statePath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const attempt = previous + 1;
await writeFile(statePath, String(attempt));
const failures = Number(process.env.TEST_CODEX_STARTUP_FAILURES ?? 1);
const mode = process.env.TEST_CODEX_STARTUP_MODE;
let initializeId;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
process.on("SIGTERM", () => {
  if (mode === "late_ready") {
    console.log(JSON.stringify({ id: initializeId, result: { userAgent: "late" } }));
    console.log(JSON.stringify({ method: "item/agentMessage/delta", params: {
      turnId: "late_turn", itemId: "late_item", delta: "Discard late startup output" } }));
  }
  setTimeout(() => {
    void appendFile(requestsPath, `${JSON.stringify({ attempt, event: "stopped" })}\n`).then(() => process.exit(0));
  }, mode === "late_ready" ? 100 : 0);
});
for await (const line of input) {
  const message = JSON.parse(line);
  await appendFile(requestsPath, `${JSON.stringify({ attempt, method: message.method })}\n`);
  if (message.method === "initialize") {
    initializeId = message.id;
    if (mode === "rejected") {
      console.log(JSON.stringify({ id: message.id, error: { message: "private authentication rejected", code: -1 } }));
      continue;
    }
    if (mode === "malformed") { console.log("malformed initialization"); continue; }
    if (mode === "no_result") { console.log(JSON.stringify({ id: message.id })); continue; }
    if (mode === "wrong_id" && attempt <= failures) {
      console.log(JSON.stringify({ id: "unrelated_response", result: {} })); continue;
    }
    if (attempt <= failures) continue;
    if (process.env.TEST_CODEX_STARTUP_READY_GATE) {
      for (;;) {
        try { await readFile(process.env.TEST_CODEX_STARTUP_READY_GATE); break; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    console.log(JSON.stringify({ id: message.id, result: { userAgent: "test" } }));
  } else if (message.method === "thread/start") {
    console.log(JSON.stringify({ id: message.id, result: { thread: { id: "startup_thread" } } }));
  } else if (message.method === "turn/start") {
    console.log(JSON.stringify({ id: message.id, result: { turn: { id: "startup_turn" } } }));
    console.log(JSON.stringify({ method: "item/agentMessage/delta", params: {
      turnId: "startup_turn", itemId: "startup_message", delta: "Started exactly once." } }));
    console.log(JSON.stringify({ method: "turn/completed", params: { turn: { status: "completed" } } }));
    process.exit(0);
  }
}
