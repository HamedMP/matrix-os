import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createOpenCodeServerProcess, OPENCODE_READ_ONLY_PERMISSIONS } from "../../packages/gateway/src/coding-agents/opencode-server-process.js";
function fixture(resume = false, ignorePermissions = false, stallEvent = false, textOnly?: { wrongModel?: boolean; tool?: boolean; allow?: boolean; startupExit?: boolean; freeLimit?: boolean; foreignLimit?: boolean }) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit("exit", 0)); });
  const spawn = vi.fn(() => {
    queueMicrotask(() => {
      if (textOnly?.startupExit) child.emit("exit", 1);
      else child.stdout.emit("data", Buffer.from("opencode server listening on http://127.0.0.1:42101\n"));
    });
    return child;
  });
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let complete!: (response: Response) => void;
  const send = (type: string, properties: unknown) => { if (!stream || stream.desiredSize === null) return false; stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, properties })}\n\n`)); return true; };
  let permissions = resume ? [...OPENCODE_READ_ONLY_PERMISSIONS] : [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/session") {
      permissions = JSON.parse(String(init.body)).permission;
      return Response.json({ id: "ses_test" });
    }
    if (path === "/session/ses_test" && init.method === "PATCH") {
      permissions.push(...JSON.parse(String(init.body)).permission);
      return Response.json({ id: "ses_test" });
    }
    if (path === "/session/ses_test" && init.method === "GET") return Response.json({ id: "ses_test", directory: "/work/repo", permission: ignorePermissions ? [] : permissions.map(rule => ({ action: rule.action, pattern: rule.pattern, permission: rule.permission })) });
    if (path === "/event" && stallEvent) return new Promise<Response>(() => undefined);
    if (path === "/event") return new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { "content-type": "text/event-stream" } });
    if (path === "/session/ses_test/message") {
      if (textOnly?.freeLimit || textOnly?.foreignLimit) queueMicrotask(() => send("session.status", {
        sessionID: textOnly.foreignLimit ? "ses_other" : "ses_test",
        status: { type: "retry", attempt: 1, message: "sensitive upstream text", action: { reason: "free_tier_limit" } },
      }));
      if (textOnly?.freeLimit) return new Promise<Response>(() => undefined);
      if (textOnly) return Response.json({
        info: { id: "msg_answer", role: "assistant", sessionID: "ses_test", providerID: "opencode", modelID: textOnly.wrongModel ? "other-free" : "beam-free", finish: "stop" },
        parts: [{ id: "part_answer", type: textOnly.tool ? "tool" : "text", text: "Exact answer", time: { end: 1 } }],
      });
      queueMicrotask(() => send("question.asked", { id: "que_test", sessionID: "ses_test", questions: [{ header: "Color", question: "Choose colors", options: [{ label: "Red", description: "Red" }, { label: "Blue", description: "Blue" }], multiple: true, custom: false }] }));
      return new Promise<Response>(resolve => { complete = resolve; });
    }
    if (path === "/question/que_test/reply") {
      send("question.replied", { sessionID: "ses_test", requestID: "que_test", answers: [["Red", "Blue"]] });
      complete(Response.json({ info: { id: "msg_answer", role: "assistant" }, parts: [{ id: "part_answer", type: "text", text: "Thank you", time: { end: 1 } }] }));
      return Response.json(true);
    }
    throw new Error(`Unexpected endpoint ${path}`);
  });
  const revalidate = vi.fn(async () => textOnly?.allow !== false);
  const process = createOpenCodeServerProcess("opencode", ["run", "--format", "json", ...(resume ? ["--session", "ses_test"] : []), ...(textOnly ? ["--model", "opencode/beam-free"] : []), "Choose"], { cwd: "/work/repo", env: { HOME: "/owner" } }, { spawn: spawn as never, fetch: fetch as never, ...(textOnly ? { textOnly: { revalidate } } : {}) });
  const lines: Record<string, any>[] = [];
  process.stdout.on("data", chunk => lines.push(JSON.parse(chunk.toString())));
  const exited = new Promise<number | null>(resolve => process.once("exit", resolve));
  return { process, lines, exited, spawn, fetch, child, send, revalidate };
}
describe("OpenCode local server transport", () => {
  it.each([false, true])("answers a native pending question without appending permissions (resume: %s)", async (resume) => {
    const run = fixture(resume);
    await vi.waitFor(() => expect(run.lines.some(line => line.type === "matrix.input.requested")).toBe(true));
    const request = run.lines.find(line => line.type === "matrix.input.requested")!;
    expect(request.questions[0]).toMatchObject({ questionId: "q0", multiSelect: true, allowOther: false });
    await run.process.submitInput!(request.requestId, { answer: "", structuredAnswers: { q0: ["Red", "Blue"] }, clientRequestId: "req_answer", correlationId: request.correlationId });
    expect(await run.exited).toBe(0);
    expect(run.lines.some(line => line.type === "text" && line.part.text === "Thank you")).toBe(true);
    expect(run.spawn.mock.calls[0][1]).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "0"]);
    const env = run.spawn.mock.calls[0][2].env;
    expect(env).toMatchObject({ OPENCODE_PURE: "1", OPENCODE_ENABLE_QUESTION_TOOL: "1" });
    expect(env.OPENCODE_SERVER_PASSWORD.length).toBeGreaterThanOrEqual(32);
    expect(run.fetch.mock.calls.every(([, init]) => new Headers(init.headers).get("authorization") === `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`)).toBe(true);
    expect(run.fetch.mock.calls.find(([url]) => url.endsWith("/reply"))?.[1].body).toBe(JSON.stringify({ answers: [["Red", "Blue"]] }));
    expect(run.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(run.fetch.mock.calls.some(([, init]) => init.method === "PATCH")).toBe(false);
  });
  it("verifies resumed permissions before admitting any prompt", async () => {
    const run = fixture(true, true);
    expect(await run.exited).toBe(1);
    expect(run.fetch.mock.calls.some(([url]) => url.endsWith("/message"))).toBe(false);
    expect(run.child.kill).toHaveBeenCalled();
  });
  it("does not launch a process after an immediate cancellation", async () => {
    const run = fixture(); run.process.kill("SIGTERM");
    expect(await run.exited).toBeNull();
    expect(run.spawn).not.toHaveBeenCalled();
  });
  it("rejects questions from other sessions and unknown request ids", async () => {
    const run = fixture();
    await vi.waitFor(() => expect(run.lines.some(line => line.type === "matrix.input.requested")).toBe(true));
    run.send("question.asked", { id: "que_foreign", sessionID: "ses_other", questions: [] });
    await expect(run.process.submitInput!("que_foreign", { answer: "no", clientRequestId: "req_other", correlationId: "corr_other" })).rejects.toThrow();
    expect(run.lines.some(line => line.requestId === "que_foreign")).toBe(false);
    run.process.kill("SIGTERM");
    await run.exited;
  });
});

describe("OpenCode text-only completion", () => {
  it("records a bounded stage when the scoped child exits before startup", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const run = fixture(false, false, false, { startupExit: true });
      expect(await run.exited).toBe(1);
      expect(run.fetch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("[coding-agents] OpenCode text completion unavailable", "startup_exit");
    } finally { warn.mockRestore(); }
  });

  it("uses one verified deny-all session and returns the exact completed text", async () => {
    const run = fixture(false, false, false, {});
    expect(await run.exited).toBe(0);
    expect(run.lines).toEqual([{ type: "text", sessionID: "ses_test", part: expect.objectContaining({ text: "Exact answer" }) }]);
    expect(JSON.parse(String(run.fetch.mock.calls[0]![1].body)).permission).toEqual([{ permission: "*", pattern: "*", action: "deny" }]);
    expect(run.fetch.mock.calls.filter(([url]) => url.endsWith("/event"))).toHaveLength(1);
    expect(run.spawn.mock.calls[0]![2].env.OPENCODE_ENABLE_QUESTION_TOOL).toBeUndefined();
    expect(run.revalidate).toHaveBeenCalledTimes(2);
  });

  it("stops the exact session before a provider retry on confirmed free-tier exhaustion", async () => {
    const run = fixture(false, false, false, { freeLimit: true });
    expect(await run.exited).toBe(1);
    expect(run.lines).toEqual([{ type: "error", code: "free_limit" }]);
    expect(run.fetch.mock.calls.filter(([url]) => url.endsWith("/message"))).toHaveLength(1);
    expect(run.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(JSON.stringify(run.lines)).not.toContain("sensitive");
  });

  it("ignores a foreign session's free-tier status", async () => {
    const run = fixture(false, false, false, { foreignLimit: true });
    expect(await run.exited).toBe(0);
    expect(run.lines).toEqual([{ type: "text", sessionID: "ses_test", part: expect.objectContaining({ text: "Exact answer" }) }]);
  });

  it.each([{ wrongModel: true }, { tool: true }, { allow: false }])("fails closed for %j", async mode => {
    const run = fixture(false, false, false, mode);
    expect(await run.exited).toBe(1);
    expect(run.lines.some(line => line.type === "text")).toBe(false);
    if (mode.allow === false) expect(run.fetch.mock.calls.some(([url]) => url.endsWith("/message"))).toBe(false);
  });
});


it("keeps a connected busy OpenCode stream and message alive beyond ten minutes", async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => { const controller = new AbortController(); setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), ms); return controller.signal; });
  const run = fixture();
  try {
    await vi.waitFor(() => expect(run.lines.some(line => line.type === "matrix.input.requested")).toBe(true));
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    const executing = run.fetch.mock.calls.filter(([url]) => url.endsWith("/event") || url.endsWith("/message"));
    expect(executing).toHaveLength(2);
    expect(executing.every(([, init]) => !init.signal?.aborted)).toBe(true);
    const question = run.lines.find(line => line.type === "matrix.input.requested")!;
    await run.process.submitInput!(question.requestId, { answer: "", structuredAnswers: { q0: ["Red", "Blue"] }, clientRequestId: "req_long_answer", correlationId: question.correlationId });
    expect(await run.exited).toBe(0);
  } finally { run.process.kill("SIGTERM"); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); }
});

it("still bounds an OpenCode event connection that never returns headers", async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => { const controller = new AbortController(); setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), ms); return controller.signal; });
  const run = fixture(false, false, true);
  try {
    await vi.waitFor(() => expect(run.fetch.mock.calls.some(([url]) => url.endsWith("/event"))).toBe(true));
    await vi.advanceTimersByTimeAsync(10_001);
    expect(run.child.kill).toHaveBeenCalled();
    expect(await run.exited).toBe(1);
  } finally { run.process.kill("SIGTERM"); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); }
});


it("keeps consuming ordinary SSE records past the former total count and still answers input", async () => {
  const run = fixture();
  try {
    await vi.waitFor(() => expect(run.lines.some(line => line.type === "matrix.input.requested")).toBe(true));
    for (let index = 0; index < 4097 && !run.child.kill.mock.calls.length; index += 1) {
      if (!run.send("session.status", { sessionID: "ses_test", status: { type: "busy" } })) break;
      await Promise.resolve();
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(run.child.kill).not.toHaveBeenCalled();
    const question = run.lines.find(line => line.type === "matrix.input.requested")!;
    await run.process.submitInput!(question.requestId, { answer: "", structuredAnswers: { q0: ["Red", "Blue"] }, clientRequestId: "req_record_answer", correlationId: question.correlationId });
    expect(await run.exited).toBe(0);
  } finally { run.process.kill("SIGTERM"); }
});
