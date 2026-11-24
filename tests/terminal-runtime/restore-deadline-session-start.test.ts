import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TerminalRuntime,
  type ZellijAttachment,
  type ZellijObserver,
  type ZellijRuntimeAdapter,
} from "../../packages/terminal-runtime/src/runtime.js";
import { createUserSystemdTerminalRuntime } from "../../packages/terminal-runtime/src/user-systemd-controller.js";
import { createUserSystemdWorkspaceLifecycle } from "../../packages/terminal-runtime/src/user-systemd-workspace.js";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";
import { ZellijCliRuntimeAdapter } from "../../packages/terminal-runtime/src/zellij-adapter.js";

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** In-memory Zellij for the healthy workspace; it answers every call at once. */
class HealthyZellij implements ZellijRuntimeAdapter {
  readonly sessions = new Map<string, Map<number, { name: string; paneId: string }>>();
  private nextTabId = 1;

  async ensureSession(sessionName: string): Promise<void> {
    if (!this.sessions.has(sessionName)) this.sessions.set(sessionName, new Map());
  }

  async createTab(sessionName: string, input: { internalName: string }): Promise<{ tabId: number; paneId: string }> {
    const tabs = this.sessions.get(sessionName);
    if (!tabs) throw new Error("missing session");
    const tabId = this.nextTabId++;
    tabs.set(tabId, { name: input.internalName, paneId: `terminal_${tabId}` });
    return { tabId, paneId: `terminal_${tabId}` };
  }

  async findTabsByInternalName(sessionName: string, internalNames: string[]) {
    const found: Record<string, { tabId: number; paneId: string }> = {};
    for (const [tabId, tab] of this.sessions.get(sessionName) ?? []) {
      if (internalNames.includes(tab.name)) found[tab.name] = { tabId, paneId: tab.paneId };
    }
    return found;
  }

  async openAttachment(): Promise<ZellijAttachment> {
    return { write: async () => undefined, resize: async () => undefined, close: async () => undefined };
  }

  async subscribeWorkspace(): Promise<ZellijObserver> {
    return { close: async () => undefined };
  }
}

/** Sends one session to `production`, every other call to `healthy`. */
function routeSession(
  healthy: ZellijRuntimeAdapter,
  production: ZellijRuntimeAdapter,
  productionSession: () => string,
): ZellijRuntimeAdapter {
  return new Proxy(healthy, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const owner = args[0] === productionSession() ? production : target;
        const method = Reflect.get(owner, property) as (...input: unknown[]) => unknown;
        return method.apply(owner, args);
      };
    },
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

describe("production startup restore", () => {
  it("skips a hung Zellij inventory in time for a healthy workspace to attach", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-restore-startup-"));
    dirs.push(homePath);
    const healthy = new HealthyZellij();
    const store = new TerminalWorkspaceStore({ homePath });
    const seed = new TerminalRuntime({ store, zellij: healthy });
    const bad = await seed.ensureWorkspace();
    const good = await seed.ensureWorkspace({ projectId: "good" });
    const badTab = await seed.createTab(bad.id, { name: "bad", cwd: "" });
    const goodTab = await seed.createTab(good.id, { name: "good", cwd: "projects/good" });
    await seed.shutdown();

    const badSession = (await store.getRuntimeWorkspace(bad.id))!.zellijSessionName;
    const binaryPath = join(homePath, "zellij");
    const inventoryStarted = join(homePath, "inventory-started");
    await writeFile(binaryPath, [
      "#!/bin/sh",
      'if [ "$1" = "list-sessions" ]; then printf "%s\\n" "$TEST_ZELLIJ_SESSION"; exit 0; fi',
      'if [ "$4" = "list-tabs" ]; then : > "$TEST_INVENTORY_STARTED"; exec /bin/sleep 3; fi',
      "exit 1",
      "",
    ].join("\n"), { mode: 0o700 });
    const production = new ZellijCliRuntimeAdapter({
      homePath, binaryPath, timeoutMs: 800,
      env: { TEST_ZELLIJ_SESSION: badSession, TEST_INVENTORY_STARTED: inventoryStarted },
    });
    await production.ensureSession(badSession);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runtime = new TerminalRuntime({
      store,
      zellij: routeSession(healthy, production, () => badSession),
      restoreRetryBudgetMs: 600,
    });
    try {
      const startedAt = Date.now();
      await runtime.restoreAll();
      expect(await exists(inventoryStarted)).toBe(true);
      const viewer = await runtime.attach({ workspaceId: good.id, tabId: goodTab.id }, {
        viewerId: "desktop",
        send: () => undefined,
      });
      await viewer.detach();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(await store.getTab({ workspaceId: bad.id, tabId: badTab.id })).toMatchObject({ status: "running" });
    } finally {
      await runtime.shutdown();
    }
  }, 15_000);

  it.each(["terminal-runtimes", "zellij/runtime-layouts"])(
    "fails startup when shared runtime storage at %s is unusable",
    async (unusableRoot) => {
      const homePath = await mkdtemp(join(tmpdir(), "matrix-restore-storage-"));
      dirs.push(homePath);
      const store = new TerminalWorkspaceStore({ homePath });
      await store.ensureWorkspace();
      await mkdir(join(homePath, "system", "zellij"), { recursive: true });
      await writeFile(join(homePath, "system", unusableRoot), "");
      const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));
      const controller = createUserSystemdTerminalRuntime({
        homePath,
        generation: `gen_${"a".repeat(64)}`,
        runCommand,
      });
      const zellij = new ZellijCliRuntimeAdapter({
        homePath,
        workspaceLifecycle: createUserSystemdWorkspaceLifecycle({ homePath, controller }),
      });
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const runtime = new TerminalRuntime({ store, zellij });
      try {
        await expect(runtime.restoreAll()).rejects.toThrow(/runtime storage unavailable/i);
        expect(runCommand).not.toHaveBeenCalled();
      } finally {
        await runtime.shutdown();
      }
    },
  );
});

describe("background restore deadline on the production session-start path", () => {
  it("ends a hung session start within the budget so a healthy attach is not held", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-restore-deadline-home-"));
    const fakeRoot = await mkdtemp(join(tmpdir(), "matrix-restore-deadline-bin-"));
    dirs.push(homePath, fakeRoot);
    const binDir = join(fakeRoot, "bin");
    await mkdir(binDir);
    const hangFlag = join(fakeRoot, "hang");
    const hangStarted = join(fakeRoot, "hang-started");
    // A user manager that refuses to start the unit at first, then stops
    // answering `systemctl --user start` entirely.
    await writeFile(join(binDir, "systemctl"), [
      "#!/bin/sh",
      'if [ "$2" = "start" ]; then',
      `  if [ -f '${hangFlag}' ]; then : > '${hangStarted}'; exec sleep 60; fi`,
      "  exit 1",
      "fi",
      "exit 0",
      "",
    ].join("\n"));
    await chmod(join(binDir, "systemctl"), 0o755);

    const healthy = new HealthyZellij();
    const seed = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij: healthy });
    const good = await seed.ensureWorkspace({ projectId: "good" });
    const bad = await seed.ensureWorkspace({ projectId: "bad" });
    const goodTab = await seed.createTab(good.id, { name: "good", cwd: "projects/good" });
    await seed.createTab(bad.id, { name: "bad", cwd: "projects/bad" });
    await seed.shutdown();

    const store = new TerminalWorkspaceStore({ homePath });
    const badSession = (await store.getRuntimeWorkspace(bad.id))!.zellijSessionName;
    const terminalRuntimeRoot = join(fakeRoot, "terminal-runtime");
    const env = { PATH: `${binDir}:/usr/bin:/bin`, HOME: homePath };
    const controller = createUserSystemdTerminalRuntime({
      homePath,
      uid: process.getuid?.() ?? 1000,
      env,
      generation: `gen_${"a".repeat(64)}`,
      terminalRuntimeRoot,
      capacityAdmission: async () => undefined,
    });
    const production = new ZellijCliRuntimeAdapter({
      homePath,
      env,
      binaryPath: join(terminalRuntimeRoot, "missing-zellij"),
      workspaceLifecycle: createUserSystemdWorkspaceLifecycle({ homePath, controller, terminalRuntimeRoot }),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const budgetMs = 1_500;
    const runtime = new TerminalRuntime({
      store,
      zellij: routeSession(healthy, production, () => badSession),
      sweepIntervalMs: 50,
      restoreRetryBaseMs: 1,
      restoreRetryBudgetMs: budgetMs,
    });
    try {
      // The failed unit start is session-scoped: startup skips it.
      await expect(runtime.restoreAll()).resolves.toBeUndefined();

      await writeFile(hangFlag, "");
      await vi.waitFor(async () => expect(await exists(hangStarted)).toBe(true), { timeout: 10_000, interval: 25 });

      const startedAt = Date.now();
      const viewer = await runtime.attach({ workspaceId: good.id, tabId: goodTab.id }, {
        viewerId: "desktop",
        send: () => undefined,
      });
      const elapsedMs = Date.now() - startedAt;
      await viewer.detach();

      // Without the deadline the hung `systemctl start` holds the workspace
      // queue for its own 10 s command timeout.
      expect(elapsedMs).toBeLessThanOrEqual(budgetMs + 1_000);
    } finally {
      await rm(hangFlag, { force: true });
      await runtime.shutdown();
    }
  }, 30_000);
});

describe("background restore deadline on native host inspection", () => {
  it("does not mark a native tab exited when its supervisor query runs past the deadline", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-restore-deadline-native-"));
    dirs.push(homePath);
    const nativeHost = {
      path: `/run/user/501/matrix-terminal-${"a".repeat(32)}/io.sock`,
      generation: `gen_${"b".repeat(64)}`,
    };
    const hosts = {
      inspect: vi.fn(async (_reference: unknown, _options?: { deadline?: number }) => ({ status: "running" as const })),
      stop: vi.fn(async () => ({ status: "stopped" as const })),
      attachCommand: vi.fn(async () => ["/pinned/node", "/pinned/terminal-io-attach.mjs", nativeHost.path]),
    };
    const healthy = new HealthyZellij();
    const seed = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij: healthy, nativeHosts: hosts });
    const good = await seed.ensureWorkspace({ projectId: "good" });
    const bad = await seed.ensureWorkspace({ projectId: "bad" });
    const goodTab = await seed.createTab(good.id, { name: "good", cwd: "projects/good" });
    const nativeTab = await seed.createTab(bad.id, { name: "Hermes", cwd: "", nativeHost } as never);
    await seed.shutdown();

    const store = new TerminalWorkspaceStore({ homePath });
    const badSession = (await store.getRuntimeWorkspace(bad.id))!.zellijSessionName;
    let sessionDown = true;
    const ensureSession = healthy.ensureSession.bind(healthy);
    healthy.ensureSession = async (sessionName: string) => {
      if (sessionName === badSession && sessionDown) throw new Error("Terminal workspace failed to start");
      return ensureSession(sessionName);
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const budgetMs = 1_000;
    const runtime = new TerminalRuntime({
      store,
      zellij: healthy,
      nativeHosts: hosts,
      sweepIntervalMs: 50,
      restoreRetryBaseMs: 1,
      restoreRetryBudgetMs: budgetMs,
    });
    try {
      await expect(runtime.restoreAll()).resolves.toBeUndefined();

      // The supervisor stops answering. Like the real lifecycle, the query is
      // killed at the caller's deadline and reported as "unknown".
      let inspectEnded = false;
      hosts.inspect.mockImplementation(async (_reference, options) => {
        const waitMs = options?.deadline === undefined ? 300_000 : Math.max(0, options.deadline - Date.now());
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
        inspectEnded = true;
        return { status: "unknown" as const };
      });
      sessionDown = false;
      await vi.waitFor(() => expect(hosts.inspect).toHaveBeenCalled(), { timeout: 10_000, interval: 25 });

      const startedAt = Date.now();
      const viewer = await runtime.attach({ workspaceId: good.id, tabId: goodTab.id }, {
        viewerId: "desktop",
        send: () => undefined,
      });
      const elapsedMs = Date.now() - startedAt;
      await viewer.detach();

      expect(elapsedMs).toBeLessThanOrEqual(budgetMs + 1_000);
      expect(inspectEnded).toBe(true);
      expect(await store.getTab({ workspaceId: bad.id, tabId: nativeTab.id }))
        .not.toMatchObject({ status: "exited" });
    } finally {
      await runtime.shutdown();
    }
  }, 30_000);
});
