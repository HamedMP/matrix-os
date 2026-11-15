import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { attachManagedLaunchWrapper } from "./managed-launch-wrapper.mjs";
// Service-owned stdin keeps the structured Codex runner alive between turns.
// Subsequent prompts, approvals and steering use its existing authenticated Unix socket.
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const launchPath = process.argv[2];
if (!launchPath) throw new Error("Background launch unavailable");
const launchFile = await open(launchPath, constants.O_RDONLY | constants.O_NOFOLLOW);
let parsed;
const expectedDigest = process.argv[3];
try {
  if ((await launchFile.stat()).size > 1024 * 1024) throw new Error("Background launch too large");
  const bytes = await launchFile.readFile();
  if (expectedDigest && (!/^[a-f0-9]{64}$/.test(expectedDigest) || createHash("sha256").update(bytes).digest("hex") !== expectedDigest)) throw new Error("Private launch mismatch");
  parsed = JSON.parse(bytes.toString("utf8"));
} finally { await launchFile.close(); }
const { command, args, cwd, env } = parsed.launch;
if (typeof command !== "string" || !Array.isArray(args) || args.some(arg => typeof arg !== "string")
  || typeof cwd !== "string" || !env || typeof env !== "object") throw new Error("Background launch invalid");
const privateControl = !!expectedDigest;
if (privateControl && (command !== process.execPath || args[0] !== fileURLToPath(new URL("./codex-app-server-runner.mjs", import.meta.url)))) throw new Error("Private launch mismatch");
const logPath = join(dirname(launchPath), "output.log");
let log = await open(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
let size = (await log.stat()).size;
let writes = Promise.resolve();
const child = spawn(command, args, { cwd, env: parsed.launch.inheritEnv === false ? env : { ...process.env, ...env }, stdio: privateControl ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"] });
const privateChannel = privateControl ? attachManagedLaunchWrapper(child, expectedDigest) : undefined;
function consume(stream) {
  stream.on("data", chunk => {
    stream.pause();
    writes = writes.then(async () => {
      if (size + chunk.length > 1024 * 1024) {
        await log.close();
        await rm(`${logPath}.1`, { force: true });
        await rename(logPath, `${logPath}.1`);
        log = await open(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        size = 0;
      }
      await log.write(chunk);
      size += chunk.length;
    }).then(() => stream.resume()).catch(error => {
      process.stderr.write(`Background log failed: ${error.name}\n`);
      child.kill("SIGKILL");
      stream.resume();
    });
  });
}
consume(child.stdout);
consume(child.stderr);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { child.kill(signal); });
const exitCode = await new Promise(resolve => {
  child.once("error", () => resolve(1));
  child.once("close", code => resolve(code ?? 1));
});
privateChannel?.close();
await writes;
await log.close();
process.exitCode = exitCode;
