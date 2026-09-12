import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createOpenCodeServerProcess, OPENCODE_READ_ONLY_PERMISSIONS } from "../../packages/gateway/src/coding-agents/opencode-server-process.js";
function fixture(resume = false, ignorePermissions = false) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit("exit", 0)); });
  const spawn = vi.fn(() => { queueMicrotask(() => child.stdout.emit("data", Buffer.from("opencode server listening on http://127.0.0.1:42101\n"))); return child; });
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let complete!: (response: Response) => void;
  const send = (type: string, properties: unknown) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, properties })}\n\n`));
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/session" || (path === "/session/ses_test" && init.method === "PATCH")) return Response.json({ id: "ses_test", directory: "/work/repo", permission: OPENCODE_READ_ONLY_PERMISSIONS });
    if (path === "/session/ses_test" && init.method === "GET") return Response.json({ id: "ses_test", directory: "/work/repo", permission: ignorePermissions ? [] : OPENCODE_READ_ONLY_PERMISSIONS.map(rule => ({ action: rule.action, pattern: rule.pattern, permission: rule.permission })) });
    if (path === "/event") return new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { "content-type": "text/event-stream" } });
    if (path === "/session/ses_test/message") {
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
  const process = createOpenCodeServerProcess("opencode", ["run", "--format", "json", ...(resume ? ["--session", "ses_test"] : []), "Choose"], { cwd: "/work/repo", env: { HOME: "/owner" } }, { spawn: spawn as never, fetch: fetch as never });
  const lines: Record<string, any>[] = [];
  process.stdout.on("data", chunk => lines.push(JSON.parse(chunk.toString())));
  const exited = new Promise<number | null>(resolve => process.once("exit", resolve));
  return { process, lines, exited, spawn, fetch, child, send };
}
describe("OpenCode local server transport", () => {
  it("answers a native pending question in the same authenticated session", async () => {
    const run = fixture();
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
