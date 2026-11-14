import { afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
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

it("the packed CLI reconciles a dropped mutation acknowledgement using the original request UUID", async () => {
  const packed = await cachedRoutinePack(); closers.push(packed.cleanup);
  const requestId = "de000000-0000-4000-8000-000000000101", routineId = "rt_" + "a".repeat(24);
  const mutation = { operation: "pause", requestId, routineId, baseRevision: 1 } as const;
  const lookup = { operation: "request", requestId } as const;
  const data = { kind: "receipt", receipt: { requestId, operation: "pause", disposition: "applied",
    routine: { routineId, status: "paused", revision: 2 }, revision: 1, createdAt: "2026-09-27T12:00:00.000Z" }, current: null, approval: null };
  // The real ledger and transaction run in the PostgreSQL integration. Here
  // only the HTTP peer is synthetic so it can drop the mutation response.
  const received: unknown[] = [];
  let authorized = 0, issued = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({ authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (received.length === 1) { response.destroy(); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ v: 1, ok: true, data }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  closers.push(() => new Promise(done => { server.close(() => done()); server.closeAllConnections(); }));
  const invoker = createFixedNativeRoutineCliInvoker({ binPath: packed.binPath, cwd: packed.root, homePath: packed.root, timeoutMs: 120_000,
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/routine-cli/execute`,
    authorize: async ({ operation }) => { expect(operation).toEqual([mutation, lookup][authorized++]); return true; },
    issue: async () => { const token = "rcli_" + (issued++ === 0 ? "A" : "B").repeat(43); return { takeToken: () => token }; },
    cancel: async () => undefined });
  closers.push(invoker.close);

  await expect(invoker.invoke({ args: ["pause", routineId, "--revision", "1", "--request-id", requestId], expectedOperation: mutation }))
    .resolves.toEqual({ v: 1, ok: true, data: { kind: "unknown", requestId, disposition: "unknown", reconcile: true } });
  await expect(invoker.invoke({ args: ["request", requestId], expectedOperation: lookup })).resolves.toEqual({ v: 1, ok: true, data });
  expect(authorized).toBe(2); expect(issued).toBe(2);
  expect(received).toEqual([
    { authorization: "RoutineCapability rcli_" + "A".repeat(43), body: { operation: mutation } },
    { authorization: "RoutineCapability rcli_" + "B".repeat(43), body: { operation: lookup } },
  ]);
}, 15_000);

it("the packed CLI consumes a slow read response and promptly disconnects a cancelled read", async () => {
  const packed = await cachedRoutinePack(); closers.push(packed.cleanup);
  const operation = { operation: "list" } as const;
  const result = { v: 1, ok: true, data: { kind: "list", routines: [], truncated: false } };
  const aborted = Promise.withResolvers<void>();
  const controller = new AbortController(), cancelled = Promise.withResolvers<void>();
  let requests = 0;
  const server = createServer((request, response) => {
    expect(request.method).toBe("POST");
    request.resume();
    response.setHeader("content-type", "application/json");
    const body = JSON.stringify(result);
    if (++requests <= 3) { response.end(body); return; }
    response.write(body.slice(0, 1));
    if (requests === 4) {
      const timer = setTimeout(() => response.end(body.slice(1)), 12_000);
      response.once("close", () => clearTimeout(timer));
      return;
    }
    response.once("close", aborted.resolve);
    cancelled.resolve();
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  closers.push(() => new Promise(done => { server.close(() => done()); server.closeAllConnections(); }));
  const cancelReasons: string[] = [];
  const invoker = createFixedNativeRoutineCliInvoker({ binPath: packed.binPath, cwd: packed.root, homePath: packed.root, timeoutMs: 120_000,
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/routine-cli/execute`,
    authorize: async () => true, issue: async () => ({ takeToken: () => "rcli_" + "A".repeat(43) }),
    cancel: async ({ reason }) => { cancelReasons.push(reason); } });
  closers.push(invoker.close);
  const read = (signal?: AbortSignal) => invoker.invoke({ args: ["list"], expectedOperation: operation, signal });
  const baseline: number[] = [];
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    expect(await read()).toEqual(result);
    baseline.push(Math.round(performance.now() - start));
  }
  const start = performance.now();
  const slow = await read();
  const elapsed = Math.round(performance.now() - start);
  expect(slow, `Packed reads in ms: baseline ${baseline.join(", ")}, slow ${elapsed}`).toEqual(result);
  expect(elapsed).toBeGreaterThan(11_000);

  const pending = read(controller.signal);
  await cancelled.promise;
  const cancelAt = performance.now();
  controller.abort();
  expect(await pending).toMatchObject({ error: { code: "unavailable" } });
  await aborted.promise;
  expect(performance.now() - cancelAt).toBeLessThan(2_000);
  expect(cancelReasons).toEqual(["finished", "finished", "finished", "finished", "aborted"]);
  expect(requests).toBe(5);
}, 45_000);
