import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start" || request.method === "thread/resume") {
    send({ id: request.id, result: { thread: { id: "native_idle_test" } } });
  }
  if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "native_turn_test" } } });
    send({ method: "item/agentMessage/delta", params: { turnId: "native_turn_test", itemId: "message_test", delta: "Task started and remains active." } });
    if (!process.env.MATRIX_TEST_KEEP_ACTIVE) {
      send({ method: "turn/completed", params: { turn: { id: "native_turn_test", status: "completed", items: [] } } });
    }
  }
}
