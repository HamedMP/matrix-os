import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANAGED_TERMINAL_TARGET_PATH } from "@matrix-os/contracts/managed-terminal-control";
import {
  createManagedTerminalHeaders,
  MANAGED_TERMINAL_NONCE_HEADER,
  MANAGED_TERMINAL_TIMESTAMP_HEADER,
  openManagedTerminalPayload,
  sealManagedTerminalPayload,
  verifyManagedTerminalReply,
} from "@matrix-os/contracts/managed-terminal-proof";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createHerdrAdapter } from "../../packages/gateway/src/herdr/adapter.js";
import { createManagedTerminalTargetRoutes } from "../../packages/gateway/src/herdr/managed-terminal-target.js";
import { createManagedTerminalRootResolver } from "../../packages/gateway/src/herdr/managed-terminal-worktree.js";
import { herdrTerminalRef } from "../../packages/gateway/src/herdr/refs.js";
import { createTerminalInputActivity } from "../../packages/gateway/src/terminal-agent/input-activity.js";
import { createWorktreeManager } from "../../packages/gateway/src/worktree-manager.js";
import { createFakeHerdrCore } from "./fixtures/fake-herdr-core-server.js";

const ownerId = "user_managed_owner";
const worktreeId = "wt_a1b2c3d4e5f6";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "managed-terminal-")));
  cleanup.push(() => rm(home, { force: true, recursive: true }));
  const worktree = join(home, "worktrees", "demo", worktreeId);
  const projectRoot = join(home, "projects", "demo");
  const recordDir = join(home, "system", "projects", "demo");
  const projectConfig = join(recordDir, "config.json");
  const now = "2026-11-28T00:00:00.000Z";
  const project = {
    id: "proj_demo", name: "Demo", slug: "demo", localPath: projectRoot,
    addedAt: now, updatedAt: now, ownerScope: { type: "user", id: ownerId },
  };
  await Promise.all([mkdir(worktree, { recursive: true }), mkdir(projectRoot, { recursive: true }),
    mkdir(join(recordDir, "worktrees", worktreeId), { recursive: true })]);
  await Promise.all([
    writeFile(projectConfig, JSON.stringify(project)),
    writeFile(join(recordDir, "worktrees", worktreeId, "worktree.json"), JSON.stringify({
      id: worktreeId, projectSlug: "demo", path: worktree, sourceBranch: "demo", currentBranch: "demo",
      dirtyState: "unknown", createdAt: now,
    })),
  ]);
  const worktrees = createWorktreeManager({ homePath: home });
  const resolveRoot = createManagedTerminalRootResolver({ homePath: home, ownerId, worktrees });
  return { home, worktree, projectRoot, projectConfig, project, resolveRoot };
}

describe("managed terminal target worktree fence", () => {
  it("resolves native records for the local owner only", async () => {
    const { worktree, projectRoot, project, projectConfig, resolveRoot } = await fixture();
    expect(await resolveRoot(worktree)).toBe(worktree);
    expect(await resolveRoot(projectRoot)).toBeNull();
    expect(await resolveRoot(join(worktree, "arbitrary"))).toBeNull();
    await writeFile(projectConfig, JSON.stringify({ ...project, ownerScope: { type: "org", id: ownerId } }));
    expect(await resolveRoot(worktree)).toBeNull();
  });

  it("refuses a registered path whose ancestor is replaced by a symlink", async () => {
    const { home, worktree, projectRoot, resolveRoot } = await fixture();
    const replacement = join(home, "redirected");
    await rename(join(home, "worktrees"), replacement);
    await symlink(replacement, join(home, "worktrees"), "dir");
    expect(await resolveRoot(worktree)).toBeNull();
    expect(await resolveRoot(projectRoot)).toBeNull();
  });

  it("uses a selected local incarnation and rejects other directories, remote refs, and stale owner grants", async () => {
    const { worktree, projectRoot, project, projectConfig, resolveRoot } = await fixture();
    const core = createFakeHerdrCore();
    const identity = { pid: 10, created_ms: 10, cwd: worktree };
    core.add("t1", { identity, screen: "target output" });
    core.add("t2", { identity: { ...identity, cwd: projectRoot } });
    core.add("dev/t1", { identity, screen: "ssh output" });
    const adapter = createHerdrAdapter({ open: async () => core.connect(), captureQuietMs: 5, captureMaxMs: 100 });
    cleanup.push(() => adapter.close());
    const sessions = (await adapter.listForManagedChatControl(resolveRoot)).sessions;
    expect(sessions).toMatchObject([{ id: "t1", revision: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    const bind = (id: string) => adapter.bindManagedChatTerminal(herdrTerminalRef(id), {
      revision: sessions[0]!.revision!, inputActivity: createTerminalInputActivity(), signal: new AbortController().signal,
    }, resolveRoot);
    const selected = await bind("t1");
    expect(selected).toBeTruthy();
    expect(await selected!.read(0)).toMatchObject({ screen: "target output" });
    expect(await selected!.send("run checks")).toMatchObject({ sent: true });
    expect(await bind("t2")).toBeNull();
    expect(await bind("dev/t1")).toBeNull();
    await writeFile(projectConfig, JSON.stringify({ ...project, archivedAt: "2026-11-28" }));
    await expect(selected!.send("stale scope")).rejects.toMatchObject({ code: "not_found" });
    expect(core.terminals.get("t1")!.input).toEqual(["run checks\r"]);
    expect(core.terminals.get("t2")!.input).toEqual([]);
    expect(core.terminals.get("dev/t1")!.input).toEqual([]);
  });
});

const syncToken = "a".repeat(64);
const source = { machineId: "c0ab57e9-f909-48e2-9dce-d38bd1a658e1", ownerId, runtimeSlot: "pv-source" };
const target = { machineId: "9ca5ab62-8cc4-4d18-ae85-88159312ea61", ownerId, runtimeSlot: "pv-target" };
const env = {
  MATRIX_MANAGED_TERMINAL_CONTROL_ENABLED: "1", MATRIX_CLERK_USER_ID: ownerId,
  MATRIX_MACHINE_ID: target.machineId, MATRIX_RUNTIME_SLOT: target.runtimeSlot,
  MATRIX_SYNC_RUNTIME_TOKEN: syncToken,
};
async function targetFixture(overrides: NodeJS.ProcessEnv = {}) {
  const { home, worktree } = await fixture();
  const core = createFakeHerdrCore();
  core.add("t1", { identity: { pid: 10, created_ms: 10, cwd: worktree }, screen: "target status" });
  const terminal = core.terminals.get("t1")!;
  const adapter = createHerdrAdapter({ open: async () => core.connect(), captureQuietMs: 5, captureMaxMs: 100 });
  cleanup.push(() => adapter.close());
  const app = new Hono();
  app.use("*", authMiddleware("regular-gateway-token"));
  app.route(MANAGED_TERMINAL_TARGET_PATH, createManagedTerminalTargetRoutes({
    env: { ...env, ...overrides }, homePath: home, worktrees: createWorktreeManager({ homePath: home }),
    adapter, inputActivity: createTerminalInputActivity(),
  }));

  const list = { source, target, request: { kind: "terminals", targetMachineId: target.machineId } };
  const sendWire = (body: string, headers?: HeadersInit, path = MANAGED_TERMINAL_TARGET_PATH) =>
    app.request(path, { method: "POST", body, headers: headers ?? createManagedTerminalHeaders(syncToken, "target", body) });
  const send = (input: unknown) => sendWire(sealManagedTerminalPayload(syncToken, "target", JSON.stringify(input)));
  async function selectedTerminal() {
    const response = await send(list);
    expect(response.status).toBe(200);
    const { sessions } = readTargetPayload(await response.text());
    expect(sessions).toHaveLength(1);
    return {
      source, target, request: {
        kind: "action", targetMachineId: target.machineId, chatId: "chat_example", runId: "run_example",
        worktreeId: "wt_0987654321ab", ref: herdrTerminalRef("t1"), revision: sessions[0].revision as string,
        action: { action: "send", text: "run checks" },
      },
    };
  }
  return { send, sendWire, list, selectedTerminal, terminal, core };
}

function readTargetPayload(raw: string) {
  return JSON.parse(openManagedTerminalPayload(syncToken, "target-response", raw)!);
}

describe("managed terminal target request authentication", () => {
  it("accepts only an exact role-signed, fresh proof through the gateway and refuses replay after a real send", async () => {
    const { sendWire, selectedTerminal, terminal } = await targetFixture();
    const body = await selectedTerminal();
    const unsealed = JSON.stringify(body);
    const raw = sealManagedTerminalPayload(syncToken, "target", unsealed);
    const signed = createManagedTerminalHeaders(syncToken, "target", raw);
    expect((await sendWire(raw, createManagedTerminalHeaders(syncToken, "source", raw))).status).toBe(401);
    expect((await sendWire(raw, { "content-type": "application/json", authorization: "Bearer regular-gateway-token" })).status).toBe(401);
    expect((await sendWire(raw, createManagedTerminalHeaders(syncToken, "target", raw, { issuedAt: Date.now() - 60_000 }))).status).toBe(401);
    expect((await sendWire(raw + " ", signed)).status).toBe(401);
    expect((await sendWire(unsealed)).status).toBe(400);
    expect((await sendWire(raw, signed, MANAGED_TERMINAL_TARGET_PATH + "/other")).status).toBe(401);
    const response = await sendWire(raw, signed);
    expect(response.status).toBe(200);
    const output = await response.text();
    const time = Number(signed[MANAGED_TERMINAL_TIMESTAMP_HEADER]);
    const nonce = signed[MANAGED_TERMINAL_NONCE_HEADER]!;
    expect(openManagedTerminalPayload(syncToken, "target", output)).toBeNull();
    expect(readTargetPayload(output)).toMatchObject({ result: { sent: true } });
    expect(verifyManagedTerminalReply(syncToken, response, output, time, nonce)).toBe(true);
    expect(verifyManagedTerminalReply(syncToken, response, output + " ", time, nonce)).toBe(false);
    expect((await sendWire(raw, signed)).status).toBe(401);
    expect(terminal.input).toEqual(["run checks\r"]);
  });

  it("rejects cross-owner and wrong-slot proofs, target injection and replaced attachment identity", async () => {
    const { send, list, selectedTerminal, terminal, core } = await targetFixture();
    expect((await send({ ...list, source: { ...source, ownerId: "user_other" } })).status).toBe(403);
    expect((await send({ ...list, target: { ...target, runtimeSlot: "dev" } })).status).toBe(403);
    const body = await selectedTerminal();
    expect((await send({ ...body, request: { ...body.request, cwd: "/etc" } })).status).toBe(400);
    terminal.attachIdentity = { ...terminal.identity!, pid: 11 };
    expect((await send(body)).status).toBe(409);
    expect(core.viewers).toHaveLength(0);
    expect(terminal.input).toEqual([]);
  });

  it("fails closed without a configured canonical owner or opt-in", async () => {
    const disabled = await targetFixture({ MATRIX_MANAGED_TERMINAL_CONTROL_ENABLED: "0" });
    expect((await disabled.send(disabled.list)).status).toBe(404);
    const foreign = await targetFixture({ MATRIX_USER_ID: "local_another_owner" });
    expect((await foreign.send(foreign.list)).status).toBe(404);
  });
});
