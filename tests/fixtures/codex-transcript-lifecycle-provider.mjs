import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  await appendFile(process.env.MATRIX_TEST_NATIVE_TRACE, `${line}\n`);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start" || request.method === "thread/resume") {
    send({ id: request.id, result: { thread: { id: request.params.threadId ?? "native_lifecycle" } } });
  }
  if (request.method === "turn/start") {
    const first = request.params.input.some(item => item.text?.includes("first request"));
    send({ id: request.id, result: { turn: { id: first ? "native_first" : "native_followup" } } });
    send({ method: "item/agentMessage/delta", params: { turnId: first ? "native_first" : "native_followup",
      itemId: first ? "first_answer" : "followup_answer", delta: first ? "original answer ".repeat(256) : "same conversation continued" } });
    send({ method: "turn/completed", params: { turn: { id: first ? "native_first" : "native_followup", status: "completed", items: [] } } });
  }
}
