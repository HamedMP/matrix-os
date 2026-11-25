import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZellijOutputError } from "../../packages/terminal-runtime/src/errors.js";
import {
  TerminalRuntime,
  type ZellijAttachment,
  type ZellijObserver,
  type ZellijRuntimeAdapter,
} from "../../packages/terminal-runtime/src/runtime.js";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";
import { ZellijCliRuntimeAdapter } from "../../packages/terminal-runtime/src/zellij-adapter.js";

// Exact shape printed by a stale older-generation Zellij server for
// `--session <name> action list-tabs --json` (production incident).
const STALE_GENERATION_OUTPUT = "Session 'matrix-rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' not found. "
  + "The following sessions are active: \x1b[32;1mmatrix-rt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\x1b[m "
  + "[Created 3h 12m 4s ago]\n";

const homes: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  const settled = promise.then(() => undefined, (error: unknown) => error);
  await vi.runAllTimersAsync();
  return settled;
}

describe("unreadable Zellij structured output", () => {
  it("raises a typed, ANSI-free, bounded error instead of a raw SyntaxError", async () => {
    vi.useFakeTimers();
    const adapter = new ZellijCliRuntimeAdapter({
      homePath: "/home/matrix",
      run: vi.fn(async () => STALE_GENERATION_OUTPUT),
    });

    const error = await rejectionOf(adapter.findTabsByInternalName(
      "matrix-w-0123456789abcdef0123456789abcdef",
      ["matrix-tab-0123456789abcdef0123456789abcdef"],
    ));

    expect(error).toBeInstanceOf(ZellijOutputError);
    expect(error).not.toBeInstanceOf(SyntaxError);
    const typed = error as ZellijOutputError;
    expect(typed.reason).toBe("non_json");
    expect(typed.code).toBe("unavailable");
    expect(typed.snippet).not.toMatch(/\x1b/);
    expect(typed.snippet).toContain("not found");
    expect(typed.snippet.length).toBeLessThanOrEqual(160);
    // The raw output must not leak through the client-facing message.
    expect(typed.message).not.toContain("matrix-rt_");
  });

  it("reports schema-invalid JSON as a typed error", async () => {
    vi.useFakeTimers();
    const adapter = new ZellijCliRuntimeAdapter({
      homePath: "/home/matrix",
      run: vi.fn(async () => JSON.stringify([{ unexpected: true }])),
    });

    const error = await rejectionOf(adapter.findTabsByInternalName(
      "matrix-w-0123456789abcdef0123456789abcdef",
      ["matrix-tab-0123456789abcdef0123456789abcdef"],
    ));

    expect(error).toBeInstanceOf(ZellijOutputError);
    expect((error as ZellijOutputError).reason).toBe("schema_invalid");
  });

  it("stops retrying a structured read once the caller's deadline passes", async () => {
    vi.useFakeTimers();
    const run = vi.fn(() => new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error("zellij command timed out")), 3_000);
    }));
    const adapter = new ZellijCliRuntimeAdapter({ homePath: "/home/matrix", run });
    const startedAt = Date.now();

    const error = await rejectionOf(adapter.findTabsByInternalName(
      "matrix-w-0123456789abcdef0123456789abcdef",
      ["matrix-tab-0123456789abcdef0123456789abcdef"],
      { deadline: startedAt + 5_000 },
    ));

    expect(error).toBeInstanceOf(Error);
    // Without the deadline the read makes ten 3 s attempts (over 30 s).
    expect(Date.now() - startedAt).toBeLessThanOrEqual(6_500);
    expect(run.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("bounds the log snippet and redacts long token-like runs", () => {
    const error = ZellijOutputError.fromOutput(
      "non_json",
      `\x1b]0;title\x07token=${"A".repeat(80)} ${"x ".repeat(400)}`,
    );
    expect(error.snippet).not.toContain("A".repeat(48));
    expect(error.snippet).toContain("[redacted]");
    expect(error.snippet).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(error.snippet.length).toBeLessThanOrEqual(160);
  });
});

class RestoreZellij implements ZellijRuntimeAdapter {
  readonly sessions = new Map<string, Map<number, { name: string; paneId: string }>>();
  readonly unreadableSessions = new Set<string>();
  readonly subscribed = new Set<string>();
  private nextTabId = 1;
  private readonly cli = new ZellijCliRuntimeAdapter({
    homePath: "/home/matrix",
    run: async (args) => {
      const sessionName = args[args.indexOf("--session") + 1] ?? "";
      if (this.unreadableSessions.has(sessionName)) return STALE_GENERATION_OUTPUT;
      const tabs = [...(this.sessions.get(sessionName)?.entries() ?? [])];
      if (args.includes("list-tabs")) {
        return JSON.stringify(tabs.map(([tabId, tab]) => ({ tab_id: tabId, name: tab.name })));
      }
      if (args.includes("list-panes")) {
        return JSON.stringify(tabs.map(([tabId, tab]) => ({
          id: Number(tab.paneId.slice("terminal_".length)),
          is_plugin: false,
          tab_id: tabId,
          pane_title: tab.name,
        })));
      }
      return "";
    },
  });

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

  findTabsByInternalName(sessionName: string, internalNames: string[], options?: { deadline?: number }) {
    // Real CLI parsing path, so the production output reaches the runtime unchanged.
    return this.cli.findTabsByInternalName(sessionName, internalNames, options);
  }

  async openAttachment(): Promise<ZellijAttachment> {
    return { write: async () => undefined, resize: async () => undefined, close: async () => undefined };
  }

  async subscribeWorkspace(sessionName: string): Promise<ZellijObserver> {
    this.subscribed.add(sessionName);
    return { close: async () => { this.subscribed.delete(sessionName); } };
  }
}

describe("runtime startup with one unreadable Zellij session", () => {
  it("restores healthy workspaces, logs the bad one, and retries it later", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-unreadable-"));
    homes.push(homePath);
    const zellij = new RestoreZellij();
    const first = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij });
    const good = await first.ensureWorkspace({ projectId: "good" });
    const bad = await first.ensureWorkspace({ projectId: "bad" });
    const goodTab = await first.createTab(good.id, { name: "good", cwd: "projects/good" });
    const badTab = await first.createTab(bad.id, { name: "bad", cwd: "projects/bad" });
    await first.shutdown();
    zellij.subscribed.clear();

    const store = new TerminalWorkspaceStore({ homePath });
    const goodSession = (await store.getRuntimeWorkspace(good.id))!.zellijSessionName;
    const badSession = (await store.getRuntimeWorkspace(bad.id))!.zellijSessionName;
    zellij.unreadableSessions.add(badSession);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const runtime = new TerminalRuntime({
      store,
      zellij,
      sweepIntervalMs: 25,
      restoreRetryBaseMs: 1,
    });
    await expect(runtime.restoreAll()).resolves.toBeUndefined();

    expect(zellij.subscribed.has(goodSession)).toBe(true);
    expect(zellij.subscribed.has(badSession)).toBe(false);
    const restoreLog = errors.mock.calls.find(([message]) => message === "[terminal-runtime] workspace restore failed");
    expect(restoreLog?.[1]).toMatchObject({
      workspaceId: bad.id,
      error: "ZellijOutputError",
      code: "unavailable",
      reason: "non_json",
    });
    expect(JSON.stringify(restoreLog)).not.toMatch(/\x1b/);
    // A read failure is not evidence the program ended: the tab stays recoverable.
    expect(await store.getTab({ workspaceId: bad.id, tabId: badTab.id }))
      .not.toMatchObject({ status: "exited" });
    expect(await store.getTab({ workspaceId: good.id, tabId: goodTab.id }))
      .toMatchObject({ status: "running" });

    zellij.unreadableSessions.delete(badSession);
    await vi.waitFor(() => expect(zellij.subscribed.has(badSession)).toBe(true), { timeout: 15_000, interval: 25 });
    expect(await store.getTab({ workspaceId: bad.id, tabId: badTab.id }))
      .toMatchObject({ status: "running" });
    await runtime.shutdown();
  }, 30_000);
});

async function seedTwoWorkspaces(zellij: ZellijRuntimeAdapter) {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-unreadable-"));
  homes.push(homePath);
  const first = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij });
  const good = await first.ensureWorkspace({ projectId: "good" });
  const bad = await first.ensureWorkspace({ projectId: "bad" });
  const goodTab = await first.createTab(good.id, { name: "good", cwd: "projects/good" });
  const badTab = await first.createTab(bad.id, { name: "bad", cwd: "projects/bad" });
  await first.shutdown();
  const probe = new TerminalWorkspaceStore({ homePath });
  return {
    homePath,
    good,
    bad,
    goodTab,
    badTab,
    goodSession: (await probe.getRuntimeWorkspace(good.id))!.zellijSessionName,
    badSession: (await probe.getRuntimeWorkspace(bad.id))!.zellijSessionName,
  };
}

describe("startup restore failure classification", () => {
  it("keeps a store write failure during restore fatal so the service does not look healthy", async () => {
    const zellij = new RestoreZellij();
    const seeded = await seedTwoWorkspaces(zellij);
    zellij.subscribed.clear();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    class FullDiskStore extends TerminalWorkspaceStore {
      override async activateTab(...args: Parameters<TerminalWorkspaceStore["activateTab"]>) {
        void args;
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
    }
    const runtime = new TerminalRuntime({ store: new FullDiskStore({ homePath: seeded.homePath }), zellij });

    await expect(runtime.restoreAll()).rejects.toMatchObject({ code: "ENOSPC" });
    await runtime.shutdown();
  });

  it("skips a session-scoped Zellij failure for one workspace and restores the rest", async () => {
    const zellij = new RestoreZellij();
    const seeded = await seedTwoWorkspaces(zellij);
    zellij.subscribed.clear();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ensureSession = zellij.ensureSession.bind(zellij);
    zellij.ensureSession = async (sessionName: string) => {
      if (sessionName === seeded.badSession) throw new Error("Terminal workspace failed to start");
      return ensureSession(sessionName);
    };
    const runtime = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath: seeded.homePath }), zellij });

    await expect(runtime.restoreAll()).resolves.toBeUndefined();
    expect(zellij.subscribed.has(seeded.goodSession)).toBe(true);
    expect(zellij.subscribed.has(seeded.badSession)).toBe(false);
    await runtime.shutdown();
  });
});

describe("background restore retries", () => {
  it("bounds a hung workspace retry so an attach on a healthy workspace is not blocked past the budget", async () => {
    const zellij = new RestoreZellij();
    const seeded = await seedTwoWorkspaces(zellij);
    zellij.subscribed.clear();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    zellij.unreadableSessions.add(seeded.badSession);

    // Store I/O is real, so each fake-time step also yields a real
    // millisecond for the file system to settle.
    const realSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const pump = async (until: () => boolean, maxMs: number) => {
      const start = Date.now();
      while (!until() && Date.now() - start < maxMs) {
        await vi.advanceTimersByTimeAsync(50);
        await new Promise<void>((resolve) => realSetTimeout(resolve, 1));
      }
    };
    const runtime = new TerminalRuntime({
      store: new TerminalWorkspaceStore({ homePath: seeded.homePath }),
      zellij,
      sweepIntervalMs: 1_000,
      restoreRetryBaseMs: 1,
      restoreRetryBudgetMs: 5_000,
    });
    let restored = false;
    void runtime.restoreAll().then(() => { restored = true; });
    await pump(() => restored, 10_000);
    expect(restored).toBe(true);
    expect(zellij.subscribed.has(seeded.badSession)).toBe(false);

    // The stale session now stops answering: each structured read waits for
    // its command timeout (30 s, ten attempts) unless the caller's deadline
    // cuts it short, the way the real runner kills the child at timeoutMs.
    zellij.unreadableSessions.delete(seeded.badSession);
    let hungStarted = false;
    const findTabs = zellij.findTabsByInternalName.bind(zellij);
    zellij.findTabsByInternalName = async (sessionName, internalNames, options) => {
      if (sessionName !== seeded.badSession) return findTabs(sessionName, internalNames, options);
      hungStarted = true;
      const waitMs = options?.deadline === undefined ? 300_000 : Math.max(0, options.deadline - Date.now());
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      throw new Error("Terminal runtime operation timed out");
    };

    await pump(() => hungStarted, 10_000);
    expect(hungStarted).toBe(true);

    const startedAt = Date.now();
    let attached = false;
    const attach = runtime.attach({ workspaceId: seeded.good.id, tabId: seeded.goodTab.id }, {
      viewerId: "desktop",
      send: () => undefined,
    }).then((viewer) => { attached = true; return viewer; });
    await pump(() => attached, 400_000);

    expect(attached).toBe(true);
    expect(Date.now() - startedAt).toBeLessThanOrEqual(5_000 + 1_000);
    await (await attach).detach();
    vi.useRealTimers();
    await runtime.shutdown();
  }, 30_000);
});
