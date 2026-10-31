import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import { authMiddleware } from "../../../packages/gateway/src/auth.js";
import { createRoutineCliExecutionRoutes } from "../../../packages/gateway/src/bots/routine-cli-routes.js";
import { createFixedNativeRoutineCliInvoker } from "../../../packages/gateway/src/bots/routine-cli-invoker.js";
import { formatRoutineHuman } from "../../../packages/sync-client/src/cli/routine-output.js";
import { createRealBotStateDatabase, OWNER } from "./bot-state-support.js";
import { canonicalFixture } from "./routine-cli-canonical-support.js";
import { proposalFixture } from "./routine-cli-proposal-support.js";
import { proposal, TARGET_A } from "./routine-cli-request-support.js";
import type { RoutineCliResult } from "@matrix-os/contracts/routine-cli";
let data: Awaited<ReturnType<typeof createRealBotStateDatabase>>;
const closers: Array<() => Promise<void>> = [];
beforeEach(async () => {
  const url = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL;
  if (!url) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL required for real CLI/Hono/source/canonical transport");
  data = await createRealBotStateDatabase(url);
});
afterEach(async () => { try { for (const close of closers.splice(0).reverse()) await close(); } finally { vi.unstubAllEnvs(); await data?.destroy(); } });
/** Actual published process/IPC/global auth/capability consumer/canonical DB work. Source action/lifecycle
 * callbacks and host runtime model process are explicit fixtures, not native harness authorization. */
async function transport(f: Awaited<ReturnType<typeof canonicalFixture>> | Awaited<ReturnType<typeof proposalFixture>>, loseFirst = false, binPath = resolve("packages/sync-client/bin/matrix.mjs"), cwd?: string, override?: Parameters<typeof f.service>[0]) {
  const adapter = "proposals" in f ? f.proposals : f.adapter, requests = f.service({ ...adapter, ...override });
  let calls = 0;
  const app = new Hono(); app.use("*", authMiddleware("fixture-owner-token"));
  app.route("/", createRoutineCliExecutionRoutes({ requests }));
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    calls++; const result = await app.fetch(request);
    if (loseFirst && calls === 1) throw new Error("Fixture lost HTTP acknowledgement after actual committed operation");
    return result;
  } });
  await new Promise<void>(done => { if (server.listening) done(); else server.once("listening", done); });
  closers.push(() => new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); if ("closeAllConnections" in server) server.closeAllConnections(); }));
  const invoker = createFixedNativeRoutineCliInvoker({ binPath, cwd,
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/routine-cli/execute`,
    authorize: async () => true, // Explicit exact-action approval fixture; Task4b/5 installs actual trusted policy.
    issue: async input => f.sources.issue(f.source, { invocationId: input.invocationId, operation: input.operation }), cancel: async () => undefined });
  closers.push(invoker.close);
  return { invoke: invoker.invoke, calls: () => calls };
}
it("actual process transports canonical controls exactly once; original receipt stays pinned after default change", async () => {
  const f = await canonicalFixture(data.db); closers.push(f.close); const cli = await transport(f);
  const operation = f.operation("pause");
  const args = ["pause", f.id, "--revision", "1", "--request-id", operation.requestId];
  const applied = await cli.invoke({ args, expectedOperation: operation });
  expect(applied).toMatchObject({ v: 1, ok: true, data: { kind: "receipt", receipt: { disposition: "applied", routine: { status: "paused", revision: 2 } }, execution: { stop: "unconfirmed" } } });
  expect(await cli.invoke({ args })).toEqual(applied);
  expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(1);
  expect(await f.repo.get(OWNER, f.id)).toMatchObject({ revision: 2 });
  await f.switchDefault();
  expect(await cli.invoke({ args: ["request", operation.requestId] })).toEqual(applied);
  expect(cli.calls()).toBe(3);
});
it("lost HTTP acknowledgement after real commit gives unknown original UUID and fresh reconciliation without mutation retry", async () => {
  const f = await canonicalFixture(data.db); closers.push(f.close); const cli = await transport(f, true), operation = f.operation("pause");
  expect(await cli.invoke({ args: ["pause", f.id, "--revision", "1", "--request-id", operation.requestId] })).toEqual({ v: 1, ok: true,
    data: { kind: "unknown", requestId: operation.requestId, disposition: "unknown", reconcile: true } });
  expect(cli.calls()).toBe(1); expect(await f.repo.get(OWNER, f.id)).toMatchObject({ revision: 2 });
  expect(await cli.invoke({ args: ["request", operation.requestId] })).toMatchObject({ ok: true, data: { receipt: { disposition: "applied", routine: { revision: 2 } } } });
  expect(cli.calls()).toBe(2); expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(1);
});
it.each(["approve", "deny"] as const)("actual CLI proposal remains queued admission, reads actual pending then %s approval", async decision => {
  const f = await proposalFixture(data.db); closers.push(f.close); const cli = await transport(f), requestId = "de000000-0000-4000-8000-000000000100";
  expect(await cli.invoke({ args: ["propose", "--input", "-", "--request-id", requestId], stdin: JSON.stringify(proposal) })).toMatchObject({ ok: true, data: { receipt: { disposition: "queued" } } });
  await f.canonical.drain();
  const pending = await cli.invoke({ args: ["request", requestId] });
  expect(pending).toMatchObject({ ok: true, data: { receipt: { disposition: "queued" }, proposal: { handoff: "pending_approval", approval: "pending", routine: null } } });
  const interaction = await f.db.selectFrom("bot_interactions").selectAll().executeTakeFirstOrThrow();
  await f.interactions.resolve(OWNER, TARGET_A.chatId, interaction.interaction_id, { kind: "approval", decision, baseRevision: Number(interaction.revision) });
  const current = await cli.invoke({ args: ["request", requestId] });
  expect(current).toMatchObject({ ok: true, data: { receipt: { disposition: "queued" }, proposal: { handoff: "pending_approval", approval: decision === "approve" ? "approved" : "denied", routine: decision === "approve" ? { status: "active" } : null } } });
  expect(formatRoutineHuman((current as { data: RoutineCliResult }).data)).toContain(decision === "approve" ? ": active" : "Declined");
  expect(formatRoutineHuman((current as { data: RoutineCliResult }).data)).not.toContain("Pending human");
  expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(1);
});

it("workspace-aware tarball executes all real aliases and lazy routines IPC against real Hono/source consumer with cached public deps", async () => {
  const { cachedRoutinePack } = await import("../../cli/routine-pack-support.js");
  const { execFile } = await import("node:child_process"), { promisify } = await import("node:util"), { join } = await import("node:path");
  const packed = await cachedRoutinePack(); closers.push(packed.cleanup);
  expect(Object.keys(packed.links)).toHaveLength(12); expect(packed.links).not.toHaveProperty("@matrix-os/contracts");
  expect(packed.manifest.bin).toEqual({ matrix: "bin/matrix.mjs", matrixos: "bin/matrix.mjs", mos: "bin/matrix.mjs" });
  for (const alias of ["matrix", "matrixos", "mos"]) {
    try {
      await promisify(execFile)(process.execPath, [join(packed.root, alias), "routines", "list", "--json"], {
        cwd: join(packed.root, "cwd"), env: { HOME: join(packed.root, "home"), PATH: process.env.PATH, MATRIX_NO_TELEMETRY: "1" }, timeout: 10000 });
      throw new Error("Unmanaged packed CLI incorrectly admitted");
    } catch (error) {
      const output = error as { code?: number; stdout?: string; stderr?: string };
      expect(output.code).toBe(3); expect(JSON.parse(output.stdout!)).toMatchObject({ v: 1, error: { code: "source_context_required" } });
      expect(output.stderr).not.toContain("rcli_");
    }
  }
  const f = await canonicalFixture(data.db); closers.push(f.close); vi.stubEnv("HOME", join(packed.root, "home")); const cli = await transport(f, false, packed.binPath, join(packed.root, "cwd"));
  expect(await cli.invoke({ args: ["list"] })).toMatchObject({ v: 1, ok: true, data: { kind: "list", routines: [{ routineId: f.id }] } });
  expect(cli.calls()).toBe(1); expect((await f.db.selectFrom("routine_cli_capabilities").select("consumed_at").executeTakeFirstOrThrow()).consumed_at).not.toBeNull();
});

it.each(["lifecycle", "operation"] as const)("actual CLI + Hono canonical writes rollback at final %s denial", async boundary => {
  const f = await canonicalFixture(data.db); closers.push(f.close); let witnessed = false;
  const cli = await transport(f, false, undefined, undefined, { sources: { consumeWithin: (trx, input, work) => f.sources.consumeWithin(trx, input, async (source, executor, invocation) => {
    const result = await work(source, executor, invocation);
    expect(await f.repo.get(OWNER, f.id, trx)).toMatchObject({ status: "paused", revision: 2 });
    expect(await trx.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(1);
    witnessed = true; if (boundary === "lifecycle") f.state.live = false; else f.state.operationAllowed = false;
    return result;
  }) } });
  const operation = f.operation("pause");
  expect(await cli.invoke({ args: ["pause", f.id, "--revision", "1", "--request-id", operation.requestId] })).toHaveProperty("error.code", "permission_denied");
  expect(witnessed).toBe(true); expect(await f.repo.get(OWNER, f.id)).toMatchObject({ revision: 1 });
  expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("chat_outbox").selectAll().where("event_type", "=", "bot.authority.changed").execute()).toHaveLength(0);
  expect((await f.db.selectFrom("routine_cli_capabilities").select("consumed_at").executeTakeFirstOrThrow()).consumed_at).toBeNull();
});
