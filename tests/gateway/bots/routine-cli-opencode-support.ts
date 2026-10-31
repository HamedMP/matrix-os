import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCanonicalCodingChatProviderAdapter } from "../../../packages/gateway/src/chat/coding-provider-adapter.js";
import { createOpenCodeCodingAgentProvider } from "../../../packages/gateway/src/coding-agents/opencode-provider.js";
import type { OpenCodeProcess } from "../../../packages/gateway/src/coding-agents/opencode-provider.js";
import { createOpenCodeServerProcess } from "../../../packages/gateway/src/coding-agents/opencode-server-process.js";
import { createCodingAgentThreadStore } from "../../../packages/gateway/src/coding-agents/thread-store.js";
import { nativeOpenCodeRoutineSource } from "../../../packages/gateway/src/chat/opencode-routine-source.js";
import { claudeFixture } from "./routine-cli-claude-support.js";
/** Actual canonical OpenCode adapter/thread/provider/server/source, owned tool/FD, fixed CLI/private IPC/HTTP/PG.
 * Native bootstrap/loader/server-event emitter/auth/model are explicitly named fixtures. */
export async function opencodeFixture(native: { intent: { args: string[]; stdin?: string }; duplicate?: boolean; hold?: boolean;
  context?: Record<string, unknown>; event?: Record<string, unknown>; noNativeEvent?: boolean; noBootstrap?: boolean; order?: "fd-first" | "sse-first"; terminalBeforeCallback?: "completed" | "error" }) {
  const f = await claudeFixture({ sourceDriver: "opencode" }), home = await mkdtemp("/tmp/ro-");
  const control = join(home, "control"), records = join(home, "records"), config = join(home, "fixture.json");
  await writeFile(records, "");
  const children: ChildProcess[] = []; let finish!: () => void, eof!: () => void;
  let serverProcess: OpenCodeProcess, releaseSubmission: (() => void) | undefined;
  let sendEvent!: (type: string, properties: unknown) => void;
  const output: Record<string, unknown>[] = [];
  const orderTrace: string[] = []; // one callback and a bounded number of explicit test observations
  let sent = false, promptCount = 0;
  let eventPart: Record<string, unknown> | undefined, acknowledgePart: (() => void) | undefined;
  const emitPart = (part: Record<string, unknown>) => new Promise<void>(resolve => {
    if (acknowledgePart) throw new Error("Named native event barrier already pending");
    acknowledgePart = resolve; sendEvent("message.part.updated", { part });
  });
  let releaseObservations: (() => void) | undefined;
  const provider = createOpenCodeCodingAgentProvider({ homePath: home, resolveCredentialLaunch: async () => ({ env: {} }),
    spawnFn(command, args, options) {
      let permissions: unknown = [];
      const source = nativeOpenCodeRoutineSource();
      if (source) {
        const observePart = source.observePart;
        source.observePart = part => { observePart(part); orderTrace.push("observed-" + (part.state as { status: string }).status); acknowledgePart?.(); acknowledgePart = undefined; };
      }
      serverProcess = createOpenCodeServerProcess(command, args, options, {
        spawn(_command, _args, actual) {
          // Only the named bootstrap fixture can supply this controlled native emitter environment.
          const start = spawn(process.execPath, [resolve("tests/fixtures/opencode-routine-process.mjs"), config], { stdio: actual.stdio ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: home, MATRIX_NO_TELEMETRY: "1" } });
          children.push(start);
          if (actual.stdio) {
            let buffered = "", callbackSeen = false;
            start.stdio[3]!.on("data", (chunk: Buffer) => {
              buffered += chunk.toString("utf8"); if (Buffer.byteLength(buffered) > 196608) throw new Error("Named FD barrier exceeded cap");
              if (callbackSeen || !buffered.includes("\n")) return; callbackSeen = true; orderTrace.push("fd-callback");
              // This listener runs before the actual source listener; the microtask runs after
              // that listener consumes the exact complete callback frame, never on a sleep.
              if (native.order === "fd-first") queueMicrotask(() => { releaseObservations?.(); releaseObservations = undefined; });
            });
          }
          if (native.hold) Object.defineProperty(start, "kill", { value: () => true });
          if (!start.stdout || !start.stderr) throw new Error("Named native fixture lost its output pipes");
          return Object.assign(start, { stdout: start.stdout, stderr: start.stderr });
        },
        fetch: (async (url: string, init: RequestInit) => {
          const path = new URL(url).pathname;
          if (path === "/session") { permissions = JSON.parse(String(init.body)).permission; return Response.json({ id: "ses_owned" }); }
          if (path === "/session/ses_owned") return Response.json({ id: "ses_owned", directory: home, permission: permissions });
          if (path === "/project/current") return Response.json({ worktree: home });
          if (path === "/event") return new Response(new ReadableStream({ start(stream) {
            const send = (type: string, properties: unknown) => { if (stream.desiredSize !== null) stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, properties })}\n\n`)); };
            eof = () => stream.close();
            sendEvent = send;
          } }));
          if (path === "/question/que_held/reply") return new Promise<Response>(resolve => { releaseSubmission = () => resolve(Response.json(true)); });
          if (path === "/session/ses_owned/message") {
            promptCount++;
            const body = JSON.parse(String(init.body));
            finish = () => done(Response.json({ info: { id: "msg_assistant", role: "assistant" }, parts: [] }));
            let done!: (response: Response) => void;
            const result = new Promise<Response>(resolve => { done = resolve; });
            if (native.noBootstrap) { queueMicrotask(finish); return result; }
            const context = { sessionID: "ses_owned", messageID: "msg_assistant", callID: "call_owned", agent: "build", directory: home, worktree: home };
            eventPart = { type: "tool", tool: "matrix_routines", ...context, state: { status: "running", input: { intent: native.intent } }, ...native.event };
            const observations = async () => {
              sendEvent("message.updated", { info: { id: context.messageID, sessionID: context.sessionID, parentID: body.messageID, role: "assistant", agent: "build" } });
              if (!native.noNativeEvent) {
                await emitPart(eventPart!);
                if (native.terminalBeforeCallback) await emitPart({ ...eventPart!, state: { status: native.terminalBeforeCallback } });
              }
            };
            if (native.order === "fd-first") {
              releaseObservations = () => { void observations(); };
              await writeFile(control, JSON.stringify({ type: "tool", intent: native.intent, context: { ...context, ...native.context } }));
            } else {
              await observations(); // Explicit actual-source observation barrier, no elapsed-time assumption.
              await writeFile(control, JSON.stringify({ type: "tool", intent: native.intent, context: { ...context, ...native.context } }));
            }
            const poll = setInterval(() => { void readFile(records, "utf8").then(text => {
              if (text.includes('"result"') && !sent) { sent = true; clearInterval(poll); if (!native.hold) finish(); }
            }); }, 20); poll.unref();
            init.signal?.addEventListener("abort", () => clearInterval(poll), { once: true });
            return result;
          }
          throw new Error("Unexpected named OpenCode endpoint");
        }) as typeof fetch,
      });
      serverProcess.stdout.on("data", chunk => output.push(JSON.parse(chunk.toString("utf8"))));
      return serverProcess;
    },
  });
  // The bootstrap fixture writes the actual staged tool location before native spawn.
  const ownedConfig = join(home, "owned-loader-fixture");
  await mkdir(join(ownedConfig, "tools"), { recursive: true, mode: 0o700 });
  await writeFile(join(ownedConfig, "package.json"), JSON.stringify({ private: true, type: "module" }), { flag: "wx", mode: 0o600 });
  await writeFile(join(ownedConfig, "tools", "matrix_routines.js"), await readFile(resolve("packages/gateway/src/coding-agents/opencode-routine-tool.mjs")), { flag: "wx", mode: 0o600 });
  const candidate = { environment: { OPENCODE_CONFIG_DIR: ownedConfig }, close: async () => {} };
  await writeFile(config, JSON.stringify({ records, control, duplicate: native.duplicate, tool: join(candidate.environment.OPENCODE_CONFIG_DIR, "tools", "matrix_routines.js") }));
  const threads = createCodingAgentThreadStore({ homePath: home, providers: [provider] });
  const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "opencode", threads, homePath: home, routineCli: { runtime: f.runtime, ...f.transport } });
  f.setSourceAdapter(adapter);
  return { ...f, candidate, children, home, control, threads, adapter, orderTrace,
    finish: () => finish(), eof: () => eof(), promptCount: () => promptCount,
    async holdSubmission() {
      sendEvent("question.asked", { id: "que_held", sessionID: "ses_owned", questions: [{ header: "Fixture", question: "Hold input", options: [{ label: "Continue", description: "Fixture" }], multiple: false, custom: false }] });
      const deadline = Date.now() + 2000;
      while (!output.some(item => item.type === "matrix.input.requested") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      const question = output.find(item => item.type === "matrix.input.requested"); if (!question) throw new Error("Named native question fixture unavailable");
      const pending = serverProcess.submitInput!(question.requestId as string, { answer: "Continue", structuredAnswers: { q0: ["Continue"] }, clientRequestId: "req_held", correlationId: question.correlationId as string });
      void pending.catch(error => { if (!(error instanceof Error)) throw error; });
      while (!releaseSubmission && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      if (!releaseSubmission) throw new Error("Named native submission fixture unavailable");
    },
    releaseSubmission: () => releaseSubmission?.(),
    async terminal(status: "completed" | "error") {
      if (!eventPart) throw new Error("Named running native event not established");
      await emitPart({ ...eventPart, state: { status } });
    },
    async frames() { return (await readFile(records, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line)); },
    async start(chatId: string, modes = { permission: "supervised", interaction: "default" }) { return f.start(chatId, modes); },
    async close() { releaseSubmission?.(); for (const child of children) if (child.exitCode === null && child.signalCode === null && child.pid) process.kill(child.pid, "SIGKILL"); await threads.shutdownTurns(); await f.close(); await candidate.close(); await rm(home, { recursive: true, force: true }); },
  };
}
