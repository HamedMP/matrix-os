import { afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createFixedNativeRoutineCliInvoker } from "../../../packages/gateway/src/bots/routine-cli-invoker.js";
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())); });
it("fixed native invoker executes actual published CLI and authorizes its exact normalized operation with a host UUID", async () => {
  const seen: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    seen.push(JSON.parse(Buffer.concat(chunks).toString())); response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ v: 1, ok: true, data: { kind: "list", routines: [], truncated: false } }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); closers.push(() => new Promise(done => server.close(() => done())));
  let authorized = 0, issued = 0;
  const invoker = createFixedNativeRoutineCliInvoker({ binPath: resolve("packages/sync-client/bin/matrix.mjs"),
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/routine-cli/execute`,
    authorize: async input => { authorized++; expect(input.operation).toEqual({ operation: "list" }); expect(input.invocationId).toMatch(/^[a-f0-9-]{36}$/); return true; },
    issue: async () => { issued++; return { takeToken: () => "rcli_" + "A".repeat(43) }; }, cancel: async () => undefined });
  closers.push(invoker.close);
  expect(await invoker.invoke({ args: ["list"], expectedOperation: { operation: "list" } })).toEqual({ v: 1, ok: true, data: { kind: "list", routines: [], truncated: false } });
  expect(authorized).toBe(1); expect(issued).toBe(1); expect(seen).toEqual([{ operation: { operation: "list" } }]);
});
it("rejects a valid-shaped HTTP result for a different operation through the actual CLI", async () => {
  const server = createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ v: 1, ok: true,
    data: { kind: "not_observed", requestId: "de000000-0000-4000-8000-000000000100", mayStillArrive: true } })); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); closers.push(() => new Promise(done => server.close(() => done())));
  const invoker = createFixedNativeRoutineCliInvoker({ binPath: resolve("packages/sync-client/bin/matrix.mjs"),
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/routine-cli/execute`, authorize: async () => true,
    issue: async () => ({ takeToken: () => "rcli_" + "A".repeat(43) }), cancel: async () => undefined }); closers.push(invoker.close);
  expect(await invoker.invoke({ args: ["list"] })).toEqual({ v: 1, error: { code: "unavailable", message: "Routine requests are temporarily unavailable." } });
});
const REQUEST = "DE000000-0000-4000-8000-000000000100", ROUTINE = "rt_" + "a".repeat(24);
async function responseInvoker(status: number, body: unknown) {
  let calls = 0;
  const server = createServer((_request, response) => { calls++; response.statusCode = status; response.setHeader("content-type", "application/json"); response.end(typeof body === "string" ? body : JSON.stringify(body)); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); closers.push(() => new Promise(done => server.close(() => done())));
  const invoker = createFixedNativeRoutineCliInvoker({ binPath: resolve("packages/sync-client/bin/matrix.mjs"),
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/routine-cli/execute`, authorize: async () => true,
    issue: async () => ({ takeToken: () => "rcli_" + "A".repeat(43) }), cancel: async () => undefined }); closers.push(invoker.close);
  return { invoke: invoker.invoke, calls: () => calls };
}
it.each([
  [503, { v: 1, error: { code: "unavailable", message: "Routine requests are temporarily unavailable." } }],
  [401, { v: 1, error: { code: "unavailable", message: "Routine requests are temporarily unavailable." } }],
  [200, "private-provider-path failure"], [200, "x".repeat(128 * 1024 + 1)],
  [403, { v: 1, error: { code: "permission_denied", message: "/private/provider/database" } }],
])("actual mutation uncertain HTTP %s returns original UUID unknown exactly once", async (status, body) => {
  const cli = await responseInvoker(status as number, body);
  expect(await cli.invoke({ args: ["pause", ROUTINE, "--revision", "1", "--request-id", REQUEST] })).toEqual({ v: 1, ok: true,
    data: { kind: "unknown", requestId: REQUEST, disposition: "unknown", reconcile: true } }); expect(cli.calls()).toBe(1);
});
it("actual mutation returns known scoped authoritative 4xx without retry", async () => {
  const cli = await responseInvoker(409, { v: 1, error: { code: "revision_conflict", message: "The routine changed. Read its current revision." } });
  expect(await cli.invoke({ args: ["pause", ROUTINE, "--revision", "1", "--request-id", REQUEST] })).toMatchObject({ v: 1, error: { code: "revision_conflict" } }); expect(cli.calls()).toBe(1);
});
it("accepts original logical UUID after PG lowercase normalization while current state may differ", async () => {
  const cli = await responseInvoker(200, { v: 1, ok: true, data: { kind: "receipt", receipt: { requestId: REQUEST.toLowerCase(), operation: "pause", disposition: "applied",
    routine: { routineId: ROUTINE, status: "paused", revision: 2 }, revision: 1, createdAt: "2026-09-27T12:00:00.000Z" }, current: null, approval: null } });
  expect(await cli.invoke({ args: ["pause", ROUTINE, "--revision", "1", "--request-id", REQUEST] })).toMatchObject({ ok: true, data: { receipt: { requestId: REQUEST.toLowerCase() } } });
});
it.each(["wrong request", "wrong original desired state", "wrong routine", "wrong mutation"])("actual mutation rejects %s result as unknown", async fault => {
  const receipt = { requestId: fault === "wrong request" ? REQUEST.replace("100", "101") : REQUEST, operation: fault === "wrong mutation" ? "resume" : "pause", disposition: "applied",
    routine: { routineId: fault === "wrong routine" ? "rt_" + "b".repeat(24) : ROUTINE, status: fault === "wrong original desired state" ? "active" : "paused", revision: 2 }, revision: 1, createdAt: "2026-09-27T12:00:00.000Z" };
  const cli = await responseInvoker(200, { v: 1, ok: true, data: { kind: "receipt", receipt, current: null, approval: null } });
  expect(await cli.invoke({ args: ["pause", ROUTINE, "--revision", "1", "--request-id", REQUEST] })).toMatchObject({ ok: true, data: { kind: "unknown", requestId: REQUEST } });
});
it("structured expected operation must match actual citty child operation before any authority is issued", async () => {
  let issued = 0, authorized = 0;
  const invoker = createFixedNativeRoutineCliInvoker({ binPath: resolve("packages/sync-client/bin/matrix.mjs"), endpoint: "http://127.0.0.1:1/api/routine-cli/execute",
    authorize: async () => { authorized++; return true; }, issue: async () => { issued++; return { takeToken: () => "rcli_" + "A".repeat(43) }; }, cancel: async () => undefined }); closers.push(invoker.close);
  expect(await invoker.invoke({ args: ["list"], expectedOperation: { operation: "show", routineId: ROUTINE } })).toHaveProperty("error.code", "unavailable");
  expect(issued).toBe(0); expect(authorized).toBe(0);
});
it.each(["authorize", "issue"] as const)("abort during %s drains actual child and never delivers late capability", async boundary => {
  let reached!: () => void, release!: () => void, taken = 0, issued = 0;
  const entered = new Promise<void>(done => { reached = done; }), gate = new Promise<void>(done => { release = done; });
  const controller = new AbortController();
  const invoker = createFixedNativeRoutineCliInvoker({ binPath: resolve("packages/sync-client/bin/matrix.mjs"), endpoint: "http://127.0.0.1:1/api/routine-cli/execute",
    authorize: async input => { expect(Object.isFrozen(input)).toBe(true); expect(Object.isFrozen(input.operation)).toBe(true); if (boundary === "authorize") { reached(); await gate; } return true; },
    issue: async () => { issued++; reached(); await gate; return { takeToken: () => { taken++; return "rcli_" + "A".repeat(43); } }; }, cancel: async () => undefined }); closers.push(invoker.close);
  const result = invoker.invoke({ args: ["list"], signal: controller.signal });
  try {
    await entered; controller.abort(); expect(await result).toHaveProperty("error.code", "unavailable");
    release(); await new Promise(done => setTimeout(done, 20)); expect(taken).toBe(0); expect(issued).toBe(boundary === "authorize" ? 0 : 1);
    await invoker.close(); expect(await invoker.invoke({ args: ["list"] })).toHaveProperty("error.code", "unavailable");
  } finally { release(); controller.abort(); await result; }
});
it.each(["malformed request", "repeated request", "oversized frame", "stdout overflow", "success without handshake"])("fixed invoker fails closed for %s process fault", async fault => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const home = await mkdtemp(join(tmpdir(), "routine-cli-negative-bin-")); closers.push(() => rm(home, { recursive: true, force: true }));
  const frame = JSON.stringify({ v: 1, type: "routine.request", operation: { operation: "list" } });
  const script = fault === "stdout overflow" ? 'process.stdout.write("x".repeat(128*1024+1)); setTimeout(()=>{},10000);'
    : fault === "success without handshake" ? 'console.log(JSON.stringify({v:1,ok:true,data:{kind:"list",routines:[],truncated:false}}));process.disconnect();'
    : fault === "repeated request" ? `process.send(${frame});process.send(${frame});setTimeout(()=>{},10000);`
    : fault === "oversized frame" ? 'process.send({padding:"x".repeat(32769)});setTimeout(()=>{},10000);'
    : 'process.send({v:1,type:"routine.request",operation:{operation:"list",ownerId:"forged"}});setTimeout(()=>{},10000);';
  const binPath = join(home, "matrix.mjs"); await writeFile(binPath, script);
  let issued = 0;
  const invoker = createFixedNativeRoutineCliInvoker({ binPath, endpoint: "http://127.0.0.1:1/api/routine-cli/execute", timeoutMs: 1000,
    authorize: async () => new Promise<boolean>(done => setTimeout(() => done(true), 300)),
    issue: async () => { issued++; return { takeToken: () => "rcli_" + "A".repeat(43) }; }, cancel: async () => undefined }); closers.push(invoker.close);
  expect(await invoker.invoke({ args: ["list"] })).toHaveProperty("error.code", "unavailable"); expect(issued).toBe(0);
});
it("active child cap and shutdown drain are bounded; validated dependencies cannot be swapped later", async () => {
  const deps = { binPath: resolve("packages/sync-client/bin/matrix.mjs"), endpoint: "http://127.0.0.1:1/api/routine-cli/execute", timeoutMs: 1000,
    authorize: async () => false, issue: async () => ({ takeToken: () => "rcli_" + "A".repeat(43) }), cancel: async () => undefined };
  const invoker = createFixedNativeRoutineCliInvoker(deps); closers.push(invoker.close);
  deps.binPath = "/untrusted/matrix.mjs"; deps.issue = async () => { throw new Error("swapped dependency"); };
  const work = Array.from({ length: 8 }, () => invoker.invoke({ args: ["list"] }));
  expect(await invoker.invoke({ args: ["list"] })).toHaveProperty("error.code", "unavailable");
  await invoker.close(); expect(await Promise.all(work)).toHaveLength(8);
});
it("trusted fixed child environment excludes auth/provider secrets and NODE_OPTIONS", async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { vi } = await import("vitest"); const home = await mkdtemp(join(tmpdir(), "routine-cli-env-")); closers.push(() => rm(home, { recursive: true, force: true }));
  const file = join(home, "seen.json"), binPath = join(home, "matrix.mjs");
  await writeFile(binPath, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(file)},JSON.stringify(Object.keys(process.env)));process.disconnect();`);
  vi.stubEnv("NODE_OPTIONS", "--trace-warnings"); vi.stubEnv("MATRIX_AUTH_TOKEN", "fixture-private"); vi.stubEnv("ANTHROPIC_API_KEY", "fixture-private");
  try {
    const invoker = createFixedNativeRoutineCliInvoker({ binPath, endpoint: "http://127.0.0.1:1/api/routine-cli/execute", authorize: async () => false,
      issue: async () => { throw new Error("Never authorized"); }, cancel: async () => undefined }); closers.push(invoker.close);
    expect(await invoker.invoke({ args: ["list"] })).toHaveProperty("error.code", "unavailable");
    const keys = JSON.parse(await readFile(file, "utf8")); expect(keys).not.toContain("NODE_OPTIONS"); expect(keys).not.toContain("MATRIX_AUTH_TOKEN"); expect(keys).not.toContain("ANTHROPIC_API_KEY");
  } finally { vi.unstubAllEnvs(); }
});
