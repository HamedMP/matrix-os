import { CollaborationRevocationEnforcer, SandboxRuntimeRegistry } from "../../../packages/gateway/src/collaboration/revocation-enforcer.js";
import { createBotBrokerActions } from "../../../packages/gateway/src/bots/broker-actions.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatExecutionRootError, createChatExecutionRootResolver } from "../../../packages/gateway/src/chat/execution-root.js";
import { ScopeRuntimeClientError } from "../../../packages/gateway/src/collaboration/scope-runtime-client.js";
import type { Kysely } from "kysely";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createPrivateBotAdmission, privateBotScopeHandle, type PrivateBotRunRequest } from "../../../packages/gateway/src/bots/admission.js";
import { BotRuntimeRegistry, type GroupBotAuthorizer } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { BOT, OWNER, NOW, createBotStateDatabase, insertChat } from "./bot-state-support.js";
import { createUnixSocketTempDir } from "../../helpers/unix-socket-temp.js";
import { createSystemdScopeRuntimeLauncher } from "../../../packages/scope-runtime/src/systemd-launcher.js";
import { createScopeRuntimeController } from "../../../packages/scope-runtime/src/supervisor.js";
import { botSandboxRootsForHome, managedPiSandboxRootsForHome } from "../../../packages/scope-runtime/src/sandbox.js";
import { SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID, SCOPE_RUNTIME_MANAGED_PI_PROFILE_DIGEST } from "../../../packages/scope-runtime/src/bot-profile.js";
import type { ScopeRuntimeRequest } from "../../../packages/scope-runtime/src/protocol.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

const CHAT = "chat_group1";
const RUNTIME = `runtime_${"c".repeat(32)}`;
const root = { ref: { kind: "project" as const, projectId: "project_company1" }, fingerprint: "f".repeat(64), primaryWorkspaceRoot: "/company/shared-root" };
const request: PrivateBotRunRequest = {
  ownerId: OWNER, botId: BOT, chatId: CHAT, taskId: "task_0123456789abcdef", runId: "run_group1",
  route: { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200_000, maxOutputTokens: 4096 },
  accessSourceId: "matrix_included", capabilities: [], requestClass: "interactive",
  group: { scopeId: "company-scope", actorId: "user_member", executionRoot: root.ref, executionRootFingerprint: root.fingerprint, sessionGeneration: "1" },
};
const context = {
  actorId: "user_member", ownerId: OWNER, organizationId: "org_company", scopeId: "company-scope", membershipScopeId: "company-scope",
  resourceKind: "chat" as const, resourceId: CHAT, role: "editor" as const, authEpoch: 2, authorityRuntimeId: "owner_runtime", authorityGeneration: 3,
  capability: "request_ai" as const,
};
let homePath: string;
let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
beforeEach(async () => {
  homePath = await realpath(await mkdtemp(join(tmpdir(), "matrix-group-root-")));
  root.primaryWorkspaceRoot = join(homePath, "projects", "company");
  await mkdir(root.primaryWorkspaceRoot, { recursive: true });
  ({ db, destroy } = await createBotStateDatabase());
  await insertChat(db, CHAT);
  await db.updateTable("chats").set({ collaboration: {
    scopeId: context.scopeId, membershipScopeId: context.scopeId, executionFenced: true,
  } }).where("id", "=", CHAT).execute();
  await db.insertInto("bot_chat_bindings").values({ owner_id: OWNER, bot_id: BOT, chat_id: CHAT, kind: "group", created_at: NOW, removed_at: null }).execute();
});
afterEach(async () => { await destroy(); await rm(homePath, { recursive: true, force: true }); });
function tracking(client: { stopRuntime(input: { runtimeHandle: string }): Promise<unknown> }) {
  const runtimes = new SandboxRuntimeRegistry({ client, startTimer: false });
  const revocations = new CollaborationRevocationEnforcer({ runtimes, control: { invalidateActor: () => undefined } });
  return { runtimes, revocations };
}
function setup(authorizeGroup?: GroupBotAuthorizer, duringLaunch?: () => void) {
  const registry = new BotRuntimeRegistry();
  const roots = { resolve: vi.fn(async () => root) };
  const client = { createRuntime: vi.fn(async (_input: unknown) => { duringLaunch?.(); return { runtimeHandle: RUNTIME, executionGeneration: "1" }; }), stopRuntime: vi.fn(async () => undefined) };
  const revocation = tracking(client);
  const admission = createPrivateBotAdmission({ db, registry, roots, homePath, getGroupRevocation: () => revocation, host: { available: true, client: client as never }, authorizeGroup });
  return { admission, registry, roots, client, revocation };
}
describe("shared group Pi admission", () => {
  it.each((["resolver", "filesystem"] as const).flatMap(stage => (["abort", "deadline"] as const).map(stop => ({ stage, stop }))))("bounds group root $stage on $stop without a late launch", async ({ stage, stop }) => {
    const cancelled = new AbortController(), deadline = new AbortController();
    const fixture = setup(async () => context);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    if (stage === "resolver") fixture.roots.resolve.mockImplementationOnce(async () => { entered(); await gate; return root; });
    else vi.mocked(realpath).mockImplementationOnce(async path => {
      entered(); await gate;
      return path as string;
    });
    const originalTimeout = AbortSignal.timeout;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => ms === 10_000 ? deadline.signal : originalTimeout(ms));
    const pending = fixture.admission.admit({ ...request, signal: cancelled.signal }).then(
      value => ({ kind: "admitted" as const, value }), (error: unknown) => ({ kind: "refused" as const, error }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observed: Awaited<typeof pending> | { kind: "still_waiting" };
    let launched: number;
    try {
      await started;
      if (stop === "abort") cancelled.abort();
      else deadline.abort(new DOMException("Synthetic root deadline", "TimeoutError"));
      observed = await Promise.race([pending, new Promise<{ kind: "still_waiting" }>(resolve => { timer = setTimeout(() => resolve({ kind: "still_waiting" }), 750); })]);
    } finally {
      if (timer) clearTimeout(timer);
      release(); await pending; timeout.mockRestore(); vi.mocked(realpath).mockRestore();
      launched = fixture.client.createRuntime.mock.calls.length;
      await fixture.admission.release(RUNTIME);
    }
    expect(observed!).toMatchObject({ kind: "refused", error: expect.objectContaining({ code: "unavailable" }) });
    expect(launched!).toBe(0); expect(fixture.registry.size).toBe(0); expect(fixture.revocation.runtimes.size).toBe(0);
  });
  it.each(([1, 2] as const).flatMap(check => (["abort", "deadline"] as const).map(stop => ({ check, stop }))))("bounds authorization check $check on $stop and cleans a late launch", async ({ check, stop }) => {
    const cancelled = new AbortController(), deadline = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let checks = 0;
    const authorize = vi.fn(async () => { if (++checks === check) await gate; return context; });
    const fixture = setup(authorize);
    const originalTimeout = AbortSignal.timeout;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => ms === 10_000 ? deadline.signal : originalTimeout(ms));
    const input: PrivateBotRunRequest & { signal: AbortSignal } = { ...request, signal: cancelled.signal };
    const pending = fixture.admission.admit(input).then(value => ({ kind: "admitted" as const, value }), (error: unknown) => ({ kind: "refused" as const, error }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observed: Awaited<typeof pending> | { kind: "still_waiting" };
    let afterLateRegistrySize: number;
    try {
      await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(check));
      if (stop === "abort") cancelled.abort();
      else deadline.abort(new DOMException("Synthetic authorization deadline", "TimeoutError"));
      observed = await Promise.race([pending, new Promise<{ kind: "still_waiting" }>(resolve => { timer = setTimeout(() => resolve({ kind: "still_waiting" }), 750); })]);
    } finally {
      if (timer) clearTimeout(timer);
      release(); await pending; timeout.mockRestore();
      afterLateRegistrySize = fixture.registry.size;
      await fixture.admission.release(RUNTIME);
    }
    expect(observed!).toMatchObject({ kind: "refused", error: expect.objectContaining({ code: "unavailable" }) });
    expect(afterLateRegistrySize!).toBe(0);
    if (check === 1) expect(fixture.client.createRuntime).not.toHaveBeenCalled();
    else expect(fixture.client.stopRuntime).toHaveBeenCalledWith({ runtimeHandle: RUNTIME });
  });
  it("refuses group launch without live revocation tracking", async () => {
    const { roots, registry, client } = setup(async () => context);
    const admission = createPrivateBotAdmission({ db, roots, registry, homePath, authorizeGroup: async () => context, host: { available: true, client: client as never } });
    await expect(admission.admit(request)).rejects.toMatchObject({ code: "unavailable" });
    expect(client.createRuntime).not.toHaveBeenCalled();
  });
  it("fences revocation after the final awaited authorization before binding", async () => {
    let checks = 0;
    const fixture = setup(async () => {
      if (++checks === 2) void fixture.revocation.revocations.revoke(context.scopeId, context.actorId);
      return context;
    });
    await expect(fixture.admission.admit(request)).rejects.toMatchObject({ code: "not_found" });
    expect(fixture.registry.size).toBe(0);
    expect(fixture.revocation.runtimes.size).toBe(0);
    expect(fixture.client.stopRuntime).toHaveBeenCalledWith({ runtimeHandle: RUNTIME });
  });
  it("aborts actual in-flight broker inference before a slow physical stop finishes", async () => {
    const fixture = setup(async () => context);
    await fixture.admission.admit(request);
    expect(fixture.revocation.runtimes.size).toBe(1);
    let finishStop!: () => void;
    fixture.client.stopRuntime.mockImplementationOnce(() => new Promise<void>(resolve => { finishStop = resolve; }));
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      signal = init!.signal!;
      return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once:true }));
    });
    const actions = createBotBrokerActions({ db:{} as never, sessions:{} as never, checkpoints:{} as never, runs:{} as never,
      events:{} as never, tools:{} as never, registry:fixture.registry, authorizeGroup:async()=>context,
      inference:{ homePath, lifetime:new AbortController().signal, fetchImpl,
        resolveCredentials:async()=>({env:{ANTHROPIC_AUTH_TOKEN:"synthetic",ANTHROPIC_BASE_URL:"https://relay.example.invalid"}}) },
    });
    const pending = actions.handleFrame({ version:1, action:"inference.messages", requestId:"018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1",
      runtimeHandle:RUNTIME, executionGeneration:"1", method:"POST", path:"/v1/messages?beta=true", headers:{},
      body:JSON.stringify({model:request.route.modelId,stream:true,max_tokens:32,messages:[{role:"user",content:"Synthetic request"}]}) });
    await vi.waitFor(()=>expect(fetchImpl).toHaveBeenCalledOnce());
    fixture.revocation.revocations.onSessionEnded(context, "expired");
    const stopping = fixture.revocation.revocations.settle();
    expect(signal?.aborted).toBe(true);
    expect(fixture.registry.size).toBe(0);
    expect(fixture.revocation.runtimes.size).toBe(0);
    await expect(pending).resolves.toMatchObject({ok:false,error:"provider_unavailable"});
    finishStop(); await stopping;
  });
  it("aborts every matching run before awaiting the first worker stop", async () => {
    const fixture=setup(async()=>context); const second=`runtime_${"d".repeat(32)}`;
    fixture.client.createRuntime.mockResolvedValueOnce({runtimeHandle:RUNTIME,executionGeneration:"1"}).mockResolvedValueOnce({runtimeHandle:second,executionGeneration:"1"});
    await fixture.admission.admit(request); await fixture.admission.admit({...request,runId:"run_group2"});
    const identity={ownerId:OWNER,chatId:CHAT,executionGeneration:"1"};
    const signals=[fixture.registry.inferenceSignal({...identity,runtimeHandle:RUNTIME,runId:request.runId}),fixture.registry.inferenceSignal({...identity,runtimeHandle:second,runId:"run_group2"})];
    let finishStop!:()=>void; fixture.client.stopRuntime.mockImplementationOnce(()=>new Promise<void>(resolve=>{finishStop=resolve;}));
    const pending=fixture.revocation.revocations.revoke(context.scopeId,context.actorId);
    expect(signals.map(signal=>signal?.aborted)).toEqual([true,true]);
    finishStop(); await pending;
  });
  it("removes revocation tracking on normal release even when stopping fails", async () => {
    const fixture=setup(async()=>context); await fixture.admission.admit(request);
    fixture.client.stopRuntime.mockRejectedValueOnce(new ScopeRuntimeClientError("runtime_unavailable"));
    await fixture.admission.release(RUNTIME);
    expect(fixture.revocation.runtimes.size).toBe(0);expect(fixture.registry.size).toBe(0);
  });
  it("cleans both registries and stops the worker if tracking bind fails", async () => {
    const fixture=setup(async()=>context);
    vi.spyOn(fixture.revocation.runtimes,"bind").mockImplementationOnce(()=>{throw new Error("tracking unavailable");});
    await expect(fixture.admission.admit(request)).rejects.toThrow("tracking unavailable");
    expect(fixture.registry.size).toBe(0);expect(fixture.revocation.runtimes.size).toBe(0);
    expect(fixture.client.stopRuntime).toHaveBeenCalledWith({runtimeHandle:RUNTIME});
  });
  it("aborts and unbinds a worker evicted by bounded revocation capacity", async () => {
    const fixture=setup(async()=>context);const second=`runtime_${"d".repeat(32)}`;
    fixture.revocation.runtimes=new SandboxRuntimeRegistry({client:fixture.client,startTimer:false,maxEntries:1});
    fixture.client.createRuntime.mockResolvedValueOnce({runtimeHandle:RUNTIME,executionGeneration:"1"}).mockResolvedValueOnce({runtimeHandle:second,executionGeneration:"1"});
    await fixture.admission.admit(request);
    const signal=fixture.registry.inferenceSignal({ownerId:OWNER,chatId:CHAT,runId:request.runId,runtimeHandle:RUNTIME,executionGeneration:"1"})!;
    await fixture.admission.admit({...request,runId:"run_group2"});
    expect(signal.aborted).toBe(true);expect(fixture.registry.lookup({runtimeHandle:RUNTIME,executionGeneration:"1"})).toBeNull();
    expect(fixture.revocation.runtimes.size).toBe(1);await fixture.revocation.runtimes.settle();
  });
  it.each(["project", "worktree"] as const)("launches an authorized %s through the actual supervisor and confined Pi launcher", async (kind) => {
    const fixture = await createUnixSocketTempDir();
    const broker = createServer();
    const stateRoot = join(fixture, "state");
    const brokerSocket = join(fixture, "broker.sock");
    const botRuntimeDirectory = join(fixture, "bot-runtime");
    const sdkDirectory = join(fixture, "sdk"), nativeDirectory = join(fixture, "native");
    const workerFile = join(fixture, "worker.js");
    const workspace = kind === "project" ? root.primaryWorkspaceRoot : join(homePath, "worktrees", "company", "review");
    let controller: Awaited<ReturnType<typeof createScopeRuntimeController>> | undefined;
    try {
      await mkdir(workspace, { recursive: true });
      for (const directory of [botRuntimeDirectory, sdkDirectory, nativeDirectory]) await mkdir(directory);
      await writeFile(join(botRuntimeDirectory, "bot-worker.mjs"), "export {};\n");
      await writeFile(join(sdkDirectory, "sdk.mjs"), "export {};\n");
      await writeFile(join(nativeDirectory, "claude"), "#!/bin/sh\nexit 0\n");
      await chmod(join(nativeDirectory, "claude"), 0o755);
      await writeFile(workerFile, "export {};\n");
      await new Promise<void>((resolve, reject) => { broker.once("error", reject); broker.listen(brokerSocket, resolve); });
      const commands: Array<{ command: string; args: readonly string[] }> = [];
      const launcher = createSystemdScopeRuntimeLauncher({
        stateRoot, sdkDirectory, nativeDirectory, workerFile, brokerSocket, botRuntimeDirectory, nodeBinary: process.execPath,
        botSandboxRoots: botSandboxRootsForHome(homePath), managedPiSandboxRoots: managedPiSandboxRootsForHome(homePath),
        runCommand: async (command, args) => {
          commands.push({ command, args });
          if (command === "/usr/bin/systemd-run") await writeFile(join(stateRoot, "runtimes", "c".repeat(32), "ready"), `${RUNTIME}\n`);
          return { stdout: command === "/usr/bin/systemd-run" ? "" : args[0] === "list-units" ? "" : "active\n" };
        },
      });
      const activeController = await createScopeRuntimeController({ launcher, executionGeneration: "7", createRuntimeHandle: () => RUNTIME });
      controller = activeController;
      type Create = Omit<Extract<ScopeRuntimeRequest, { type: "runtime.create" }>, "version" | "type" | "requestId">;
      const client = {
        async createRuntime(input: Create) {
          const response = await activeController.handle({ ...input, version: 1, type: "runtime.create", requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1" });
          if (!response.ok || response.type !== "runtime.result") throw new ScopeRuntimeClientError("runtime_unavailable");
          return { runtimeHandle: response.runtimeHandle, executionGeneration: response.executionGeneration };
        },
        stopRuntime: vi.fn(async () => undefined),
      };
      const registry = new BotRuntimeRegistry();
      const revocation = tracking(client);
      const admission = createPrivateBotAdmission({ db, registry, homePath, getGroupRevocation: () => revocation, roots: { resolve: async () => ({ ...root, primaryWorkspaceRoot: workspace }) },
        host: { available: true, client: client as never }, authorizeGroup: async () => context });
      const executionRoot = kind === "project" ? root.ref : { kind: "worktree" as const, projectId: root.ref.projectId, worktreeId: "worktree_company1" };
      await expect(admission.admit({ ...request, group: { ...request.group!, executionRoot } })).resolves.toMatchObject({ runtimeHandle: RUNTIME });
      const args = commands.find(({ command }) => command === "/usr/bin/systemd-run")!.args;
      expect(args.filter((arg) => arg.startsWith("--property=Bind") && arg.endsWith(":/workspace/project"))).toEqual([`--property=BindPaths=${workspace}:/workspace/project`]);
      expect(args).toContain("--property=PrivateNetwork=yes");
      expect(args).toContain("--property=ProtectHome=yes");
      const provenance = JSON.parse(await readFile(join(stateRoot, "runtimes", "c".repeat(32), "provenance.json"), "utf8"));
      expect(provenance).toMatchObject({ profileId: SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID, profileDigest: SCOPE_RUNTIME_MANAGED_PI_PROFILE_DIGEST, workload: "bot_agent" });
      expect(registry.lookup({ runtimeHandle: RUNTIME, executionGeneration: "7" })).toMatchObject({ group: { actorId: "user_member" } });
    } finally {
      await controller?.close();
      if (broker.listening) await new Promise<void>((resolve) => broker.close(() => resolve()));
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it("requires fresh exact collaboration authorization and never uses the private workspace", async () => {
    const authorize = vi.fn(async () => context);
    const { admission, roots, client, registry } = setup(authorize);
    expect(await admission.ownsDirectChat(request)).toBe(false);
    await admission.admit(request);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(roots.resolve).toHaveBeenCalledWith({ type: "personal", ownerId: OWNER }, root.ref);
    const launch = client.createRuntime.mock.calls[0]![0] as never as { scopeHandle: string; sandbox: { actorId: string; worktree: { hostPath: string } } };
    expect(launch.scopeHandle).not.toBe(privateBotScopeHandle(OWNER, BOT));
    expect(launch.sandbox).toMatchObject({ actorId: "user_member", worktree: { hostPath: root.primaryWorkspaceRoot } });
    expect(registry.lookup({ runtimeHandle: RUNTIME, executionGeneration: "1" })).toMatchObject({ group: { authEpoch: 2, actorId: "user_member" } });
  });
  it("fails closed on absent authority, wrong actor/scope/chat/owner, and private capabilities/root", async () => {
    const missingAuthority = setup(undefined);
    await expect(missingAuthority.admission.admit(request)).rejects.toMatchObject({ code: "unavailable" });
    expect(missingAuthority.client.createRuntime).not.toHaveBeenCalled();
    for (const authorize of [async () => ({ ...context, actorId: "intruder" }), async () => ({ ...context, scopeId: "other" }), async () => ({ ...context, resourceId: "chat_other" }), async () => ({ ...context, ownerId: "other-owner" })]) {
      const { admission, client } = setup(authorize);
      await expect(admission.admit(request)).rejects.toMatchObject({ code: "not_found" });
      expect(client.createRuntime).not.toHaveBeenCalled();
    }
    const { admission, client } = setup(async () => context);
    await expect(admission.admit({ ...request, capabilities: ["artifact.read"] })).rejects.toMatchObject({ code: "not_found" });
    await expect(admission.admit({ ...request, group: { ...request.group!, executionRoot: { kind: "bot_workspace", botId: BOT } } as never })).rejects.toMatchObject({ code: "invalid_root" });
    expect(client.createRuntime).not.toHaveBeenCalled();
  });
  it("refuses stale canonical group root provenance before launch", async () => {
    const { admission, client } = setup(async () => context);
    await expect(admission.admit({ ...request, group: { ...request.group!, executionRootFingerprint: "b".repeat(64) } })).rejects.toMatchObject({ code: "root_changed" });
    expect(client.createRuntime).not.toHaveBeenCalled();
  });
  it("stops the new runtime if authority changes while launch waits", async () => {
    let epoch = 2;
    const { admission, client, registry } = setup(async () => ({ ...context, authEpoch: epoch }), () => { epoch += 1; });
    await expect(admission.admit(request)).rejects.toThrow("authority changed");
    expect(client.stopRuntime).toHaveBeenCalledWith({ runtimeHandle: RUNTIME });
    expect(registry.size).toBe(0);
  });
  it.each(["bots", "agent-workspaces", "system"])("refuses a shared folder Project under private %s", async (directory) => {
    const { admission, client, roots } = setup(async () => context);
    const privateRoot = join(homePath, directory, BOT); await mkdir(privateRoot, { recursive: true });
    roots.resolve.mockResolvedValue({ ...root, primaryWorkspaceRoot: privateRoot });
    await expect(admission.admit(request)).rejects.toMatchObject({ code: "invalid_root" });
    expect(client.createRuntime).not.toHaveBeenCalled();
  });

  it("refuses a managed Project whose ancestor symlink reaches private owner files", async () => {
    await rm(join(homePath, "projects"), { recursive: true });
    const privateRoot = join(homePath, "bots", BOT); await mkdir(join(privateRoot, "company"), { recursive: true });
    await symlink(privateRoot, join(homePath, "projects"));
    const { registry, client, revocation } = setup(async () => context);
    const roots = createChatExecutionRootResolver({ homePath,
      projects: { getProjectById: async () => ({ ok: true as const, project: { id: root.ref.projectId, slug: "company", localPath: root.primaryWorkspaceRoot } }), resolveProjectWorkingDirectory: async () => root.primaryWorkspaceRoot },
      worktrees: { getWorktree: async () => ({ ok: false as const, status: 404, error: "absent" }) } });
    const admission = createPrivateBotAdmission({ db, roots, registry, homePath, getGroupRevocation: () => revocation, authorizeGroup: async () => context, host: { available: true, client: client as never } });
    await expect(admission.admit(request)).rejects.toMatchObject({ code: "invalid_root" }); expect(client.createRuntime).not.toHaveBeenCalled();
  });

  it("accepts a managed worktree but denies external folders, managed-container roots and missing trusted home", async () => {
    const { admission, client, roots, registry, revocation } = setup(async () => context);
    const worktree = join(homePath, "worktrees", "company", "review"); await mkdir(worktree, { recursive: true });
    roots.resolve.mockResolvedValue({ ...root, primaryWorkspaceRoot: worktree });
    await expect(admission.admit(request)).resolves.toMatchObject({ runtimeHandle: RUNTIME }); await admission.release(RUNTIME);
    const outside = await realpath(await mkdtemp(join(tmpdir(), "matrix-external-root-")));
    try {
      for (const candidate of [outside, join(homePath, "projects")]) {
        roots.resolve.mockResolvedValue({ ...root, primaryWorkspaceRoot: candidate });
        await expect(admission.admit(request)).rejects.toMatchObject({ code: "invalid_root" });
      }
      const missingHome = createPrivateBotAdmission({ db, roots, registry, getGroupRevocation: () => revocation, authorizeGroup: async () => context, host: { available: true, client: client as never } });
      await expect(missingHome.admit(request)).rejects.toMatchObject({ code: "unavailable" });
    } finally { await rm(outside, { recursive: true, force: true }); }
    expect(client.createRuntime).toHaveBeenCalledOnce();
  });

  it("denies invalid session generations but permits only explicitly granted group integration tools", async () => {
    const { admission, client } = setup(async () => context);
    for (const sessionGeneration of ["0", ""]) await expect(admission.admit({ ...request, group: { ...request.group!, sessionGeneration } })).rejects.toMatchObject({ code: "not_found" });
    expect(client.createRuntime).not.toHaveBeenCalled();
    await expect(admission.admit({ ...request, capabilities: ["integration.inventory", "integration.call"] })).resolves.toMatchObject({ runtimeHandle: RUNTIME });
  });

  it("classifies root resolver outages separately from invalid roots and preserves unexpected failures", async () => {
    const { admission, roots, client } = setup(async () => context);
    roots.resolve.mockRejectedValueOnce(new ChatExecutionRootError("validation_unavailable"));
    await expect(admission.admit(request)).rejects.toMatchObject({ code: "unavailable" });
    roots.resolve.mockRejectedValueOnce(new ChatExecutionRootError("invalid_root"));
    await expect(admission.admit(request)).rejects.toMatchObject({ code: "invalid_root" });
    const outage = new Error("root repository connection lost"); roots.resolve.mockRejectedValueOnce(outage);
    await expect(admission.admit(request)).rejects.toBe(outage);
    expect(client.createRuntime).not.toHaveBeenCalled();
  });

  it("denies missing directories, files and symlink roots before runtime launch", async () => {
    const { admission, roots, client } = setup(async () => context);
    const file = join(homePath, "projects", "file"), link = join(homePath, "projects", "link"), loop = join(homePath, "projects", "loop");
    await writeFile(file, "owner private file"); await symlink(root.primaryWorkspaceRoot, link); await symlink(loop, loop);
    for (const candidate of [join(homePath, "projects", "absent"), file, join(file, "child"), link]) {
      roots.resolve.mockResolvedValue({ ...root, primaryWorkspaceRoot: candidate });
      await expect(admission.admit(request)).rejects.toMatchObject({ code: "invalid_root" });
    }
    roots.resolve.mockResolvedValue({ ...root, primaryWorkspaceRoot: loop });
    await expect(admission.admit(request)).rejects.toMatchObject({ code: "unavailable" });
    expect(client.createRuntime).not.toHaveBeenCalled();
  });

  it("always unbinds before a supervisor stop failure and preserves unexpected launch failures", async () => {
    const { admission, client, registry } = setup(async () => context);
    await admission.admit(request);
    client.stopRuntime.mockRejectedValueOnce(new ScopeRuntimeClientError("runtime_unavailable"));
    await expect(admission.release(RUNTIME)).resolves.toBeUndefined(); expect(registry.size).toBe(0);
    await admission.admit(request);
    const outage = new Error("supervisor transport failed"); client.stopRuntime.mockRejectedValueOnce(outage);
    await expect(admission.release(RUNTIME)).rejects.toBe(outage); expect(registry.size).toBe(0);
    client.createRuntime.mockRejectedValueOnce(outage);
    await expect(admission.admit(request)).rejects.toBe(outage); expect(registry.size).toBe(0);
  });

});


describe("shared group Pi renewal after Runtime integration", () => {
  it("renews the admitted shared root without using a personal bot workspace", async () => {
    const fixture = setup(async () => context);
    const renewRuntime = vi.fn(async () => undefined);
    Object.assign(fixture.client, { renewRuntime });
    await fixture.admission.admit(request);
    const binding = fixture.registry.lookupRun({ runtimeHandle: RUNTIME, executionGeneration: "1", runId: request.runId })!;
    await fixture.admission.renew(binding, undefined, request.group!.executionRoot);
    expect(renewRuntime).toHaveBeenCalledTimes(1);
    expect(fixture.roots.resolve).toHaveBeenLastCalledWith({ type: "personal", ownerId: OWNER }, request.group!.executionRoot);
    expect(fixture.registry.lookupRun(binding)).toEqual(binding);
    await fixture.admission.release(RUNTIME);
  });

  it.each(["authority", "root", "missing_root"] as const)("refuses renewal after %s changes before renewing the host", async (change) => {
    const authorize = vi.fn(async () => context);
    const fixture = setup(authorize);
    const renewRuntime = vi.fn(async () => undefined);
    Object.assign(fixture.client, { renewRuntime });
    await fixture.admission.admit(request);
    const binding = fixture.registry.lookupRun({ runtimeHandle: RUNTIME, executionGeneration: "1", runId: request.runId })!;
    if (change === "authority") authorize.mockResolvedValue({ ...context, authEpoch: context.authEpoch + 1 });
    if (change === "root") fixture.roots.resolve.mockResolvedValue({ ...root, fingerprint: "a".repeat(64) });
    await expect(fixture.admission.renew(binding, undefined, change === "missing_root" ? undefined : request.group!.executionRoot)).rejects.toMatchObject({ code: expect.stringMatching(/not_found|root_changed|invalid_root/) });
    expect(renewRuntime).not.toHaveBeenCalled();
    await fixture.admission.release(RUNTIME);
  });
});
