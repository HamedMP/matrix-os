import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { canonicalPreviewDriveTurnBody } from "@matrix-os/contracts";
import { MANAGED_TERMINAL_TARGET_PATH } from "@matrix-os/contracts/managed-terminal-control";
import { managedTerminalBodyDigest } from "@matrix-os/contracts/managed-terminal-proof";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createHerdrChatTerminalRoute } from "../../packages/gateway/src/chat/herdr-terminal-route.js";
import { HERDR_CHAT_ROUTE } from "../../packages/gateway/src/chat/herdr-chat-target.js";
import { createManagedTerminalBroker } from "../../packages/gateway/src/chat/managed-terminal-source.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { createHerdrAdapter } from "../../packages/gateway/src/herdr/adapter.js";
import { createManagedTerminalTargetRoutes } from "../../packages/gateway/src/herdr/managed-terminal-target.js";
import { createTerminalInputActivity } from "../../packages/gateway/src/terminal-agent/input-activity.js";
import { createWorktreeManager } from "../../packages/gateway/src/worktree-manager.js";
import { insertUserMachine } from "../../packages/platform/src/db.js";
import { createManagedTerminalControlRoutes } from "../../packages/platform/src/managed-terminal-control-routes.js";
import { authenticatedManagedTerminalProxyProof } from "../../packages/platform/src/managed-terminal-owner-proof.js";
import { herdrControlParts } from "../gateway/fixtures/herdr-chat-control-parts.js";
import { buildPlatformSyncVerificationToken } from "../../packages/platform/src/platform-token.js";
import { createFakeHerdrCore } from "../gateway/fixtures/fake-herdr-core-server.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "../platform/platform-db-test-helper.js";

it("returns the selected target's output to the original run through two independent Gateways, without Desktop Link", async () => {
  const { db } = await createTestPlatformDb();
  const home = await realpath(await mkdtemp(join(tmpdir(), "eng495-managed-")));
  const dispose: Array<() => Promise<unknown> | void> = [
    () => destroyTestPlatformDb(db), () => rm(home, { recursive: true, force: true }),
  ];
  async function server(app: Hono) {
    const running = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    dispose.push(() => new Promise<void>((resolve) => { running.close(() => resolve()); running.closeAllConnections?.(); }));
    if (!running.listening) await new Promise<void>((resolve, reject) => {
      running.once("error", reject);
      running.once("listening", resolve);
    });
    return "http://127.0.0.1:" + (running.address() as AddressInfo).port;
  }

  try {
    const ownerId = "user_managed_integration";
    const source = { ownerId, machineId: "source-integration", runtimeSlot: "primary" };
    const target = { ownerId, machineId: "target-integration", runtimeSlot: "dev" };
    const platformSecret = "integration-fixture-unique-key";
    const now = new Date().toISOString();
    const machineKey = (machine: typeof source, handle: string) => buildPlatformSyncVerificationToken({ ...machine, handle }, platformSecret);
    for (const [machine, handle] of [[source, "source-computer"], [target, "target-computer"]] as const) {
      await insertUserMachine(db, { machineId: machine.machineId, runtimeSlot: machine.runtimeSlot, handle, clerkUserId: ownerId,
        activationState: "authorized", deletedAt: null, status: "running", publicIPv4: "203.0.113.21", provisionedAt: now });
    }

    const targetWorktreeId = "wt_1111111111111111";
    const projectDir = join(home, "projects", "managed");
    const worktree = join(home, "worktrees", "managed", targetWorktreeId);
    const configDir = join(home, "system", "projects", "managed");
    const recordDir = join(configDir, "worktrees", targetWorktreeId);
    await Promise.all([mkdir(worktree, { recursive: true }), mkdir(projectDir, { recursive: true }), mkdir(recordDir, { recursive: true })]);
    await Promise.all([
      writeFile(join(configDir, "config.json"), JSON.stringify({ id: "proj_managed", name: "Managed", slug: "managed",
        localPath: projectDir, addedAt: now, updatedAt: now, ownerScope: { type: "user", id: ownerId } })),
      writeFile(join(recordDir, "worktree.json"), JSON.stringify({ id: targetWorktreeId, projectSlug: "managed",
        path: worktree, sourceBranch: "main", currentBranch: "managed", dirtyState: "unknown", createdAt: now })),
    ]);

    const core = createFakeHerdrCore();
    core.add("t1", { title: "target-worktree", identity: { pid: 123, created_ms: 1, cwd: worktree }, screen: "target integration output" });
    core.add("t2", { title: "outside", identity: { pid: 124, created_ms: 1, cwd: projectDir }, screen: "outside output" });
    const adapter = createHerdrAdapter({ open: async () => core.connect(), captureQuietMs: 5, captureMaxMs: 100 });
    dispose.push(() => adapter.close());
    const enabled = { MATRIX_MANAGED_TERMINAL_CONTROL_ENABLED: "1" };
    const targetApp = new Hono();
    targetApp.use("*", authMiddleware("ordinary-target-gateway-token"));
    targetApp.route(MANAGED_TERMINAL_TARGET_PATH, createManagedTerminalTargetRoutes({
      adapter, inputActivity: createTerminalInputActivity(), homePath: home, worktrees: createWorktreeManager({ homePath: home }),
      env: { ...enabled, MATRIX_CLERK_USER_ID: ownerId, MATRIX_MACHINE_ID: target.machineId,
        MATRIX_RUNTIME_SLOT: target.runtimeSlot, MATRIX_SYNC_RUNTIME_TOKEN: machineKey(target, "target-computer") },
    }));
    const targetOrigin = await server(targetApp);
    const platformOrigin = await server(createManagedTerminalControlRoutes({
      db, platformSecret, env: enabled, substrates: {
        get: () => ({ ok: false, reason: "substrate_unavailable" }),
        resolveUpstream: (machine, route) => machine.handle === "target-computer" && route.path === MANAGED_TERMINAL_TARGET_PATH
          ? { kind: "upstream", upstream: { url: targetOrigin + route.path, hostHeader: new URL(targetOrigin).host } }
          : { kind: "not_routable" },
      },
    }));
    const broker = createManagedTerminalBroker({ origin: platformOrigin, identity: source, token: machineKey(source, "source-computer") });
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: ownerId });
    dispose.push(() => registry.close());
    const sourceApp = new Hono();
    sourceApp.use("*", authMiddleware("ordinary-source-gateway-token", { resolveMatrixMcpRunContext: registry.resolveRunContext }));
    sourceApp.route(HERDR_CHAT_ROUTE, createHerdrChatTerminalRoute(null, createTerminalInputActivity(), null, broker));
    const sourceOrigin = await server(sourceApp);
    const owner = { type: "personal" as const, ownerId };
    const call = (token: string, action: object) => fetch(sourceOrigin + HERDR_CHAT_ROUTE, {
      method: "POST", signal: AbortSignal.timeout(5000), headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify(action),
    });
    const discovery = registry.issue({ owner, runId: "run_inventory", scope: "chat_herdr_discovery" })!;
    const listing = await call(discovery.token, { action: "discover", machine: "matrix:" + target.machineId });
    expect(await listing.json()).toMatchObject({ name: "target-computer", terminals: [{ address: "matrix:target-integration/t1" }] });
    expect((await call(discovery.token, { action: "send", text: "echo unauthorized" })).status).toBe(403);
    const [computer] = (await broker.computers()).computers;
    const [terminal] = (await broker.terminals(computer!.machineId)).sessions;
    const ref = { workspaceId: computer!.workspaceId, tabId: terminal!.tabId };
    const chatId = "chat_original";
    const worktreeId = "wt_2222222222222222";
    const clientRequestId = "req_original";
    const body = { clientRequestId, baseRevision: 0, parts: herdrControlParts().map(part => part.type === "resource_reference"
      ? { ...part, resource: { ...part.resource, id: `${ref.workspaceId}:${ref.tabId}`, revision: terminal!.revision } } : part),
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" }, interactionMode: "default", permissionMode: "full_access",
      executionRoot: { kind: "worktree", projectId: "proj_source", worktreeId },
    };
    const path = `/api/chats/${chatId}/turns`;
    const proof = await authenticatedManagedTerminalProxyProof({
      method: "POST", path, platformSecret,
      request: new Request(platformOrigin + path, { method: "POST", body: JSON.stringify(body),
        headers: { "content-type": "application/json" } }),
      machine: { machineId: source.machineId, runtimeSlot: source.runtimeSlot, runtimeTokenEpoch: 1, clerkUserId: ownerId,
        provisioningClass: "customer", status: "running", activationState: "authorized", deletedAt: null, accessClerkUserIds: [] },
      identity: { source: "auth", sessionProvenance: "clerk-browser", userId: ownerId,
        verifiedHumanBrowserExpiresAt: Math.floor(Date.now() / 1000) + 60 },
    });
    expect(typeof proof).toBe("string");
    const grant = registry.issue({ owner, runId: "run_original", scope: "chat_herdr", fullAccess: true,
      herdr: { chatId, worktreeId, executionRoot: "/source/worktree",
        ref, revision: terminal!.revision!,
        authority: { proof: proof as string, clientRequestId, bodyDigest: managedTerminalBodyDigest(canonicalPreviewDriveTurnBody(body)) } },
    })!;
    expect(await (await call(grant.token, { action: "send", text: "echo scoped" })).json())
      .toMatchObject({ runId: "run_original", ref, result: { sent: true } });
    expect(await (await call(grant.token, { action: "read", lines: 5 })).json())
      .toMatchObject({ runId: "run_original", ref, result: { screen: "target integration output" } });
    grant.revoke();
    expect((await call(grant.token, { action: "send", text: "echo late" })).status).toBe(401);
    expect(core.terminals.get("t1")!.input).toEqual(["echo scoped\r"]);
    expect(core.terminals.get("t2")!.input).toEqual([]);
  } finally {
    for (const cleanup of dispose.reverse()) await cleanup();
  }
}, 20_000);
