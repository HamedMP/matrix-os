import { createInterface } from "node:readline";

const mode = process.env.MATRIX_TEST_TERMINAL_FAILURE;
const threadId = "native_failure_thread";
const turnId = "native_failure_turn";
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => console.log(JSON.stringify(value));
for await (const line of input) {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fixture" } });
  else if (message.method === "thread/start") {
    if (mode === "rpc_auth") send({ id: message.id, error: { code: -1, message: "workspace routing discovery unauthorized (401)" } });
    else send({ id: message.id, result: { thread: { id: threadId } } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: turnId } } });
    if (mode === "watchdog") continue;
    const typed = {
      usage: "usageLimitExceeded", notification: "usageLimitExceeded",
      context: "contextWindowExceeded", session_budget: "sessionBudgetExceeded",
      overload: "serverOverloaded", policy: "cyberPolicy", invalid_request: "badRequest",
      sandbox: "sandboxError", history: "threadRollbackFailed", internal: "internalServerError",
      credit: { httpConnectionFailed: { httpStatusCode: 402 } },
      rate: { httpConnectionFailed: { httpStatusCode: 429 } },
      timeout: { httpConnectionFailed: { httpStatusCode: 408 } },
      permission: { httpConnectionFailed: { httpStatusCode: 403 } },
      disconnect: { responseStreamDisconnected: { httpStatusCode: null } },
    };
    const error = { message: "workspace routing discovery unauthorized (401) /home/private bearer fixture-secret",
      codexErrorInfo: typed[mode] ?? "other" };
    if (["notification", "stale", "child", "retry_success"].includes(mode)) send({ method: "error", params: {
      threadId: mode === "child" ? "native_child_thread" : threadId,
      turnId: mode === "stale" ? "stale_turn" : turnId,
      willRetry: mode === "retry_success", error,
    } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId,
      status: mode === "retry_success" ? "completed" : "failed",
      ...((mode === "auth" || Object.hasOwn(typed, mode) && mode !== "notification") ? { error } : {}),
    } } });
    process.exit(0);
  }
}
