import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { createRealBotStateDatabase } from "./bot-state-support.js";
import { proposalFixture } from "./routine-cli-proposal-support.js";
import { createRoutineCliRuntime } from "../../../packages/gateway/src/bots/routine-cli-runtime.js";
import { createBotRoutineExecution } from "../../../packages/gateway/src/bots/routine-execution.js";
import { createRoutineActionOwnerRoutes } from "../../../packages/gateway/src/bots/routine-action-routes.js";
import { createRoutineCliExecutionRoutes } from "../../../packages/gateway/src/bots/routine-cli-routes.js";
import { createRoutineActionVerificationRoutes } from "../../../packages/platform/src/routine-action-routes.js";
import { authenticatedApprovalProxyProof } from "../../../packages/platform/src/canonical-owner-approval-proxy.js";
import { buildPlatformVerificationToken } from "../../../packages/platform/src/platform-token.js";
import { requireRequestPrincipal } from "../../../packages/gateway/src/request-principal.js";
import { authMiddleware } from "../../../packages/gateway/src/auth.js";
import { context, invocation } from "./routine-cli-source-support.js";
import { propose, scope } from "./routine-cli-request-support.js";
let data: Awaited<ReturnType<typeof createRealBotStateDatabase>>, f: Awaited<ReturnType<typeof proposalFixture>>, runtime: ReturnType<typeof createRoutineCliRuntime>;
afterEach(async () => { await runtime?.close(); await f?.close(); await data?.destroy(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("actual owner namespaces, source capability lookup, owner HTTP and shared canonical proposal runtime compose without alias merging", async () => {
  const url = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL; if (!url) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL is required");
  data = await createRealBotStateDatabase(url); f = await proposalFixture(data.db, vi.fn);
  const legacy = "platform_local_owner", secret = "fixture-platform-only-consent", handle = "computer-one", machineId = "machine_current";
  const machine = { machineId, handle, runtimeSlot: "primary", clerkUserId: scope.ownerId, provisioningClass: "customer" as const };
  const platform = createRoutineActionVerificationRoutes({ platformSecret: secret, lookup: { resolveMachine: async () => ({ ...machine, status: "running" }) } });
  runtime = createRoutineCliRuntime({ db: data.db, computerId: scope.computerId, configuredOwnerIds: [legacy, scope.ownerId], agents: f.agents, repository: f.chats,
    transact: f.transact, approvals: f.approvals, control: createBotRoutineExecution({ db: data.db, transact: f.transact, approvals: f.approvals, available: () => true }), registry: f.registry,
    platform: { platformUrl: "https://platform.example.test", handle, machineId, runtimeSlot: "primary", token: buildPlatformVerificationToken(handle, secret) } });
  // The service's only remote operation is actual Platform verification; this fixture replaces network transport, not the verifier.
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => platform.request(new Request(url, init)));
  runtime.bindCanonical(f.canonical); f.taskDependencies.routineProposals = runtime.proposals;
  const source = await runtime.register({ source: { ...context("runtime_actual_owner"), identity: { kind: "terminal_launch", sessionId: "real_fixture_terminal", incarnationId: "inc_1", launchId: "launch_1" },
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString() }, signal: new AbortController().signal,
    readPolicy: () => ({ live: true, scope: "personal", interactionMode: "default", permissionMode: "supervised", originCeiling: "exact", revision: "actual_fixture_policy" }), validateWithin: async () => true });
  const operation = propose(800), signal = new AbortController().signal, pending = source.authorize({ operation, invocationId: invocation(801), signal });
  let view: ReturnType<typeof runtime.list>[number] | undefined;
  for (let i = 0; i < 100 && !view; i++) { view = runtime.list(f.principal)[0]; if (!view) await new Promise(resolve => setTimeout(resolve, 5)); }
  expect(view).toBeDefined(); expect(runtime.list({ userId: legacy, source: "jwt" })).toEqual([]);
  expect(() => runtime.get({ userId: legacy, source: "jwt" }, view!.challengeId)).toThrow();
  expect(() => runtime.get({ userId: "foreign", source: "jwt" }, view!.challengeId)).toThrow();
  const jwtSecret = "fixture-jwt-only-routing-not-consent-secret";
  vi.stubEnv("MATRIX_USER_ID", legacy); vi.stubEnv("MATRIX_AUTH_TOKEN", "fixture-runtime-bearer"); vi.stubEnv("MATRIX_HANDLE", handle);
  vi.stubEnv("PLATFORM_JWT_SECRET", jwtSecret); vi.stubEnv("PLATFORM_JWT_PUBLIC_KEY", "");
  const jwt = await new SignJWT({ handle, gateway_url: "https://app.example.test" }).setProtectedHeader({ alg: "HS256" }).setSubject(scope.ownerId)
    .setIssuer("matrix-os-platform").setAudience("matrix-os-sync").setIssuedAt().setExpirationTime("5m").sign(new TextEncoder().encode(jwtSecret));
  const app = new Hono(); app.use("*", authMiddleware("fixture-runtime-bearer"));
  app.route("/", createRoutineActionOwnerRoutes({ actions: runtime, getPrincipal: requireRequestPrincipal }));
  app.route("/", createRoutineCliExecutionRoutes({ requests: runtime }));
  const readPath = `/api/routine-cli/actions/${view!.challengeId}`, path = `${readPath}/decision`;
  expect((await app.request(readPath, { headers: { authorization: `Bearer ${jwt}` } })).status).toBe(200);
  expect((await app.request(readPath, { headers: { authorization: "Bearer fixture-runtime-bearer" } })).status).toBe(404);
  const body = { actionDigest: view!.actionDigest, decision: "approve" as const, clientRequestId: invocation(802) };
  const request = (proof?: string, value: unknown = body, auth = `Bearer ${jwt}`) => app.request(path, { method: "POST", headers: { authorization: auth,
    "content-type": "application/json", ...(proof ? { "x-matrix-routine-action-proof": proof } : {}) }, body: JSON.stringify(value) });
  expect((await request()).status).toBe(403);
  expect((await request("forged-proof", { ...body, ownerId: scope.ownerId })).status).toBe(400);
  expect((await app.request(path, { method: "POST", headers: { authorization: `Bearer ${jwt}` }, body: " ".repeat(2049) })).status).toBe(413);
  const proof = await authenticatedApprovalProxyProof({ request: new Request(`https://app.example.test${path}`, { method: "POST", body: JSON.stringify(body) }), method: "POST", path,
    handle, machine, platformSecret: secret, identity: { userId: scope.ownerId, handle, runtimeSlot: "primary", source: "auth", sessionProvenance: "clerk-browser", sessionExpiresAt: Math.floor(Date.now() / 1000) + 300 } });
  expect((await request(proof as string)).status).toBe(200); expect(await pending).toBe(true);
  const token = (await source.issue({ operation, invocationId: invocation(801), signal })).takeToken();
  expect((await request(proof as string, body, `RoutineCapability ${token}`)).status).toBe(401);
  const result = await app.request("/api/routine-cli/execute", { method: "POST", headers: { authorization: `RoutineCapability ${token}`, "content-type": "application/json" }, body: JSON.stringify({ operation }) });
  expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ ok: true, data: { receipt: { disposition: "queued" } } });
  await f.canonical.drain();
  expect(await data.db.selectFrom("routine_cli_requests").select("owner_id").execute()).toEqual([{ owner_id: scope.ownerId }]);
  expect(await data.db.selectFrom("bot_tasks").select(["owner_id", "status"]).execute()).toEqual([{ owner_id: scope.ownerId, status: "waiting_person" }]);
  expect(await data.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(1);
  expect(await data.db.selectFrom("bot_routines").selectAll().execute()).toHaveLength(0);
  expect(vi.mocked(f.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run")).toHaveLength(0);
  vi.unstubAllGlobals();
});
