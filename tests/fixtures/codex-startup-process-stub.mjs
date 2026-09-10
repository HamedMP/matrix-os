import { EventEmitter } from "node:events";
import { appendFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";

// Controlled external process boundary for otherwise unobservable close races.
const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
let spawned = 0;
childProcess.spawn = () => {
  const attempt = ++spawned;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    pid: 100_000 + attempt, exitCode: null, signalCode: null,
  });
  let closeScheduled = false;
  let writes = Promise.resolve();
  child.stdin.on("data", (chunk) => {
    const message = JSON.parse(chunk.toString());
    writes = writes.then(() => appendFile(process.env.TEST_CODEX_STARTUP_REQUESTS,
      `${JSON.stringify({ attempt, method: message.method })}\n`));
    if (process.env.TEST_CODEX_STARTUP_MODE === "stdin_error") {
      queueMicrotask(() => child.stdin.emit("error", new Error("EPIPE private transport")));
    }
    if (process.env.TEST_CODEX_STARTUP_MODE === "ready_abort") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: "test" } })}\n`);
      queueMicrotask(() => process.emit("SIGTERM"));
    }
  });
  child.kill = () => {
    if (!closeScheduled) {
      closeScheduled = true;
      setTimeout(async () => {
        await writes;
        child.exitCode = 0;
        child.stdout.end(); child.stderr.end(); child.stdin.end();
        child.emit("close", 0, null);
      }, ["stdin_error", "ready_abort"].includes(process.env.TEST_CODEX_STARTUP_MODE) ? 20 : 6_500);
    }
    if (process.env.TEST_CODEX_STARTUP_MODE === "kill_error") throw new Error("EPERM private process detail");
    return true;
  };
  return child;
};
syncBuiltinESMExports();
