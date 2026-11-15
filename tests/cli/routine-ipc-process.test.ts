import { afterEach, expect, it } from "vitest";
import { fork, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { resolve } from "node:path";
const children: ChildProcess[] = [];
afterEach(async () => { for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise<void>(done => child.once("close", () => done())); } });
function launched(onRequest: (child: ChildProcess) => void, argv = ["list", "--json"]) {
  const child = fork(resolve("packages/sync-client/bin/matrix.mjs"), ["routines", ...argv], { execArgv: [], silent: true,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, MATRIX_NO_TELEMETRY: "1" } }); children.push(child);
  let stdout = "", stderr = "";
  child.stdout!.on("data", chunk => { stdout += chunk; }); child.stderr!.on("data", chunk => { stderr += chunk; });
  child.once("message", () => onRequest(child)); child.stdin!.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  return { child, result: new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    child.once("error", reject); child.once("exit", code => { clearTimeout(timer); done({ code, stdout, stderr }); });
  }) };
}
it.each(["malformed", "oversized", "depth", "repeat", "disconnect", "cancel"])("actual published relay/parser closes safely for %s host protocol", async fault => {
  const p = launched(child => {
    if (fault === "disconnect") { child.disconnect(); return; }
    if (fault === "repeat") { for (let n = 0; n < 6; n++) child.send({ v: 1, type: "routine.cancel" }, () => undefined); return; }
    child.send(fault === "oversized" ? { padding: "x".repeat(32769) } : fault === "depth" ? { nested: Array.from({ length: 20 }).reduce(value => ({ nested: value }), {}) }
      : fault === "cancel" ? { v: 1, type: "routine.cancel" } : { v: 1, type: "routine.capability", endpoint: "http://untrusted.invalid/wrong", token: "private-malformed" }, () => undefined);
  });
  const result = await p.result; expect(result.code).not.toBe(0); expect(result.stdout + result.stderr).not.toContain("private-malformed");
  if (result.stdout.trim()) expect(JSON.parse(result.stdout)).toHaveProperty("error.code", "unavailable");
});
it("actual relay rejects and never forwards a native handle", async () => {
  const server = createServer(); await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const p = launched(child => child.send({ v: 1, type: "routine.cancel" }, server, () => undefined));
    const result = await p.result; expect(result.code).not.toBe(0); expect(result.stdout).not.toContain('"ok":true');
  } finally { await new Promise<void>(done => server.close(() => done())); }
});
it("open proposal stdin is time bounded by actual command", async () => {
  const child = fork(resolve("packages/sync-client/bin/matrix.mjs"), ["routines", "propose", "--input", "-", "--request-id", "de000000-0000-4000-8000-000000000100", "--json"], { execArgv: [], silent: true,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, MATRIX_NO_TELEMETRY: "1" } }); children.push(child);
  let stdout = ""; child.stdout!.on("data", chunk => { stdout += chunk; }); const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  try { const code = await new Promise<number | null>(done => child.once("close", done)); expect(code).toBe(2); expect(JSON.parse(stdout)).toHaveProperty("error.code", "invalid_input"); }
  finally { clearTimeout(timer); }
}, 10000);

it("SIGKILL of the actual published wrapper drains its observed nested parser", async () => {
  const inspect = promisify(execFile);
  let parserPid: number | undefined;
  let reached!: () => void;
  const requested = new Promise<void>(done => { reached = done; });
  const p = launched(() => reached());
  const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false; throw error;
  } };
  try {
    await requested;
    const result = await inspect("ps", ["-axo", "pid=,ppid="], { timeout: 1000 });
    const pids = result.stdout.trim().split("\n").map(row => row.trim().split(/\s+/).map(Number))
      .filter(([, parentPid]) => parentPid === p.child.pid).map(([pid]) => pid);
    expect(pids).toHaveLength(1); parserPid = pids[0]; expect(parserPid).toBeGreaterThan(0);
    expect(running(parserPid!)).toBe(true);
    p.child.kill("SIGKILL"); await p.result;
    const deadline = Date.now() + 3000;
    while (running(parserPid!) && Date.now() < deadline) await new Promise(done => setTimeout(done, 25));
    expect(running(parserPid!)).toBe(false);
  } finally {
    if (parserPid && running(parserPid)) process.kill(parserPid, "SIGKILL");
  }
});
