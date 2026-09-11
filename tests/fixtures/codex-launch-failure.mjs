import { createInterface } from "node:readline";
const mode = process.env.MATRIX_TEST_LAUNCH_FAILURE;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    if (mode === "handshake-exit") process.exit(7);
    if (mode !== "handshake-timeout") send({ id: request.id, result: {} });
  }
  if (request.method === "thread/start" || request.method === "thread/resume") send({ id: request.id, result: { thread: { id: "native_failure_test" } } });
  if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "native_failure_turn" } } });
    send({ method: "item/started", params: { turnId: "native_failure_turn", item: {
      id: "failed-mcp", type: "mcpToolCall", server: "fixture", tool: "read_only_probe", status: "inProgress",
    } } });
    // Let stdio flush; the real runner must settle this tool when the provider dies.
    setTimeout(() => {
      if (mode === "mcp-runner-exit") process.kill(process.ppid, "SIGKILL");
      process.exit(7);
    }, 50);
  }
}
