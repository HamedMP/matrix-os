import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { bindNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/native-account-metadata-binding.js";
import { createAgentSessionManager } from "../../packages/gateway/src/agent-session-manager.js";
import type { AgentLaunchInput } from "../../packages/gateway/src/agent-launcher.js";
import { createNativeCodexRuntime } from "../../packages/gateway/src/server/native-codex-runtime.js";
import { createWorkspaceRoutes } from "../../packages/gateway/src/workspace-routes.js";
import { createWorkspaceSessionOrchestrator } from "../../packages/gateway/src/workspace-session-orchestrator.js";
import { createProjectManager } from "../../packages/gateway/src/project-manager.js";
import { createWorktreeManager } from "../../packages/gateway/src/worktree-manager.js";
import { ProjectFenceError } from "../../packages/gateway/src/collaboration/project-fence.js";
import { createSessionRuntimeBridge } from "../../packages/gateway/src/session-runtime-bridge.js";

// Only the native executable boundary is replaced. Admission, persistence, start
// ownership, session manager, orchestrator and the HTTP route remain real.
const native = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../packages/gateway/src/ai-providers/codex-native-account-metadata.js", () => ({
  createCodexNativeAccountMetadataReader: () => native.read,
}));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture() {
  const homePath = await mkdtemp(join(tmpdir(), "public-codex-admission-"));
  cleanups.push(() => rm(homePath, { recursive: true, force: true }));
  native.read.mockReset();
  let enabled = true;
  let method: "terminal" | "api_key" = "terminal";
  let projectFenced = false;
  const trace: string[] = [];
  let consent = true;
  let principal = "public-native-owner-A";
  let revision = 1;
  let requestOwner = "owner";
  const fingerprint = createHash("sha256").update(principal).digest("hex");
  const configPath = join(homePath, "system/ai-providers/settings.json");
  const save = async () => {
    await mkdir(join(homePath, "system/ai-providers"), { recursive: true });
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, revision,
      harnesses: [{ id: "codex", driverId: "codex", harness: "codex", displayName: "Codex", accentColor: null,
        enabled, selectedAccountId: "native_account", accessSourceId: "owner_openai_profile",
        ...(consent ? { nativeAccountGeneration: fingerprint, nativeAccountConsentRevision: 1 } : {}),
        route: { kind: "fixed", providerId: "openai", modelId: "openai/gpt-5.6" } }],
      accountProfiles: [], gatewayPolicy: null, receipts: [],
    }));
  };
  await save();
  native.read.mockImplementation(async () => {
    trace.push("native-read");
    const captured = principal;
    return bindNativeAccountMetadata({ authMethod: method, accountLabel: "owner@example.test",
      checkedAt: new Date(Date.now() - 1000).toISOString(), staleAfter: new Date(Date.now() + 30000).toISOString(),
    }, async () => captured === principal, captured);
  });
  const getSnapshot = vi.fn(async () => ({ revision, access: { mode: "writable" },
    accessSources: [{ id: "owner_openai_profile", providerId: "openai", accountId: "native_account", kind: "provider_account", fundingKind: "owner_account" }],
    accounts: [{ id: "native_account", providerId: "openai", accessSourceId: "owner_openai_profile", authMethod: "terminal", authState: "authenticated" }],
  } as unknown as ProviderSettingsSnapshot));
  let sessionRuntime: ReturnType<typeof createWorkspaceSessionOrchestrator> | undefined;
  const runtime = createNativeCodexRuntime({ homePath, executable: "/fixture/codex", ownerIds: ["owner"],
    environment: () => ({ HOME: homePath, CODEX_HOME: join(homePath, ".codex") }),
    profileGuard: { assertReadable: vi.fn(async () => undefined) },
    getSettings: () => ({ getSnapshot }), getRuntime: () => sessionRuntime,
  });
  const effects: AgentLaunchInput[] = [];
  const launcher = { buildLaunch: vi.fn((input: AgentLaunchInput) => {
    effects.push(input);
    return { command: input.agent, args: [], cwd: input.cwd, env: {} };
  }) };
  const terminal = {
    ensureWorkspace: vi.fn(async () => ({ id: "tws_00000000000000000000000000000001" })),
    createTab: vi.fn(async () => ({ id: "tt_00000000000000000000000000000001" })),
    terminateTab: vi.fn(async () => undefined),
    writeInput: vi.fn(async () => undefined), listWorkspaces: vi.fn(async () => []),
  };
  const sandbox = { preflight: vi.fn(async () => ({ ok: true as const, sandbox: { enabled: false } })),
    cleanup: vi.fn(async () => undefined) };
  const projectManager = createProjectManager({ homePath });
  const worktreeManager = createWorktreeManager({ homePath });
  const bridge = createSessionRuntimeBridge();
  const manager = createAgentSessionManager({ homePath, worktreeManager, agentLauncher: launcher,
    terminalRuntime: terminal, resolveNativeCodexSubscription: runtime.resolveSubscription,
    beforeProjectSessionRemove: runtime.beforeProjectSessionRemove,
  });
  sessionRuntime = createWorkspaceSessionOrchestrator({ homePath, projectManager, worktreeManager,
    agentSessionManager: manager, agentSandbox: sandbox, sessionRuntimeBridge: bridge,
    onClose: () => manager.shutdown(),
  });
  const sharedRuntime = sessionRuntime;
  cleanups.push(async () => { await sharedRuntime.close(); bridge.close(); });
  const app = createWorkspaceRoutes({ homePath, projectManager, worktreeManager,
    agentSessionManager: manager, sessionOrchestrator: sharedRuntime,
    startSession: runtime.startSession,
    projectOperationAdmission: {
      async withLegacyAdmission(_scope, operation) {
        trace.push("project-admission");
        if (projectFenced) throw new ProjectFenceError("fenced");
        return operation();
      },
    },
    getOwnerScope: () => ({ type: "user", id: requestOwner }),
  });
  const start = (agent = "codex", projectSlug?: string) => app.request(new Request("http://localhost/api/sessions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: agent === "shell" ? "shell" : "agent", ...(agent === "shell" ? {} : { agent }), ...(projectSlug ? { projectSlug } : {}) }),
  }));
  const index = async () => JSON.parse(await readFile(join(homePath, "system/ai-providers/codex-execution-sessions.json"), "utf8"));
  return { homePath, runtime, sharedRuntime, manager, start, terminal, launcher, sandbox, effects, index, trace, getSnapshot,
    fenceProject: () => { projectFenced = true; },
    forgetRuntime: () => { sessionRuntime = undefined; },
    change: async (value: { enabled?: boolean; consent?: boolean; principal?: string; owner?: string; method?: "terminal" | "api_key"; missingSettings?: boolean }) => {
      if (value.method !== undefined) method = value.method;
      if (value.enabled !== undefined) enabled = value.enabled;
      if (value.consent !== undefined) consent = value.consent;
      if (value.principal !== undefined) principal = value.principal;
      if (value.owner !== undefined) requestOwner = value.owner;
      revision++;
      await save();
      if (value.missingSettings) await rm(configPath);
    },
  };
}

describe("public native Codex session admission", () => {
  it("constructs the shared runtime without observing an account or probing a model", async () => {
    const f = await fixture();
    expect(native.read).not.toHaveBeenCalled();
    expect(f.getSnapshot).not.toHaveBeenCalled();
    expect(f.terminal.createTab).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps project authorization before native admission (fenced=%s)", async fenced => {
    const f = await fixture();
    const localPath = join(f.homePath, "projects/repo/repo");
    await mkdir(join(localPath, ".git"), { recursive: true });
    await writeFile(join(f.homePath, "projects/repo/config.json"), JSON.stringify({ id: "proj_repo", slug: "repo",
      name: "repo", localPath, addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      ownerScope: { type: "user", id: "owner" },
    }));
    if (fenced) f.fenceProject();
    const response = await f.start("codex", "repo");
    expect(response.status).toBe(fenced ? 409 : 201);
    expect(f.trace[0]).toBe("project-admission");
    if (fenced) {
      expect(native.read).not.toHaveBeenCalled();
      expect(f.sandbox.preflight).not.toHaveBeenCalled();
      expect(f.terminal.createTab).not.toHaveBeenCalled();
    } else {
      expect(f.effects[0]?.nativeCodexSubscription?.expectedAccountId).toBe("native_account");
      const release = await f.runtime.admission.prepareRevocation();
      await release();
    }
  });

  it.each(["off", "missing consent", "missing settings", "foreign owner"])("rejects %s before sandbox, launcher or terminal effects", async reason => {
    const f = await fixture();
    await f.change(reason === "off" ? { enabled: false } : reason === "missing consent" ? { consent: false }
      : reason === "missing settings" ? { missingSettings: true } : { owner: "collaborator" });
    const response = await f.start();
    expect(response.status).toBe(400);
    expect(f.sandbox.preflight).not.toHaveBeenCalled();
    expect(f.effects).toEqual([]);
    expect(f.terminal.ensureWorkspace).not.toHaveBeenCalled();
    expect(f.terminal.createTab).not.toHaveBeenCalled();
  });

  it("passes exact native intent to the launcher, persists admission and drains the shared runtime on revocation", async () => {
    const f = await fixture();
    const response = await f.start();
    expect(response.status).toBe(201);
    const { session } = await response.json();
    expect(f.effects).toEqual([expect.objectContaining({ agent: "codex", nativeCodexSubscription: {
      codexHome: join(f.homePath, ".codex"), expectedPrincipalFingerprint: createHash("sha256").update("public-native-owner-A").digest("hex"),
      expectedConsentRevision: 1, expectedConfigurationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      expectedHarnessInstanceId: "codex", expectedAccountId: "native_account",
    } })]);
    expect(await f.index()).toEqual([expect.objectContaining({ sessionId: session.id, userId: "owner" })]);
    const release = await f.runtime.admission.prepareRevocation();
    expect(f.terminal.terminateTab).toHaveBeenCalledWith(session.terminalRef);
    expect(await f.manager.getSession(session.id)).toMatchObject({ ok: true, session: { runtime: { status: "exited" } } });
    expect(await f.index()).toEqual([]);
    expect((await f.start()).status).toBe(400);
    await release();
  });

  it("releases a proved clean launch failure so logout and a new start can proceed", async () => {
    const f = await fixture();
    f.launcher.buildLaunch.mockImplementationOnce(() => { throw new Error("fixture launch rejected"); });
    expect((await f.start()).status).toBe(400);
    expect(await f.index()).toEqual([]);
    expect(f.terminal.createTab).not.toHaveBeenCalled();
    const release = await f.runtime.admission.prepareRevocation();
    await release();
    expect((await f.start()).status).toBe(201);
  });

  it("retains an uncertain terminal acquisition and fences logout and subsequent starts", async () => {
    const f = await fixture();
    f.terminal.createTab.mockRejectedValueOnce(new Error("fixture transport unknown"));
    expect((await f.start()).status).toBe(503);
    expect(await f.index()).toHaveLength(1);
    await expect(f.runtime.admission.prepareRevocation()).rejects.toThrow("unavailable");
    expect((await f.start()).status).toBe(400);
    expect(f.terminal.createTab).toHaveBeenCalledTimes(1);
  });

  it("rechecks private identity at final manager dispatch after sandbox preparation", async () => {
    const f = await fixture();
    f.sandbox.preflight.mockImplementationOnce(async () => {
      await f.change({ principal: "public-native-owner-B" });
      return { ok: true, sandbox: { enabled: false } };
    });
    expect((await f.start()).status).toBe(400);
    expect(f.effects).toEqual([]);
    expect(f.terminal.createTab).not.toHaveBeenCalled();
    expect(await f.index()).toEqual([]);
  });

  it("preserves a live admission when the same session is started again", async () => {
    const f = await fixture();
    const response = await f.start();
    expect(response.status).toBe(201);
    const { session } = await response.json();
    const [{ binding }] = await f.index();
    await expect(f.runtime.startSession({ ownerScope: { type: "user", id: "owner" },
      request: { sessionId: session.id, kind: "agent", agent: "codex" } })).resolves.toMatchObject({ ok: false });
    expect(await f.index()).toEqual([expect.objectContaining({ binding, sessionId: session.id })]);
    expect(f.terminal.createTab).toHaveBeenCalledTimes(1);
    const release = await f.runtime.admission.prepareRevocation();
    expect(f.terminal.terminateTab).toHaveBeenCalledTimes(1);
    await release();
  });

  it("keeps clean-failure admission cleanup inside the same-session start reservation", async () => {
    const f = await fixture();
    const input = { ownerScope: { type: "user" as const, id: "owner" },
      request: { sessionId: "sess_cleanup_race", kind: "agent" as const, agent: "codex" as const } };
    f.launcher.buildLaunch.mockImplementationOnce(() => { throw new Error("fixture launch rejected"); });
    let entered!: () => void;
    let releaseCleanup!: () => void;
    const cleanupEntered = new Promise<void>(resolve => { entered = resolve; });
    const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
    const cleanup = f.runtime.admission.releaseFailedStart;
    vi.spyOn(f.runtime.admission, "releaseFailedStart").mockImplementationOnce(async (...args) => {
      entered();
      await cleanupGate;
      return cleanup(...args);
    });
    const first = f.runtime.startSession(input);
    await cleanupEntered;
    try {
      await expect(f.runtime.startSession(input)).resolves.toMatchObject({ ok: false,
        error: { code: "runtime_ownership_retained" } });
      expect(f.terminal.createTab).not.toHaveBeenCalled();
    } finally {
      releaseCleanup();
      await first;
    }
    expect(await f.index()).toEqual([]);
    await expect(f.runtime.startSession(input)).resolves.toMatchObject({ ok: true });
    expect(await f.index()).toHaveLength(1);
    const release = await f.runtime.admission.prepareRevocation();
    expect(f.terminal.terminateTab).toHaveBeenCalledTimes(1);
    await release();
  });

  it.each(["missing project", "missing worktree", "sandbox rejection"])("releases a proved pre-runtime %s failure", async reason => {
    const f = await fixture();
    if (reason === "sandbox rejection") f.sandbox.preflight.mockRejectedValueOnce(new Error("fixture sandbox rejected"));
    const result = await f.runtime.startSession({ ownerScope: { type: "user", id: "owner" },
      request: { kind: "agent", agent: "codex",
        ...(reason !== "sandbox rejection" ? { projectSlug: "missing" } : {}),
        ...(reason === "missing worktree" ? { worktreeId: "wt_abc123def456" } : {}),
      } });
    expect(result.ok).toBe(false);
    expect(f.terminal.createTab).not.toHaveBeenCalled();
    expect(await f.index()).toEqual([]);
    const release = await f.runtime.admission.prepareRevocation();
    await release();
    expect((await f.start()).status).toBe(201);
  });

  it("preserves the injected orchestrator receiver when the route uses its default start", async () => {
    const f = await fixture();
    const receiverRuntime = { ...f.sharedRuntime,
      startSession: vi.fn(function (this: unknown, input: Parameters<typeof f.sharedRuntime.startSession>[0]) {
        expect(this).toBe(receiverRuntime);
        return f.sharedRuntime.startSession(input);
      }),
    };
    const app = createWorkspaceRoutes({ homePath: f.homePath, agentSessionManager: f.manager,
      sessionOrchestrator: receiverRuntime, getOwnerScope: () => ({ type: "user", id: "owner" }) });
    const response = await app.request("/api/sessions", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "shell" }) });
    expect(response.status).toBe(201);
    expect(receiverRuntime.startSession).toHaveBeenCalledTimes(1);
    expect(f.terminal.createTab).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the exact runtime needed for native logout is unavailable", async () => {
    const f = await fixture();
    expect((await f.start()).status).toBe(201);
    f.forgetRuntime();
    await expect(f.runtime.admission.prepareRevocation()).rejects.toThrow("unavailable");
    expect(await f.index()).toHaveLength(1);
    expect(f.terminal.terminateTab).not.toHaveBeenCalled();
  });

  it("does not rebind a repeated session after owner or private principal drift", async () => {
    const f = await fixture();
    const response = await f.start();
    expect(response.status).toBe(201);
    const { session } = await response.json();
    const original = await f.index();
    await expect(f.runtime.startSession({ ownerScope: { type: "user", id: "collaborator" },
      request: { sessionId: session.id, kind: "agent", agent: "codex" } })).resolves.toMatchObject({ ok: false });
    await f.change({ principal: "public-native-owner-B" });
    await expect(f.runtime.startSession({ ownerScope: { type: "user", id: "owner" },
      request: { sessionId: session.id, kind: "agent", agent: "codex" } })).resolves.toMatchObject({ ok: false });
    expect(await f.index()).toEqual(original);
    expect(f.terminal.createTab).toHaveBeenCalledTimes(1);
    const release = await f.runtime.admission.prepareRevocation();
    await release();
  });

  it("drains real legacy API-key work without granting native subscription intent", async () => {
    const f = await fixture();
    await f.change({ method: "api_key", missingSettings: true });
    const response = await f.start();
    expect(response.status).toBe(201);
    const { session } = await response.json();
    expect(f.effects[0]?.nativeCodexSubscription).toBeUndefined();
    expect(await f.index()).toEqual([expect.objectContaining({ sessionId: session.id, userId: "owner", binding: null })]);
    const release = await f.runtime.admission.prepareRevocation();
    expect(f.terminal.terminateTab).toHaveBeenCalledExactlyOnceWith(session.terminalRef);
    expect(await f.manager.getSession(session.id)).toMatchObject({ ok: true, session: { runtime: { status: "exited" } } });
    expect(await f.index()).toEqual([]);
    await release();
  });

  it.each(["shell", "pi"])("preserves ordinary public %s starts without native account observation", async agent => {
    const f = await fixture();
    await f.change({ enabled: false });
    native.read.mockClear();
    expect((await f.start(agent)).status).toBe(201);
    expect(native.read).not.toHaveBeenCalled();
    expect(f.terminal.createTab).toHaveBeenCalledTimes(1);
    expect(f.effects.every(effect => effect.nativeCodexSubscription === undefined)).toBe(true);
  });
});
