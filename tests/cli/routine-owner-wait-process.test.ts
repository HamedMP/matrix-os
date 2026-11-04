import { afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { createFixedNativeRoutineCliInvoker } from "../../packages/gateway/src/bots/routine-cli-invoker.js";
import { cachedRoutinePack } from "./routine-pack-support.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

it("the packed CLI waits for a delayed host decision before its only authenticated HTTP request", async () => {
  const packed = await cachedRoutinePack(); closers.push(packed.cleanup);
  const requestId = "de000000-0000-4000-8000-000000000100", routineId = "rt_" + "a".repeat(24);
  const operation = { operation: "pause", requestId, routineId, baseRevision: 1 } as const;
  const data = { kind: "receipt", receipt: { requestId, operation: "pause", disposition: "applied",
    routine: { routineId, status: "paused", revision: 2 }, revision: 1, createdAt: "2026-09-27T12:00:00.000Z" }, current: null, approval: null };
  const received: Array<{ method: string | undefined; path: string | undefined; authorization: string | undefined; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ v: 1, ok: true, data }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  closers.push(() => new Promise(done => server.close(() => done())));
  let entered!: () => void, release!: () => void, issued = 0;
  const requested = new Promise<void>(done => { entered = done; }), decision = new Promise<void>(done => { release = done; });
  const invoker = createFixedNativeRoutineCliInvoker({ binPath: packed.binPath, cwd: packed.root, homePath: packed.root, timeoutMs: 120_000,
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/routine-cli/execute`,
    authorize: async input => { expect(input.operation).toEqual(operation); entered(); await decision; return true; },
    issue: async () => { issued++; return { takeToken: () => "rcli_" + "A".repeat(43) }; }, cancel: async () => undefined });
  closers.push(invoker.close);
  const result = invoker.invoke({ args: ["pause", routineId, "--revision", "1", "--request-id", requestId], expectedOperation: operation });
  let enteredDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([requested, new Promise<never>((_resolve, reject) => { enteredDeadline = setTimeout(() => reject(new Error("Packed CLI did not request host authorization")), 10_000); })]);
    clearTimeout(enteredDeadline);
    await new Promise(done => setTimeout(done, 11_000));
    expect(received).toEqual([]); expect(issued).toBe(0);
    release();
    expect(await result).toEqual({ v: 1, ok: true, data });
    expect(issued).toBe(1);
    expect(received).toEqual([{ method: "POST", path: "/api/routine-cli/execute", authorization: "RoutineCapability rcli_" + "A".repeat(43), body: { operation } }]);
  } finally { clearTimeout(enteredDeadline); release(); await invoker.close(); await result; }
}, 45_000);
