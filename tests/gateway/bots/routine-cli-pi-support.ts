import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCanonicalCodingChatProviderAdapter } from "../../../packages/gateway/src/chat/coding-provider-adapter.js";
import { createPiCodingAgentProvider } from "../../../packages/gateway/src/coding-agents/pi-provider.js";
import { createCodingAgentThreadStore } from "../../../packages/gateway/src/coding-agents/thread-store.js";
import { nativePiRoutineSource } from "../../../packages/gateway/src/chat/pi-routine-source.js";
import { claudeFixture } from "./routine-cli-claude-support.js";
/** Native version/auth/API/RPC/model fixtures; production canonical driver, owned extension callback,
 * exact retained FD/source/controller, published CLI/private IPC/Hono/owner PostgreSQL/target remain real. */
export async function piFixture(native: { operation: unknown; order?: "fd-first" | "event-first"; hold?: boolean; holdDrain?: boolean; version?: string;
  sessionId?: string; callId?: string; event?: Record<string, unknown>; duplicate?: boolean; terminalBefore?: boolean; noFd?: boolean }) {
  const f = await claudeFixture({ sourceDriver: "pi" }), home = await mkdtemp("/tmp/rpi-");
  const records = join(home, "records"), config = join(home, "fixture.json");
  await writeFile(records, ""); await writeFile(config, JSON.stringify({ ...native, records }));
  const children: ChildProcess[] = [];
  let observedTerminal = 0;
  const orderTrace: string[] = [];
  const provider = createPiCodingAgentProvider({ homePath: home, resolveCredentialLaunch: async () => ({ env: {} }),
    runCommand: async () => ({ stdout: (native.version ?? "1.0.0") + "\n", stderr: "" }),
    spawnFn(_command, args, options) {
      const source = nativePiRoutineSource();
      if (source) {
        const observe = source.observeEvent;
        source.observeEvent = value => { observe(value); const event = value as { type: string };
          if (event.type === "tool_execution_start") orderTrace.push("observed-running");
          if (event.type === "tool_execution_end") observedTerminal++;
        };
      }
      const child = spawn(process.execPath, [resolve("tests/fixtures/pi-routine-process.mjs"), config, ...args], { cwd: options.cwd,
        env: { PATH: process.env.PATH, HOME: home, MATRIX_NO_TELEMETRY: "1" }, stdio: native.noFd ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "pipe"] });
      children.push(child);
      if (options.routineFd) {
        let buffer = "", observed = false;
        child.stdio[3]?.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8"); if (Buffer.byteLength(buffer) > 196608) throw new Error("Named native FD barrier exceeded cap");
          if (!observed && buffer.includes("\n")) { observed = true; orderTrace.push("fd-callback"); if (native.order === "fd-first") queueMicrotask(() => child.stdin!.write(JSON.stringify({ type: "fixture_observe" }) + "\n")); }
        });
      }
      return child;
    },
  });
  const threads = createCodingAgentThreadStore({ homePath: home, providers: [provider] });
  const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "pi", threads, homePath: home, routineCli: { runtime: f.runtime, ...f.transport } });
  f.setSourceAdapter(adapter);
  const frames = async () => (await readFile(records, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  const send = (frame: unknown) => { const child = children.at(-1); if (!child?.stdin) throw new Error("Named native fixture child unavailable"); child.stdin.write(JSON.stringify(frame) + "\n"); };
  return { ...f, home, children, frames, send, threads, orderTrace, observedTerminal: () => observedTerminal,
    async start(chatId: string, modes = { permission: "supervised", interaction: "default" }) {
      const admitted = await f.start(chatId, modes);
      return admitted;
    },
    async close() { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await threads.shutdownTurns(); await f.close(); await rm(home, { recursive: true, force: true }); },
  };
}
