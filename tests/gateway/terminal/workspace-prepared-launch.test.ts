import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createAgentSessionManager } from "../../../packages/gateway/src/agent-session-manager.js";
import { createWorkspaceSessionOrchestrator } from "../../../packages/gateway/src/workspace-session-orchestrator.js";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
it("threads actual principal privately through workspace orchestrator/manager and preserves the exact prepared native launch", async () => {
  const home = await mkdtemp("/tmp/t7work-"); cleanups.push(() => rm(home, { recursive: true, force: true }));
  const launch = { command: "/fixed/pi", args: ["--model", "native-model", "native prompt"], cwd: home, env: { HOME: home, PATH: "/bin" }, inheritEnv: false as const };
  const workspaceId = "tws_" + "a".repeat(32), tabId = "tt_" + "b".repeat(32), principal = { userId: "actual_owner", source: "jwt" as const };
  const terminalRuntime = { ensureWorkspace: vi.fn(async () => ({ id: workspaceId })), createTab: vi.fn(), terminateTab: vi.fn(), writeInput: vi.fn(), listWorkspaces: vi.fn(async () => []) };
  const prepared = vi.fn(async () => ({ id: tabId, workspaceId }));
  const manager = createAgentSessionManager({ homePath: home, terminalRuntime: terminalRuntime as never, worktreeManager: {} as never,
    agentLauncher: { buildLaunch: vi.fn(() => launch) }, terminalLaunch: prepared, startupRetryDelaysMs: [], startupReconcileIntervalMs: 600000 } as never);
  cleanups.push(async () => manager.shutdown());
  const orchestrator = createWorkspaceSessionOrchestrator({ homePath: home, agentSessionManager: manager, agentSandbox: {} as never, projectManager: {} as never, worktreeManager: {} as never, sessionRuntimeBridge: {} as never }); cleanups.push(orchestrator.close);
  const result = await orchestrator.startSession({ ownerScope: { type: "user", id: principal.userId }, principal,
    request: { sessionId: "sess_native_prepared", kind: "agent", agent: "pi", prompt: "native prompt", model: "native-model" } } as never);
  expect(result.ok).toBe(true);
  expect(prepared).toHaveBeenCalledWith(expect.objectContaining({ principal, workspaceId, launch, harness: "pi", policy: expect.objectContaining({ originCeiling: "exact" }) }));
  expect(terminalRuntime.createTab).not.toHaveBeenCalled();
  expect(await readFile(home + "/system/sessions/sess_native_prepared.json", "utf8")).not.toMatch(/actual_owner.*jwt|terminalPrincipal|native prompt|native-model/);
});

import { launchPreparedWorkspaceTerminal, retainWorkspaceTerminalPrincipal, workspaceTerminalPrincipal } from "../../../packages/gateway/src/terminal/workspace-launch.js";
it.each(["inherit environment", "credential environment", "relative command", "plan", "review", "read only", "wrong owner", "configured owner"])("denies prepared %s source before dispatch while preserving the exact original workload", async reason => {
  const launch = { command: "/fixed/pi", args: ["native prompt"], cwd: "/home/owner", env: { HOME: "/home/owner", PATH: "/bin" }, inheritEnv: false as boolean | undefined };
  const request = { kind: "agent" as const, agent: "pi" as const, ownerId: "owner", mode: "default", sandboxMode: "workspace_write" };
  const principal = { userId: "owner", source: "jwt" as "jwt" | "configured-container" };
  if (reason === "inherit environment") launch.inheritEnv = undefined;
  if (reason === "credential environment") Object.assign(launch.env, { API_KEY: "fixture-never-descriptor" });
  if (reason === "relative command") launch.command = "pi";
  if (reason === "plan" || reason === "review") request.mode = reason;
  if (reason === "read only") request.sandboxMode = "read_only";
  if (reason === "wrong owner") principal.userId = "other";
  if (reason === "configured owner") principal.source = "configured-container";
  const original = structuredClone(launch), launchTerminal = vi.fn();
  expect(await launchPreparedWorkspaceTerminal({ request, principal, launch, workspaceId: "tws_" + "a".repeat(32), cwd: "", launchTerminal })).toBeUndefined();
  expect(launchTerminal).not.toHaveBeenCalled(); expect(launch).toEqual(original);
});
it("never falls back or retries after prepared host dispatch may have occurred", async () => {
  const launchTerminal = vi.fn(async () => { throw new Error("Named dispatch uncertainty"); });
  await expect(launchPreparedWorkspaceTerminal({ request: { kind: "agent", agent: "pi", ownerId: "owner" }, principal: { userId: "owner", source: "jwt" },
    launch: { command: "/fixed/pi", args: [], cwd: "/home/owner", env: { HOME: "/home/owner", PATH: "/bin" }, inheritEnv: false }, workspaceId: "tws_" + "a".repeat(32), cwd: "", launchTerminal })).rejects.toThrow("Named dispatch uncertainty");
  expect(launchTerminal).toHaveBeenCalledOnce();
});
it("JSON copies and forged metadata cannot recover a retained workspace principal", () => {
  const value = retainWorkspaceTerminalPrincipal({ ownerId: "owner" }, { userId: "owner", source: "jwt" });
  expect(workspaceTerminalPrincipal(value)).toEqual({ userId: "owner", source: "jwt" });
  expect(workspaceTerminalPrincipal(JSON.parse(JSON.stringify(value)))).toBeUndefined();
  expect(workspaceTerminalPrincipal({ ...value, principal: { userId: "owner", source: "jwt" } })).toBeUndefined();
});

import { Hono } from "hono";
import { createWorkspaceRoutes } from "../../../packages/gateway/src/workspace-routes.js";
it("workspace HTTP admission retains the authenticated JWT principal rather than rebuilding it from owner scope", async () => {
  const home = await mkdtemp("/tmp/t7route-"); cleanups.push(() => rm(home, { recursive: true, force: true }));
  const startSession = vi.fn(async () => ({ ok: true as const, status: 201, session: { id: "sess_route" } }));
  const app = new Hono(); app.use("*", async (c, next) => { c.set("jwtClaims" as never, { sub: "verified_owner" } as never); await next(); });
  app.route("/", createWorkspaceRoutes({ homePath: home, startSession: startSession as never, getOwnerScope: () => ({ type: "user", id: "verified_owner" }) }));
  const response = await app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "agent", agent: "pi" }) });
  expect(response.status).toBe(201);
  expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ principal: { userId: "verified_owner", source: "jwt" } }));
});
