import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";

/** Real production entrypoint and HTTP listener; only the test DB and synthetic
 * identity configuration are supplied. No provider or controller credentials. */
export async function startCandidateProcess(env: NodeJS.ProcessEnv) {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Test port unavailable");
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const child = spawn(process.execPath, ["--import=tsx", "packages/platform/src/main.ts"], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, NODE_OPTIONS: "--max-old-space-size=512", ...env,
      NODE_ENV: "production", PLATFORM_PORT: String(address.port), PLATFORM_RUNTIME_MODE: "local",
      PLATFORM_BACKGROUND_WORKERS_ENABLED: "false" },
  });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  let bytes = 0;
  let diagnostic = "";
  let ready: (() => void) | undefined;
  const listening = new Promise<void>(resolve => { ready = resolve; });
  // Bounded, discarded child diagnostics: never print test DB credentials or raw errors.
  const observe = (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes <= 64 * 1024) diagnostic += chunk.toString("utf8");
    if (bytes > 64 * 1024) child.kill("SIGTERM");
    if (chunk.toString("utf8").includes("Platform listening on")) ready?.();
  };
  child.stdout.on("data", observe); child.stderr.on("data", observe);
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try { return await exited; } finally { clearTimeout(timer); }
  }
  const timeout = AbortSignal.timeout(25_000);
  try {
    await Promise.race([listening, exited.then(code => {
      // Report one sanitized cause, never raw PG structures or complete child logs.
      let cause = diagnostic.split("\n").find(line => /(?:Error|error)(?: \[[A-Z_]+\])?:/.test(line)) ?? diagnostic.trim().split("\n").slice(-3).join(" ");
      for (const value of Object.values(env)) if (value && value.length >= 8) cause = cause.replaceAll(value, "<redacted>");
      if (env.PLATFORM_DATABASE_URL) cause = cause.replaceAll(new URL(env.PLATFORM_DATABASE_URL).password, "<redacted>");
      cause = cause.replace(/postgres(?:ql)?:\/\/[^\s]+/g, "<redacted>");
      throw new Error(`Candidate process exited before listening (${code}): ${cause.slice(0, 400)}`);
    }),
      new Promise<never>((_, reject) => timeout.addEventListener("abort", () => reject(new Error("Candidate startup timed out")), { once: true }))]);
    return { origin: `http://127.0.0.1:${address.port}`, stop };
  } catch (error: unknown) { await stop(); throw error; }
}
