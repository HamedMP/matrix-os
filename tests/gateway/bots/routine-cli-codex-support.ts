import { managedLaunchOverflow } from "../../helpers/managed-launch-overflow.js";
import { Transform } from "node:stream";
import type { ManagedShimFrame } from "../../../packages/gateway/src/coding-agents/managed-launch-protocol.mjs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { vi } from "vitest";
import { claudeFixture } from "./routine-cli-claude-support.js";
import { createAgentSessionManager } from "../../../packages/gateway/src/agent-session-manager.js";
import { createAgentLauncher } from "../../../packages/gateway/src/agent-launcher.js";
import { createBackgroundAgentRuntime } from "../../../packages/gateway/src/background-agent-runtime.js";
import { createWorktreeManager } from "../../../packages/gateway/src/worktree-manager.js";
import { createWorkspaceSessionOrchestrator } from "../../../packages/gateway/src/workspace-session-orchestrator.js";
import { createWorkspaceCodingAgentProvider } from "../../../packages/gateway/src/coding-agents/workspace-provider.js";
import { createCodexEventBridge } from "../../../packages/gateway/src/coding-agents/codex-event-bridge.js";
import { createCodexControlClient } from "../../../packages/gateway/src/coding-agents/codex-control-client.js";
import { createCodingAgentThreadStore } from "../../../packages/gateway/src/coding-agents/thread-store.js";
import { createCanonicalCodingChatProviderAdapter } from "../../../packages/gateway/src/chat/coding-provider-adapter.js";

/** Real canonical admission/registry/thread store/workspace/manager/launch/wrapper/shim/CLI/HTTP/PG.
 * Native model/auth readiness/sandbox preflight and Linux systemd transport are named fixtures. */
export async function codexFixture(native: { intent?: { args: string[]; stdin?: string }; intents?: Array<{ args: string[]; stdin?: string }>; loseQueuedAck?: boolean; receiverHalfClose?: boolean; wrapperOverflow?: boolean; calls?: Record<string, unknown>[]; turns?: number; holdAfterResult?: boolean; endBeforeResult?: boolean } = {}) {
  const f = await claudeFixture({ sourceDriver: "codex" });
  const home = await mkdtemp("/tmp/rc-"); // Keep the real Unix control socket below macOS sun_path bounds.
  const records = join(home, "native-requests.jsonl"), fixture = join(home, "native-fixture.json"), executable = join(home, "named-codex-native-fixture.mjs");
  const controlFile = join(home, "native-control");
  await writeFile(fixture, JSON.stringify({ records, controlFile, ...native }));
  await writeFile(executable, `#!${process.execPath}\nif (process.argv.includes('--version')) console.log('codex 0.162.1'); else { process.env.TEST_ROUTINE_NATIVE_FILE = ${JSON.stringify(fixture)}; await import(${JSON.stringify(pathToFileURL(resolve("tests/fixtures/codex-routine-process.mjs")).href)}); }\n`);
  await chmod(executable, 0o700);
  const overflow = native.wrapperOverflow ? await managedLaunchOverflow(home) : undefined;
  const privateFrames: ManagedShimFrame[] = [];
  let halfCloseReceiver: () => void = () => { throw new Error("Named receiver EOF fixture is not ready"); };
  const services = new Map<string, { child: ChildProcessWithoutNullStreams; closed: Promise<unknown> }>();
  const launched: Array<{ args: string[]; descriptor: string }> = [];
  const background = createBackgroundAgentRuntime({ homePath: home, withLock: async (_path, work) => work(),
    // Named Linux systemd transport fixture. The inherited anonymous pipes, wrapper and shim are actual processes.
    spawnPrivate(_command, args, options) {
      const unit = args.find(arg => arg.startsWith("--unit="))!.slice(7), commandAt = args.indexOf("--") + 1;
      const child = spawn(args[commandAt], [...(overflow ? ["--import", overflow.preload] : []), ...args.slice(commandAt + 1)], { stdio: options.stdio, env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, MATRIX_NO_TELEMETRY: "1" } });
      let privateBuffer = "";
      child.stdout.on("data", chunk => {
        privateBuffer += chunk.toString("utf8");
        if (Buffer.byteLength(privateBuffer) > 196608) throw new Error("Named private fixture frame exceeded cap");
        let newline;
        while ((newline = privateBuffer.indexOf("\n")) >= 0) {
          const line = privateBuffer.slice(0, newline); privateBuffer = privateBuffer.slice(newline + 1);
          if (privateFrames.length >= 128) privateFrames.shift(); privateFrames.push(JSON.parse(line));
        }
      });
      if (native.loseQueuedAck || native.receiverHalfClose) {
        let buffer = "", first: string | undefined;
        const filtered = new Transform({ transform(chunk: Buffer, _encoding, done) {
          buffer += chunk.toString("utf8");
          if (Buffer.byteLength(buffer) > 196608) { done(new Error("Named lost-ACK fixture frame exceeded cap")); return; }
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); const frame = JSON.parse(line);
            if (native.loseQueuedAck && frame.type === "shim.accepted") { first ??= frame.admissionId; if (frame.admissionId !== first) continue; }
            this.push(line + "\n");
          }
          done();
        } });
        const heldOutput = child.stdout; heldOutput.pipe(filtered);
        if (native.receiverHalfClose) halfCloseReceiver = () => { heldOutput.unpipe(filtered); filtered.end(); };
        Object.defineProperty(child, "stdout", { value: filtered });
      }
      const closed = new Promise(done => child.once("close", done)); services.set(unit, { child, closed });
      launched.push({ args, descriptor: args.at(-2)! }); return child;
    },
    runCommand: async (_command, args) => {
      if (args.includes("show")) return { stdout: args.filter(arg => arg.endsWith(".service")).map(unit => {
        const child = services.get(unit)?.child, active = !!child && child.exitCode === null && child.signalCode === null;
        return `Id=${unit}\nLoadState=loaded\nActiveState=${active ? "active" : "inactive"}\nSubState=${active ? "running" : "dead"}\n`;
      }).join("\n"), stderr: "" };
      if (args.includes("stop")) { const service = services.get(args.at(-1)!); service?.child.kill("SIGTERM"); await service?.closed; return { stdout: "", stderr: "" }; }
      throw new Error("Unimplemented named systemd fixture operation");
    },
  });
  const worktreeManager = createWorktreeManager({ homePath: home, runCommand: vi.fn(async () => ({ stdout: "", stderr: "" })) });
  const manager = createAgentSessionManager({ homePath: home, worktreeManager, agentLauncher: createAgentLauncher({ runtimeHome: home, codexExecutable: executable }), terminalRuntime: {} as never, backgroundRuntime: background, startupRetryDelaysMs: [] });
  const workspace = createWorkspaceSessionOrchestrator({ homePath: home, projectManager: {} as never, worktreeManager, agentSessionManager: manager,
    agentSandbox: { preflight: async (input: { worktreePath: string }) => ({ ok: true, sandbox: { enabled: true, writableRoots: [input.worktreePath] } }), cleanup: async () => {} } as never, sessionRuntimeBridge: {} as never });
  const control = createCodexControlClient({ homePath: home });
  const events = createCodexEventBridge({ homePath: home, codexExecutable: executable, pollIntervalMs: 50,
    isRuntimeAlive: async sessionId => { const result = await manager.getSession(sessionId); return result.ok && result.session.runtime.status === "running"; } });
  const provider = createWorkspaceCodingAgentProvider({ providerId: "codex", agent: "codex", runtime: workspace, codexControl: control, codexEvents: events, backgroundRuntime: background });
  const threads = createCodingAgentThreadStore({ homePath: home, providers: [provider] }); events.attachThreadStore(threads);
  const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads, homePath: home, routineCli: { runtime: f.runtime, ...f.transport } });
  f.setSourceAdapter(adapter);
  return { ...f, home, control, adapter, threads, workspace, manager, background, events, launched, services, privateFrames, records, controlFile, halfCloseReceiver: () => halfCloseReceiver(),
    async overflowWrapper() { if (!overflow) throw new Error("Named wrapper overflow fixture was not enabled"); await overflow.trigger(); await writeFile(controlFile, "overflow"); },
    async frames() { return (await readFile(records, "utf8")).trim().split("\n").map(line => JSON.parse(line)); },
    async close() {
      await f.f.canonical.close();
      await background.close();
      for (const service of services.values()) {
        if (service.child.exitCode === null && service.child.signalCode === null) service.child.kill("SIGTERM");
        const timer = setTimeout(() => service.child.kill("SIGKILL"), 1500); await service.closed; clearTimeout(timer);
      }
      await events.shutdown(); await threads.shutdownTurns(); manager.shutdown(); await workspace.close(); await f.close(); await rm(home, { recursive: true, force: true });
    },
  };
}
