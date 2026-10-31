import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { expect, vi } from "vitest";
import { TerminalRuntime } from "../../../packages/terminal-runtime/src/runtime.js";
import { TerminalWorkspaceStore } from "../../../packages/terminal-runtime/src/workspace-store.js";
import { createCanonicalTerminalLaunch } from "../../../packages/gateway/src/terminal/canonical-launch.js";
import type { RetainedTerminalStartup, TerminalSourcePort } from "../../../packages/gateway/src/terminal/retained-binding.js";
import { createTerminalWorkspaceRoutes } from "../../../packages/gateway/src/shell/workspace-routes.js";
import { createRoutineCliRuntime } from "../../../packages/gateway/src/bots/routine-cli-runtime.js";
import { createBotRoutineExecution } from "../../../packages/gateway/src/bots/routine-execution.js";
import { createRoutineCliExecutionRoutes } from "../../../packages/gateway/src/bots/routine-cli-routes.js";
import { createRoutineActionVerificationRoutes } from "../../../packages/platform/src/routine-action-routes.js";
import { authenticatedApprovalProxyProof } from "../../../packages/platform/src/canonical-owner-approval-proxy.js";
import { buildPlatformVerificationToken } from "../../../packages/platform/src/platform-token.js";
import { authMiddleware } from "../../../packages/gateway/src/auth.js";
import { proposalFixture } from "./routine-cli-proposal-support.js";
import { createRealBotStateDatabase } from "./bot-state-support.js";
import { scope } from "./routine-cli-request-support.js";
import type { TerminalHarness } from "../../../packages/gateway/src/terminal/native-launch.js";

/** Named manager/pane/process identity and background snapshot fixtures only.
 * Actual canonical Terminal store/route/join/source/controller/fixed published CLI,
 * private IPC/source-only Hono/owner PG/target task and human approval are real. */
export async function terminalFixture() {
  const url = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL;
  if (!url) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL required");
  const data = await createRealBotStateDatabase(url);
  const f = await proposalFixture(data.db, vi.fn, { actualSourceOnly: true, adapters: [], catalog: { revision: "fixture", drivers: [], instances: [] } });
  f.state.clock = new Date().toISOString();
  const secret = "fixture-terminal-platform", handle = "computer-one", machineId = "machine_current";
  const machine = { machineId, handle, runtimeSlot: "primary", clerkUserId: scope.ownerId, provisioningClass: "customer" as const };
  const platform = createRoutineActionVerificationRoutes({ platformSecret: secret, lookup: { resolveMachine: async () => ({ ...machine, status: "running" }) } });
  const actualFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => String(url).startsWith("https://platform.example.test") ? platform.request(new Request(url, init)) : actualFetch(url, init));
  const routines = createRoutineCliRuntime({ db: data.db, computerId: scope.computerId, configuredOwnerIds: [scope.ownerId], agents: f.agents, repository: f.chats,
    transact: f.transact, approvals: f.approvals, control: createBotRoutineExecution({ db: data.db, transact: f.transact, approvals: f.approvals, available: () => true }), registry: f.registry,
    platform: { platformUrl: "https://platform.example.test", handle, machineId, runtimeSlot: "primary", token: buildPlatformVerificationToken(handle, secret) } });
  routines.bindCanonical(f.canonical); f.taskDependencies.routineProposals = routines.proposals;
  const api = new Hono(); api.use("*", authMiddleware("fixture-owner-never-terminal")); api.route("/", createRoutineCliExecutionRoutes({ requests: routines }));
  let httpCalls = 0;
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: request => { httpCalls++; return api.fetch(request); } });
  await new Promise<void>(done => { if (server.listening) done(); else server.once("listening", done); });
  const home = await mkdtemp("/tmp/t7pg-");
  const store = new TerminalWorkspaceStore({ homePath: home });
  const zellij = { ensureSession: vi.fn(async () => {}), createTab: vi.fn(async () => ({ tabId: 1, paneId: "terminal_1" })), subscribeWorkspace: vi.fn(async () => ({ close: async () => {} })), openAttachment: vi.fn() };
  const terminal = new TerminalRuntime({ store, zellij, nativeHosts: { attachCommand: async ref => ["/fixed/node", "/fixed/terminal-io-attach.mjs", ref.path], inspect: async () => ({ status: "running" }), stop: vi.fn() } });
  const workspace = await terminal.ensureWorkspace(), generation = "gen_" + "b".repeat(64), rootSignal = new AbortController();
  const supervisor = { pid: 10, ppid: 1, uid: 501, gid: 20, start: "10" }, hostIdentity = { ...supervisor, pid: 20, ppid: 10, start: "20" }, root = { ...supervisor, pid: 30, ppid: 20, start: "30" };
  const writer = { ...root, pid: 40, ppid: 30, start: "40" }; let writerLive = true, current = true, managerCurrent = true, port: TerminalSourcePort | undefined;
  const startup: RetainedTerminalStartup = { heldGeneration: "held-private-identity", signal: rootSignal.signal, current: () => current && !rootSignal.signal.aborted,
    retire: () => rootSignal.abort(),
    verifyCurrent: async () => { if (!managerCurrent) { current = false; rootSignal.abort(); } return current && !rootSignal.signal.aborted; },
    identity: { type: "terminal.bound", admissionId: "de000000-0000-4000-8000-000000000703", supervisor, host: hostIdentity, root, invocationId: "c".repeat(32), generation } };
  const coordinator = createCanonicalTerminalLaunch({ interactiveHostEquivalent: true, runtime: terminal,
    host: { start: async input => { const reference = { path: home + "/matrix-terminal-" + "a".repeat(32) + "/io.sock" }; await input.onPrepared?.(reference); port = await input.onBound?.(startup); input.onDispatchSettled?.(); return { reference, status: "running" }; } },
    launcher: { build: async (input) => ({ command: `/fixed/${input.harness}`, args: [], cwd: f.home, env: { HOME: f.home, PATH: "/bin" }, inheritEnv: false }) },
    generation, homePath: home, computerId: scope.computerId, ownerIds: [scope.ownerId],
    routines: { runtime: routines, binPath: resolve("packages/sync-client/bin/matrix.mjs"), endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/routine-cli/execute` },
    readProcess: async pid => { const found = [supervisor, hostIdentity, root, ...(writerLive ? [writer] : [])].find(p => p.pid === pid); if (!found) throw new Error("Named process absent"); return found; } });
  const route = createTerminalWorkspaceRoutes({ runtime: terminal, homePath: f.home, managedLaunch: coordinator, terminalOwnerIds: [scope.ownerId], getPrincipal: () => f.principal });
  async function approve() {
    await expect.poll(() => routines.list(f.principal).find(a => a.status === "pending"), { timeout: 5000 }).toBeDefined();
    const view = routines.list(f.principal).find(a => a.status === "pending")!;
    const path = `/api/routine-cli/actions/${view.challengeId}/decision`, body = { actionDigest: view.actionDigest, decision: "approve" as const, clientRequestId: crypto.randomUUID() };
    const proof = await authenticatedApprovalProxyProof({ request: new Request(`https://app.example.test${path}`, { method: "POST", body: JSON.stringify(body) }), method: "POST", path,
      handle, machine, platformSecret: secret, identity: { userId: scope.ownerId, handle, runtimeSlot: "primary", source: "auth", sessionProvenance: "clerk-browser", sessionExpiresAt: Math.floor(Date.now() / 1000) + 300 } });
    await routines.submit(f.principal, view.challengeId, body, proof as string);
  }
  return { data, f, routines, terminal, store, coordinator, writer, startup, approve,
    httpCalls: () => httpCalls, port: () => port!, endWriter: () => { writerLive = false; }, endRoot: () => rootSignal.abort(), changeManager: () => { managerCurrent = false; }, observeManager: () => startup.verifyCurrent(), loseProof: () => { current = false; },
    async launch(harness: TerminalHarness = "claude") {
      const response = await route.request(`/workspaces/${workspace.id}/tabs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: harness, cwd: "", managedLaunch: { harness } }) });
      expect(response.status).toBe(201); return (await response.json()).tab;
    },
    async close() { await coordinator.close(); await terminal.shutdown(); await f.canonical.close(); await routines.close(); if ("closeAllConnections" in server) server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); await f.close(); await rm(home, { recursive: true, force: true }); await data.destroy(); vi.unstubAllGlobals(); },
  };
}
