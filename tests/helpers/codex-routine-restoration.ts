import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { ManagedShimFrameSchema, parseManagedFrame, type ManagedShimFrame, type ManagedHostFrame } from "../../packages/gateway/src/coding-agents/managed-launch-protocol.mjs";
export const restorationId = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Real runner/native child lifecycle and 0.162.1 schema boundary. Private admission/model/MCP/metadata are named fixtures, not Matrix authority or native-account acceptance. */
export async function startRestorationRunner(home: string, name: string, options: { prompt: string; providerThreadId?: string }) {
  const historyFile = join(home, "native-history.json"), records = join(home, name + "-native.jsonl"), fixture = join(home, name + "-fixture.json"), executable = join(home, name + "-native.mjs"), eventPath = join(home, name + "-events.jsonl");
  await writeFile(fixture, JSON.stringify({ historyFile, records, intent: { args: ["list"] }, turns: 99 }));
  await writeFile(executable, `#!${process.execPath}\nif (process.argv.includes('--version')) console.log('codex 0.162.1'); else { process.env.TEST_ROUTINE_NATIVE_FILE=${JSON.stringify(fixture)}; await import(${JSON.stringify(pathToFileURL(resolve("tests/fixtures/codex-routine-process.mjs")).href)}); }\n`);
  await chmod(executable, 0o700); await writeFile(eventPath, "");
  const config = Buffer.from(JSON.stringify({ ...options, routinePrivate: true, approvalPolicy: "never", sandbox: "workspace-write", writableRoots: [home] })).toString("base64");
  const child = spawn(process.execPath, [resolve("packages/gateway/src/coding-agents/codex-app-server-runner.mjs"), eventPath, "0.162.1", executable, config], { cwd: home, stdio: ["pipe", "pipe", "pipe", "ipc"], serialization: "json", env: { PATH: process.env.PATH, HOME: home, MATRIX_NO_TELEMETRY: "1" } });
  const messages: ManagedShimFrame[] = [], updates = new EventEmitter(); let diagnostic = "";
  child.stdout!.resume(); child.stderr!.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4096); });
  const exited = new Promise<void>(done => child.once("close", () => { updates.emit("exit"); done(); }));
  const send = (frame: ManagedHostFrame) => { if (!child.connected) throw new Error("Named private fixture disconnected"); child.send(frame); };
  child.on("message", raw => {
    const frame = parseManagedFrame(ManagedShimFrameSchema, raw);
    if (!frame || messages.length >= 128) { updates.emit("failure", new Error("Named private fixture rejected a frame")); return; }
    messages.push(frame);
    if (frame.type === "shim.ready") send({ type: "host.ready", wrapper: restorationId(99), shim: frame.shim, digest: "a".repeat(64) });
    // Deliberately unavailable host execution fixture: never fabricate a positive CLI/backend receipt.
    if (frame.type === "shim.call") send({ type: "host.result", admissionId: frame.admissionId, actionId: frame.actionId, result: '{"v":1,"error":{"code":"unavailable","message":"Routine requests are temporarily unavailable."}}' });
    updates.emit("frame", frame);
  });
  async function waitFrame(predicate: (frame: ManagedShimFrame) => boolean): Promise<ManagedShimFrame> {
    const known = messages.find(predicate); if (known) return known;
    return new Promise((done, reject) => {
      const frame = (value: ManagedShimFrame) => { if (predicate(value)) { cleanup(); done(value); } };
      const failure = (error: Error) => { cleanup(); reject(error); };
      const exit = () => failure(new Error("Named runner exited: " + diagnostic));
      const timeout = setTimeout(() => failure(new Error("Named runner frame missing: " + diagnostic)), 5000);
      const cleanup = () => { clearTimeout(timeout); updates.off("frame", frame); updates.off("failure", failure); updates.off("exit", exit); };
      updates.on("frame", frame); updates.on("failure", failure); updates.on("exit", exit);
    });
  }
  return { child, messages, historyFile, send, waitFrame,
    async first(admissionId: string) { await waitFrame(frame => frame.type === "shim.ready"); send({ type: "host.turn", first: true, admissionId }); },
    async completed(count: number) {
      await new Promise<void>((done, reject) => {
        let settled = false;
        const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timeout); observer.close(); if (error) reject(error); else done(); };
        const inspect = async () => { const text = await readFile(eventPath, "utf8"); if (text.split("\n").filter(line => line.includes('"type":"turn.completed"')).length >= count) finish(); };
        const observer = watch(eventPath, () => { void inspect().catch(error => finish(error)); });
        const timeout = setTimeout(() => { void Promise.all([readFile(eventPath, "utf8"), readFile(records, "utf8").catch(error => String(error.code))]).then(([events, native]) => finish(new Error("Native completion not persisted: " + diagnostic + " events=" + events.slice(-2048) + " native=" + native.slice(-2048) + " private=" + JSON.stringify(messages.map(frame => frame.type))))); }, 5000);
        observer.on("error", finish); void inspect().catch(error => finish(error));
      });
    },
    async frames() { return (await readFile(records, "utf8")).trim().split("\n").map(line => JSON.parse(line)) as Array<{ method?: string; params?: Record<string, unknown>; id?: number; result?: unknown; fixtureEvent?: string; pid?: number }>; },
    async history() { return JSON.parse(await readFile(historyFile, "utf8")) as { threadId: string; prompts: string[]; turnCount: number; dynamicTools: unknown[] }; },
    async close() { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); const force = setTimeout(() => child.kill("SIGKILL"), 1500); await exited; clearTimeout(force); updates.removeAllListeners(); },
  };
}
