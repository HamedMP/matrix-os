import { createCodingOutputBuffer } from "./coding-output-buffer.js";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { Duplex } from "node:stream";
import { nativeOpenCodeRoutineSource } from "../chat/opencode-routine-source.js";
import { prepareOpenCodeRoutineBootstrap, type OpenCodeRoutineBootstrap } from "./opencode-routine-bootstrap.js";
import type { UserInputAnswerRequest } from "@matrix-os/contracts";
import { spawnIsolatedProviderProcess } from "./provider-process-isolation.js";
import { createOpenCodeInputController } from "./opencode-input.js";
import { logCodingAgentWarning } from "./diagnostics.js";
import type { OpenCodeProcess, OpenCodeSpawnFn } from "./opencode-provider.js";

export const OPENCODE_READ_ONLY_PERMISSIONS = [
  { permission: "*", pattern: "*", action: "deny" },
  ...["read", "glob", "grep", "list", "question"].map(permission => ({ permission, pattern: "*", action: "allow" })),
];
const MAX_BODY = 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$/;
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("OpenCode response missing");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > MAX_BODY) throw new Error("OpenCode response limit exceeded");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel(); reader.releaseLock(); }
}
/** Per-run loopback server, with a child-process-shaped stream for the existing bounded collector. */
export function createOpenCodeServerProcess(
  command: string, args: string[], options: { cwd: string; env: Record<string, string> },
  dependencies: { spawn?: OpenCodeSpawnFn; fetch?: typeof fetch } = {},
): OpenCodeProcess {
  const events = new EventEmitter(); const stdout = new EventEmitter(); const stderr = new EventEmitter();
  const controller = new AbortController(); const requestFetch = dependencies.fetch ?? fetch;
  const password = randomBytes(32).toString("hex");
  const routine = nativeOpenCodeRoutineSource();
  let bootstrap: OpenCodeRoutineBootstrap | undefined;
  let cleanup: Promise<void> | undefined;
  const endRoutine = () => routine?.end();
  const cleanupBootstrap = () => {
    if (bootstrap && !cleanup) cleanup = bootstrap.close().catch(error => logCodingAgentWarning("OpenCode routine bootstrap cleanup unavailable", error));
  };
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "x-opencode-directory": encodeURIComponent(options.cwd), "content-type": "application/json" };
  const prompt = args.at(-1) ?? "";
  const sessionArg = args.indexOf("--session"); let sessionId = sessionArg < 0 ? undefined : args[sessionArg + 1];
  const modelArg = args.indexOf("--model"); const model = modelArg < 0 ? undefined : args[modelArg + 1];
  let origin = ""; let child: OpenCodeProcess | undefined; let stopped = false; let ended = false;
  let desiredExit: number | null = null; let killTimer: ReturnType<typeof setTimeout> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  const emit = (record: Record<string, unknown>) => { if (!stopped) stdout.emit("data", Buffer.from(`${JSON.stringify(record)}\n`)); };
  async function fetchOwned(path: string, body: unknown, method: string, signal: AbortSignal): Promise<Response> {
    const response = await requestFetch(`${origin}${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error",
      signal,
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error("OpenCode request failed"); }
    return response;
  }
  async function request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", timeout = 10_000): Promise<Response> {
    return fetchOwned(path, body, method, AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]));
  }
  // The owned local server has already passed bounded startup and session
  // verification. A synchronous message waits for the whole agent turn, so a
  // response deadline here would reintroduce the removed turn deadline. The
  // event connection alone must acknowledge headers promptly; after that its
  // stream, and the message response, remain owned by explicit Stop.
  async function executionRequest(path: string, body?: unknown, waitForHeaders = false): Promise<Response> {
    const opening = new AbortController();
    const signal = AbortSignal.any([controller.signal, opening.signal]);
    const timer = waitForHeaders ? setTimeout(() => opening.abort(), 10_000) : undefined;
    timer?.unref?.();
    let rejectAborted!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = () => reject(new Error("OpenCode execution channel closed")); });
    signal.addEventListener("abort", rejectAborted, { once: true });
    if (signal.aborted) rejectAborted();
    const pending = fetchOwned(path, body, body === undefined ? "GET" : "POST", signal);
    void pending.then(response => {
      if (signal.aborted) void response.body?.cancel().catch(error => logCodingAgentWarning("OpenCode late response cleanup failed", error));
    }, () => undefined);
    try { return await Promise.race([pending, aborted]); }
    finally { if (timer) clearTimeout(timer); signal.removeEventListener("abort", rejectAborted); }
  }
  const submissions = new Set<Promise<void>>(); // At most 16 active questions; cleared as requests settle.
  const inputs = createOpenCodeInputController(emit, async (path, body) => boundedJson(await request(path, body)));
  function end(code: number | null) {
    endRoutine();
    if (ended) return; ended = true; stopped = true; controller.abort(); inputs.clear();
    if (killTimer) clearTimeout(killTimer); if (readyTimer) clearTimeout(readyTimer);
    stdout.emit("end"); events.emit("exit", code);
  }
  function stop(code: number | null, signal: NodeJS.Signals = "SIGTERM") {
    endRoutine();
    if (stopped) { if (signal === "SIGKILL") child?.kill(signal); return; }
    stopped = true; desiredExit = code; controller.abort(); inputs.clear();
    if (readyTimer) clearTimeout(readyTimer);
    if (!child) { end(code); return; }
    const signalChild = (value: NodeJS.Signals) => {
      try { child?.kill(value); } catch (error) { logCodingAgentWarning("OpenCode server termination failed", error); }
    };
    signalChild(signal);
    if (ended) return;
    killTimer = setTimeout(() => {
      signalChild("SIGKILL");
      if (ended) return;
      killTimer = setTimeout(() => end(1), 2_000); killTimer.unref?.();
    }, 2_000); killTimer.unref?.();
  }
  function fail(error: unknown) {
    if (stopped) return;
    logCodingAgentWarning("OpenCode server transport failed", error);
    emit({ type: "error" }); stop(1);
  }
  async function stream(response: Response): Promise<void> {
    if (!response.body) throw new Error("OpenCode event stream missing");
    const reader = response.body.getReader();
    const frames = createCodingOutputBuffer(MAX_BODY, "\n\n");
    try {
      while (!stopped) {
        const result = await reader.read(); if (result.done) { if (!stopped) throw new Error("OpenCode event stream ended"); break; }
        frames.push(Buffer.from(result.value), frame => {
          if (stopped) return false;
          const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (data) receive(JSON.parse(data));
        });
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
  }
  function receive(value: unknown) {
    const event = object(value); const properties = object(event?.properties); if (!properties) return;
    const part = object(properties.part);
    const eventSession = properties.sessionID ?? part?.sessionID ?? object(properties.info)?.sessionID;
    if (!sessionId || eventSession !== sessionId) return;
    if (event?.type === "message.updated") { const info = object(properties.info); if (info) routine?.observeMessage(info); }
    if (event?.type === "message.part.updated" && part) routine?.observePart(part);
    if (event?.type === "question.asked") inputs.asked(properties);
    if ((event?.type === "question.replied" || event?.type === "question.rejected") && typeof properties.requestID === "string") inputs.resolved(properties.requestID, event.type === "question.replied" ? "answered" : "cancelled");
    if (event?.type === "session.error") throw new Error("OpenCode session failed");
    if (event?.type === "message.part.updated" && part) publishPart(part);
  }
  function publishPart(part: Record<string, unknown>) {
    if (part.type === "text" && object(part.time)?.end) emit({ type: "text", sessionID: sessionId, part });
    const status = object(part.state)?.status;
    if (part.type === "tool" && (status === "completed" || status === "error")) emit({ type: "tool_use", sessionID: sessionId, part });
  }
  async function run() {
    if (routine?.current()) {
      try { bootstrap = await prepareOpenCodeRoutineBootstrap({ command, cwd: options.cwd, env: options.env }); }
      catch (error) { endRoutine(); logCodingAgentWarning("OpenCode routines unavailable", error); }
    }
    if (stopped) { endRoutine(); cleanupBootstrap(); return; }
    const permissions = bootstrap ? [...OPENCODE_READ_ONLY_PERMISSIONS, { permission: "matrix_routines", pattern: "*", action: "allow" }] : OPENCODE_READ_ONLY_PERMISSIONS;
    const spawn = dependencies.spawn ?? ((cmd, argv, opts) => spawnIsolatedProviderProcess(cmd, argv, { ...opts, stdio: opts.stdio ?? ["ignore", "pipe", "pipe"] }));
    const ready = new Promise<void>((resolve, reject) => {
      child = spawn(command, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { ...options, ...(bootstrap ? { stdio: ["ignore", "pipe", "pipe", "pipe"] as const } : {}), env: { ...options.env, ...bootstrap?.environment, OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password, OPENCODE_PURE: "1", OPENCODE_ENABLE_QUESTION_TOOL: "1" } });
      if (bootstrap) {
        const pipe = child.stdio?.[3];
        if (pipe instanceof Duplex) routine!.attach(pipe);
        else { endRoutine(); reject(new Error("OpenCode routine transport unavailable")); return; }
      }
      let output = "";
      child.stdout.on("data", chunk => {
        if (origin || stopped) return;
        output += chunk.toString("utf8");
        if (Buffer.byteLength(output) > 16_384) { reject(new Error("OpenCode startup output limit exceeded")); return; }
        const match = /(?:^|\n)opencode server listening on http:\/\/127\.0\.0\.1:(\d+)\r?(?:\n|$)/.exec(output);
        if (!match) return;
        const port = Number(match[1]); if (port < 1 || port > 65535) { reject(new Error("OpenCode port unavailable")); return; }
        origin = `http://127.0.0.1:${port}`; if (readyTimer) clearTimeout(readyTimer); resolve();
      });
      child.stderr.on("data", chunk => { if (!stopped) stderr.emit("data", chunk); });
      child.stdout.once("end", endRoutine); child.stdout.once("close", endRoutine);
      child.once("error", error => { endRoutine(); reject(error); fail(error); });
      child.once("exit", code => { endRoutine(); cleanupBootstrap(); reject(new Error("OpenCode server exited")); end(stopped ? desiredExit : code === 0 ? 1 : code); });
      readyTimer = setTimeout(() => reject(new Error("OpenCode server startup timed out")), 10_000); readyTimer.unref?.();
    });
    await ready; if (stopped) return;
    if (sessionId && !SESSION_ID.test(sessionId)) throw new Error("OpenCode session unavailable");
    if (!sessionId) {
      const created = object(await boundedJson(await request("/session", { title: "Matrix Chat", permission: permissions })));
      if (typeof created?.id !== "string" || !SESSION_ID.test(created.id)) throw new Error("OpenCode session unavailable");
      sessionId = created.id;
    }
    const path = `/session/${encodeURIComponent(sessionId)}`;
    // OpenCode PATCH appends permission rules; creation already sets the policy.
    // Resumed sessions must retain that exact policy before any prompt is sent.
    const verified = object(await boundedJson(await request(path)));
    if (verified?.id !== sessionId || verified.directory !== options.cwd || (!Array.isArray(verified.permission) || verified.permission.length !== permissions.length
      || verified.permission.some((value, index) => { const rule = object(value); const expected = permissions[index]!;
        return rule?.permission !== expected.permission || rule.pattern !== expected.pattern || rule.action !== expected.action; }))) throw new Error("OpenCode read-only session verification failed");
    emit({ type: "step_start", sessionID: sessionId });
    const subscribed = await executionRequest("/event", undefined, true);
    const eventStream = stream(subscribed).catch(fail);
    const separator = model?.indexOf("/") ?? -1;
    const messageID = `msg_${randomBytes(16).toString("hex")}`;
    if (bootstrap) {
      const project = object(await boundedJson(await request("/project/current")));
      if (typeof project?.worktree !== "string" || !routine!.beforePrompt(sessionId, messageID, options.cwd, project.worktree)) throw new Error("OpenCode routine source unavailable");
    }
    const result = object(await boundedJson(await executionRequest(`${path}/message`, {
      ...(bootstrap ? { messageID, agent: "build" } : {}),
      parts: [{ type: "text", text: prompt }],
      ...(model && separator > 0 ? { model: { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) } } : {}),
    })));
    endRoutine(); // Native result fences authority before output publication/submission/child drainage.
    if (object(result?.info)?.error || !Array.isArray(result?.parts)) throw new Error("OpenCode message failed");
    for (const part of result.parts) { const parsed = object(part); if (parsed) publishPart(parsed); }
    await Promise.allSettled([...submissions]);
    stop(0);
    await eventStream;
  }
  queueMicrotask(() => { if (!stopped) void run().catch(fail); });
  return {
    stdout, stderr,
    once(event: "exit" | "error", listener: never) { events.once(event, listener); },
    kill(signal) { stop(null, signal); },
    async deferInput(requestId: string) {
      if (stopped) throw new Error("OpenCode input unavailable");
      const submission = inputs.defer(requestId); submissions.add(submission);
      try { await submission; } finally { submissions.delete(submission); }
    },
    async submitInput(requestId: string, input: UserInputAnswerRequest) {
      if (stopped || submissions.size >= 16) throw new Error("OpenCode run unavailable");
      const submission = inputs.submit(requestId, input); submissions.add(submission);
      try { await submission; } finally { submissions.delete(submission); }
    },
  };
}
