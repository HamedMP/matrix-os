import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inferAgentFromCommand, ShellRegistry } from "../../packages/gateway/src/shell/registry.js";
import { AgentSessionStateStore } from "../../packages/gateway/src/shell/agent-session-state.js";

const roots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "matrix-shell-registry-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("shell registry", () => {
  it("decorates listed sessions concurrently", async () => {
    const root = await tempRoot();
    const live = new Set<string>();
    const adapter = {
      listSessions: vi.fn(async () => Array.from(live)),
      createSession: vi.fn(async ({ name }: { name: string }) => { live.add(name); }),
      deleteSession: vi.fn(async () => undefined),
    };
    const gitContextResolver = {
      resolve: vi.fn(async () => null),
    };
    const registry = new ShellRegistry({ homePath: root, adapter, gitContextResolver });
    await registry.create({ name: "calm-otter" });
    await registry.create({ name: "brisk-falcon" });

    let releaseDecorations = () => {};
    const decorationGate = new Promise<void>((resolve) => {
      releaseDecorations = resolve;
    });
    gitContextResolver.resolve.mockClear();
    gitContextResolver.resolve.mockImplementation(async () => {
      await decorationGate;
      return null;
    });

    const listPromise = registry.list();
    let startedConcurrently = false;
    try {
      await vi.waitFor(() => expect(gitContextResolver.resolve).toHaveBeenCalledTimes(2), { timeout: 1_000 });
      startedConcurrently = true;
    } catch {
      // Release the shared gate so a sequential implementation can settle before the assertion.
    } finally {
      releaseDecorations();
    }
    await listPromise;

    expect(startedConcurrently).toBe(true);
  });

  it("bounds concurrent session decoration while preserving response order", async () => {
    const root = await tempRoot();
    const sessionNames = Array.from({ length: 12 }, (_, index) => `session-${String(index).padStart(2, "0")}`);
    let activeLookups = 0;
    let peakLookups = 0;
    let releaseLookups = () => {};
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookups = resolve;
    });
    const adapter = {
      listSessions: vi.fn(async () => sessionNames),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
      focusedPaneRuntime: vi.fn(async () => {
        activeLookups += 1;
        peakLookups = Math.max(peakLookups, activeLookups);
        await lookupGate;
        activeLookups -= 1;
        return { cwd: null, command: null, observed: true };
      }),
    };
    const registry = new ShellRegistry({
      homePath: root,
      adapter,
      gitContextResolver: { resolve: vi.fn(async () => null) },
    });

    const listPromise = registry.list();
    await vi.waitFor(() => expect(adapter.focusedPaneRuntime).toHaveBeenCalledTimes(8));
    expect(peakLookups).toBe(8);
    releaseLookups();

    const sessions = await listPromise;
    expect(sessions.map((session) => session.name)).toEqual(sessionNames);
    expect(adapter.focusedPaneRuntime).toHaveBeenCalledTimes(sessionNames.length);
  });

  it("adds gateway-owned project and Git context while preserving the session cwd", async () => {
    const root = await tempRoot();
    const cwd = join(root, "projects", "matrix-os");
    await mkdir(cwd, { recursive: true });
    const live = new Set<string>();
    const adapter = {
      listSessions: vi.fn(async () => Array.from(live)),
      createSession: vi.fn(async ({ name }: { name: string }) => { live.add(name); }),
      deleteSession: vi.fn(async () => undefined),
      focusedPaneRuntime: vi.fn(async () => ({ cwd, command: "zsh", observed: true })),
    };
    const gitContextResolver = {
      resolve: vi.fn(async () => ({
        project: "Matrix OS",
        repository: "HamedMP/matrix-os",
        branch: "codex/session-context",
        pullRequest: { number: 1032, url: "https://github.com/HamedMP/matrix-os/pull/1032" },
      })),
    };
    const registry = new ShellRegistry({ homePath: root, adapter, gitContextResolver });

    await registry.create({ name: "calm-otter", cwd });
    const resolvedCwd = await realpath(cwd);
    const listed = await registry.list();
    expect(listed).toMatchObject([{
      name: "calm-otter",
      project: "Matrix OS",
      repository: "HamedMP/matrix-os",
      branch: "codex/session-context",
      pullRequest: { number: 1032, url: "https://github.com/HamedMP/matrix-os/pull/1032" },
    }]);
    expect(listed[0]).not.toHaveProperty("cwd");
    const persisted = JSON.parse(await readFile(join(root, "system", "shell-sessions.json"), "utf8"));
    expect(persisted.sessions["calm-otter"].cwd).toBe(resolvedCwd);
    expect(gitContextResolver.resolve).toHaveBeenCalledWith({ sessionName: "calm-otter", cwd: resolvedCwd });
  });

  it("persists an explicitly launched agent and omits agent metadata from plain terminals", async () => {
    const root = await tempRoot();
    const live = new Set<string>();
    const adapter = {
      listSessions: vi.fn(async () => Array.from(live)),
      createSession: vi.fn(async ({ name }: { name: string }) => { live.add(name); }),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await registry.create({ name: "calm-otter", cmd: "codex", agent: "codex" });
    await registry.create({ name: "plain-shell" });

    const sessions = await registry.list();
    expect(sessions.find((session) => session.name === "calm-otter")).toMatchObject({
      agent: "codex",
    });
    expect(sessions.find((session) => session.name === "plain-shell")).not.toHaveProperty("agent");
    expect(sessions.find((session) => session.name === "plain-shell")).not.toHaveProperty("subtitle");
    expect(sessions.find((session) => session.name === "plain-shell")).not.toHaveProperty("lastAction");
    expect(sessions.find((session) => session.name === "plain-shell")).not.toHaveProperty("agentUpdatedAt");
    expect(sessions.find((session) => session.name === "plain-shell")).not.toHaveProperty("model");
    expect(sessions.find((session) => session.name === "plain-shell")).not.toHaveProperty("strength");
  });

  it.each([
    ["claude --resume", "claude"],
    ["env FOO=bar codex --full-auto", "codex"],
    ["/usr/bin/env --ignore-environment FOO=bar codex --full-auto", "codex"],
    ["opencode .", "opencode"],
    ["pi", "pi"],
  ] as const)("infers %s as a recognized agent launch", async (cmd, expectedAgent) => {
    const root = await tempRoot();
    const live = new Set<string>();
    const adapter = {
      listSessions: vi.fn(async () => Array.from(live)),
      createSession: vi.fn(async ({ name }: { name: string }) => { live.add(name); }),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.create({ name: "calm-otter", cmd })).resolves.toMatchObject({
      agent: expectedAgent,
    });
  });

  it("does not skip arbitrary leading command flags when inferring an agent", () => {
    expect(inferAgentFromCommand("--unsafe codex")).toBeUndefined();
  });

  it("uses agent lifecycle evidence before a long-running outer CLI process", async () => {
    const root = await tempRoot();
    const agentStateStore = new AgentSessionStateStore({ homePath: root });
    await agentStateStore.apply({
      sessionName: "calm-otter",
      agent: "codex",
      type: "turn-completed",
      occurredAt: "2026-07-18T10:00:02.000Z",
      subtitle: "Implemented agent-aware terminal sessions.",
      action: "Edited registry.ts",
      model: "gpt-5.4",
      strength: "high",
    });
    const adapter = {
      listSessions: vi.fn(async () => ["calm-otter"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const scrollbackStore = {
      latestSeq: vi.fn(async () => 9),
      latestActivity: vi.fn(async () => ({
        latestSeq: 9,
        latestOutputAt: "2026-07-18T10:00:03.000Z",
        commandRunning: true,
        latestCommandMark: { code: "B", kind: "command-start" },
      })),
      cleanup: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({
      homePath: root,
      adapter,
      agentStateStore,
      scrollbackStore: scrollbackStore as never,
    });

    await expect(registry.list()).resolves.toMatchObject([{
      name: "calm-otter",
      agent: "codex",
      subtitle: "Implemented agent-aware terminal sessions.",
      lastAction: "Edited registry.ts",
      agentUpdatedAt: "2026-07-18T10:00:02.000Z",
      model: "gpt-5.4",
      strength: "high",
      visualStatus: "idle",
    }]);
  });

  it("falls back to shell activity when the agent bridge store is unavailable", async () => {
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => ["calm-otter"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const scrollbackStore = {
      latestSeq: vi.fn(async () => 2),
      latestActivity: vi.fn(async () => ({
        latestSeq: 2,
        latestOutputAt: new Date().toISOString(),
        commandRunning: true,
        latestCommandMark: { code: "B", kind: "command-start" },
      })),
      cleanup: vi.fn(async () => undefined),
    };
    const agentStateStore = {
      get: vi.fn(async () => { throw new Error("bridge snapshot unavailable"); }),
      rename: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({
      homePath: root,
      adapter,
      scrollbackStore: scrollbackStore as never,
      agentStateStore,
    });

    await expect(registry.list()).resolves.toMatchObject([{
      name: "calm-otter",
      visualStatus: "running",
    }]);
  });

  it("detects a manually launched Claude process in a plain terminal", async () => {
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => ["main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
      focusedPaneRuntime: vi.fn(async () => ({ cwd: root, command: "claude", observed: true })),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.list()).resolves.toMatchObject([{
      name: "main",
      agent: "claude",
      visualStatus: "running",
    }]);
  });

  it("follows Terminal to Claude to Terminal to Codex to Terminal without stale enrichment", async () => {
    const root = await tempRoot();
    const agentStateStore = new AgentSessionStateStore({ homePath: root });
    await agentStateStore.apply({
      sessionName: "main",
      agent: "claude",
      type: "turn-started",
      occurredAt: "2026-07-18T10:00:00.000Z",
      subtitle: "Claude task",
      action: "Edited registry.ts",
      model: "claude-opus-4-6",
      strength: "high",
    });
    let command = "zsh";
    const adapter = {
      listSessions: vi.fn(async () => ["main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
      focusedPaneRuntime: vi.fn(async () => ({ cwd: root, command, observed: true })),
    };
    const registry = new ShellRegistry({ homePath: root, adapter, agentStateStore });

    const expectPlainTerminal = async () => {
      const [session] = await registry.list();
      expect(session).not.toHaveProperty("agent");
      expect(session).not.toHaveProperty("subtitle");
      expect(session).not.toHaveProperty("lastAction");
      expect(session).not.toHaveProperty("agentUpdatedAt");
      expect(session).not.toHaveProperty("model");
      expect(session).not.toHaveProperty("strength");
    };

    await expectPlainTerminal();
    command = "claude";
    await expect(registry.list()).resolves.toMatchObject([{
      agent: "claude",
      subtitle: "Claude task",
      model: "claude-opus-4-6",
      strength: "high",
    }]);
    command = "zsh";
    await expectPlainTerminal();
    command = "/opt/matrix/bin/codex";
    const [codex] = await registry.list();
    expect(codex).toMatchObject({ agent: "codex", visualStatus: "running" });
    expect(codex).not.toHaveProperty("subtitle");
    expect(codex).not.toHaveProperty("lastAction");
    expect(codex).not.toHaveProperty("agentUpdatedAt");
    expect(codex).not.toHaveProperty("model");
    expect(codex).not.toHaveProperty("strength");
    command = "bash";
    await expectPlainTerminal();
  });

  it("lets a successful runtime observation override stale persisted and hook providers", async () => {
    const root = await tempRoot();
    const agentStateStore = new AgentSessionStateStore({ homePath: root });
    await agentStateStore.apply({
      sessionName: "main",
      agent: "claude",
      type: "attention-requested",
      occurredAt: "2026-07-18T10:00:00.000Z",
      subtitle: "Stale Claude task",
      action: "Requested approval",
      model: "claude-opus-4-6",
      strength: "high",
    });
    const live = new Set<string>();
    const adapter = {
      listSessions: vi.fn(async () => Array.from(live)),
      createSession: vi.fn(async ({ name }: { name: string }) => { live.add(name); }),
      deleteSession: vi.fn(async () => undefined),
      focusedPaneRuntime: vi.fn(async () => ({ cwd: root, command: "opencode", observed: true })),
    };
    const registry = new ShellRegistry({ homePath: root, adapter, agentStateStore });
    await registry.create({ name: "main", cmd: "codex", agent: "codex" });

    const [session] = await registry.list();
    expect(session).toMatchObject({ agent: "opencode", visualStatus: "running" });
    expect(session).not.toHaveProperty("subtitle");
    expect(session).not.toHaveProperty("lastAction");
    expect(session).not.toHaveProperty("agentUpdatedAt");
    expect(session).not.toHaveProperty("model");
    expect(session).not.toHaveProperty("strength");
  });

  it("uses non-ended hooks and then a 12-second launch hint when pane inspection is unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T10:00:00.000Z"));
    const root = await tempRoot();
    const live = new Set<string>();
    const adapter = {
      listSessions: vi.fn(async () => Array.from(live)),
      createSession: vi.fn(async ({ name }: { name: string }) => { live.add(name); }),
      deleteSession: vi.fn(async () => undefined),
      focusedPaneRuntime: vi.fn(async () => { throw new Error("pane inspection failed"); }),
    };
    const agentStateStore = new AgentSessionStateStore({ homePath: root });
    await agentStateStore.apply({
      sessionName: "hooked",
      agent: "claude",
      type: "turn-started",
      occurredAt: "2026-07-18T10:00:00.000Z",
      subtitle: "Hook fallback",
    });
    const registry = new ShellRegistry({ homePath: root, adapter, agentStateStore });
    await registry.create({ name: "hooked" });
    await registry.create({ name: "launch-hint", cmd: "codex", agent: "codex" });

    await expect(registry.get("hooked")).resolves.toMatchObject({
      agent: "claude",
      subtitle: "Hook fallback",
      visualStatus: "running",
    });
    await expect(registry.get("launch-hint")).resolves.toMatchObject({ agent: "codex", visualStatus: "running" });

    vi.setSystemTime(new Date("2026-07-18T10:00:12.001Z"));
    const expired = await registry.get("launch-hint");
    expect(expired).not.toHaveProperty("agent");
  });

  it("keeps session rename available when agent metadata rename fails", async () => {
    const root = await tempRoot();
    const live = new Set(["calm-otter"]);
    const adapter = {
      listSessions: vi.fn(async () => Array.from(live)),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
      renameSession: vi.fn(async (name: string, nextName: string) => {
        live.delete(name);
        live.add(nextName);
      }),
    };
    const agentStateStore = {
      get: vi.fn(async () => null),
      rename: vi.fn(async () => { throw new Error("metadata unavailable"); }),
      delete: vi.fn(async () => undefined),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const registry = new ShellRegistry({ homePath: root, adapter, agentStateStore });
    await registry.list();

    await expect(registry.rename("calm-otter", "swift-falcon")).resolves.toMatchObject({
      name: "swift-falcon",
    });
    expect(Array.from(live)).toEqual(["swift-falcon"]);
    expect(warn).toHaveBeenCalledWith(
      "[shell] failed to rename agent session state:",
      "metadata unavailable",
    );
  });

  it("ignores legacy browser visualStatus writes", async () => {
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => ["calm-otter"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });
    await registry.list();

    await registry.updateUiState("calm-otter", { visualStatus: "waiting" });

    const raw = JSON.parse(await readFile(join(root, "system", "shell-sessions.json"), "utf8"));
    expect(raw.sessions["calm-otter"]).not.toHaveProperty("visualStatus");
    await expect(registry.get("calm-otter")).resolves.toMatchObject({ visualStatus: "idle" });
  });
  it("lists main first, then active sessions by creation time when no custom order exists", async () => {
    const root = await tempRoot();
    const persistPath = join(root, "system", "shell-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      persistPath,
      JSON.stringify({
        sessions: {
          bench: { name: "bench", status: "active", createdAt: "2026-06-15T12:00:02.000Z", updatedAt: "x", attachedClients: 0, tabs: [] },
          main: { name: "main", status: "active", createdAt: "2026-06-15T12:00:03.000Z", updatedAt: "x", attachedClients: 0, tabs: [] },
          docs: { name: "docs", status: "active", createdAt: "2026-06-15T12:00:01.000Z", updatedAt: "x", attachedClients: 0, tabs: [] },
        },
      }),
      { flag: "wx" },
    );
    const adapter = {
      listSessions: vi.fn(async () => ["bench", "main", "docs"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.list()).resolves.toMatchObject([
      { name: "main" },
      { name: "docs" },
      { name: "bench" },
    ]);
  });

  it("persists custom order and respects it after reload", async () => {
    const root = await tempRoot();
    const live = new Set(["main", "bench", "docs"]);
    const adapter = {
      listSessions: vi.fn(async () => Array.from(live)),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await registry.list();
    await expect(registry.reorder(["docs", "main"])).resolves.toMatchObject([
      { name: "docs" },
      { name: "main" },
      { name: "bench" },
    ]);

    const reloaded = new ShellRegistry({ homePath: root, adapter });
    await expect(reloaded.list()).resolves.toMatchObject([
      { name: "docs" },
      { name: "main" },
      { name: "bench" },
    ]);
    const raw = await readFile(join(root, "system", "shell-sessions.json"), "utf-8");
    expect(JSON.parse(raw).order).toEqual(["docs", "main", "bench"]);
  });

  it("prunes deleted sessions from persisted custom order", async () => {
    const root = await tempRoot();
    const live = new Set(["main", "bench", "docs"]);
    const adapter = {
      listSessions: vi.fn(async () => Array.from(live)),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async (name: string) => {
        live.delete(name);
      }),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await registry.list();
    await registry.reorder(["docs", "bench", "main"]);
    await registry.delete("bench");

    const raw = await readFile(join(root, "system", "shell-sessions.json"), "utf-8");
    expect(JSON.parse(raw).order).toEqual(["docs", "main"]);
  });

  it("ignores stale custom order entries and appends new live sessions deterministically", async () => {
    const root = await tempRoot();
    const persistPath = join(root, "system", "shell-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      persistPath,
      JSON.stringify({
        order: ["ghost", "docs"],
        sessions: {
          docs: { name: "docs", status: "active", createdAt: "2026-06-15T12:00:04.000Z", updatedAt: "x", attachedClients: 0, tabs: [] },
          bench: { name: "bench", status: "active", createdAt: "2026-06-15T12:00:02.000Z", updatedAt: "x", attachedClients: 0, tabs: [] },
          main: { name: "main", status: "active", createdAt: "2026-06-15T12:00:03.000Z", updatedAt: "x", attachedClients: 0, tabs: [] },
        },
      }),
      { flag: "wx" },
    );
    const adapter = {
      listSessions: vi.fn(async () => ["main", "bench", "docs"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.list()).resolves.toMatchObject([
      { name: "docs" },
      { name: "bench" },
      { name: "main" },
    ]);
    const raw = await readFile(persistPath, "utf-8");
    expect(JSON.parse(raw).order).toEqual(["docs", "bench", "main"]);
  });

  it("atomically persists created sessions", async () => {
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => []),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await registry.create({ name: "main" });

    const raw = await readFile(join(root, "system", "shell-sessions.json"), "utf-8");
    expect(JSON.parse(raw).sessions.main.name).toBe("main");
  });

  it("does not cap live zellij shell sessions", async () => {
    const root = await tempRoot();
    const live = new Set<string>();
    const adapter = {
      listSessions: vi.fn(async () => Array.from(live)),
      createSession: vi.fn(async ({ name }: { name: string }) => {
        live.add(name);
      }),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });
    await registry.create({ name: "one" });

    await expect(registry.create({ name: "two" })).resolves.toMatchObject({
      name: "two",
      status: "active",
    });
    expect(adapter.createSession).toHaveBeenCalledTimes(2);
  });

  it("reconciles stale metadata against live zellij sessions", async () => {
    const root = await tempRoot();
    const persistPath = join(root, "system", "shell-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      persistPath,
      JSON.stringify({
        sessions: {
          stale: { name: "stale", status: "active", createdAt: "x", updatedAt: "x", attachedClients: 0, tabs: [] },
        },
      }),
      { flag: "wx" },
    );
    const adapter = {
      listSessions: vi.fn(async () => []),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.list()).resolves.toEqual([]);
    const raw = await readFile(persistPath, "utf-8");
    expect(JSON.parse(raw).sessions.stale.status).toBe("exited");
  });

  it("lists orphan zellij sessions missing from metadata and adopts them", async () => {
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => ["main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.list()).resolves.toMatchObject([
      { name: "main", status: "active", attachedClients: 0, tabs: [] },
    ]);

    const raw = await readFile(join(root, "system", "shell-sessions.json"), "utf-8");
    expect(JSON.parse(raw).sessions.main.name).toBe("main");
  });

  it("persists active/background placement and derives unread visual status from scrollback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T12:00:00.000Z"));
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => ["main", "deploy-logs", "review-done"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const scrollbackStore = {
      latestSeq: vi.fn(async (name: string) => (
        name === "main" ? 12 : name === "review-done" ? 7 : null
      )),
      cleanup: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({
      homePath: root,
      adapter,
      scrollbackStore: scrollbackStore as never,
    });

    await registry.updateUiState("main", { placement: "background", lastSeenSeq: 4 });
    vi.setSystemTime(new Date("2026-06-18T12:00:01.000Z"));
    await registry.updateUiState("review-done", { lastSeenSeq: 3, visualStatus: "finished" });
    vi.setSystemTime(new Date("2026-06-18T12:00:02.000Z"));

    await expect(registry.list()).resolves.toMatchObject([
      {
        name: "main",
        placement: "background",
        latestSeq: 12,
        lastSeenSeq: 4,
        unread: true,
        visualStatus: "finished",
        attachCommand: "mos shell attach main",
      },
      {
        name: "review-done",
        latestSeq: 7,
        lastSeenSeq: 3,
        unread: true,
        visualStatus: "finished",
      },
      {
        name: "deploy-logs",
        placement: "active",
        unread: false,
        visualStatus: "idle",
      },
    ]);

    const raw = await readFile(join(root, "system", "shell-sessions.json"), "utf-8");
    expect(JSON.parse(raw).sessions.main.placement).toBe("background");
  });

  it("derives status dots from OSC marks and unread output while ignoring legacy client state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => [
        "quiet",
        "unread-done",
        "osc-running",
        "osc-done",
        "waiting",
        "legacy-running",
      ]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const latestSeqByName = new Map([
      ["quiet", null],
      ["unread-done", 8],
      ["osc-running", 14],
      ["osc-done", 21],
      ["waiting", 3],
      ["legacy-running", 5],
    ]);
    const scrollbackStore = {
      latestSeq: vi.fn(async (name: string) => latestSeqByName.get(name) ?? null),
      latestActivity: vi.fn(async (name: string) => {
        if (name === "osc-running") {
          return {
            latestSeq: 14,
            latestOutputAt: "2026-06-15T11:59:58.000Z",
            commandRunning: true,
            latestCommandMark: { code: "B", kind: "command-start" },
          };
        }
        if (name === "osc-done") {
          return {
            latestSeq: 21,
            latestOutputAt: "2026-06-15T11:59:59.000Z",
            commandRunning: false,
            latestCommandMark: { code: "D", kind: "command-finished", exitCode: 0 },
          };
        }
        return {
          latestSeq: latestSeqByName.get(name) ?? null,
          latestOutputAt: null,
          commandRunning: null,
          latestCommandMark: null,
        };
      }),
      cleanup: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({
      homePath: root,
      adapter,
      scrollbackStore: scrollbackStore as never,
    });

    await registry.updateUiState("unread-done", { lastSeenSeq: 2 });
    await registry.updateUiState("osc-done", { lastSeenSeq: 20 });
    await registry.updateUiState("waiting", { visualStatus: "waiting" });
    await registry.updateUiState("legacy-running", { lastSeenSeq: 1, visualStatus: "running" });

    await expect(registry.list()).resolves.toMatchObject([
      { name: "legacy-running", latestSeq: 5, lastSeenSeq: 1, unread: true, visualStatus: "finished" },
      { name: "osc-done", latestSeq: 21, lastSeenSeq: 20, unread: true, visualStatus: "finished" },
      { name: "osc-running", unread: false, visualStatus: "running" },
      { name: "quiet", unread: false, visualStatus: "idle" },
      { name: "unread-done", latestSeq: 8, lastSeenSeq: 2, unread: true, visualStatus: "finished" },
      { name: "waiting", visualStatus: "idle" },
    ]);
  });

  it("derives running from current activity when persisted waiting metadata is stale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T12:00:00.000Z"));
    const root = await tempRoot();
    const persistPath = join(root, "system", "shell-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      persistPath,
      JSON.stringify({
        sessions: {
          main: {
            name: "main",
            status: "active",
            createdAt: "2026-06-24T12:00:00.000Z",
            updatedAt: "2026-06-24T12:00:00.000Z",
            attachedClients: 0,
            tabs: [],
            lastSeenSeq: 11,
            visualStatus: "waiting",
          },
        },
      }),
      { flag: "wx" },
    );
    const adapter = {
      listSessions: vi.fn(async () => ["main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const scrollbackStore = {
      latestSeq: vi.fn(async () => 12),
      latestActivity: vi.fn(async () => ({
        latestSeq: 12,
        latestOutputAt: "2026-06-25T11:59:59.000Z",
        commandRunning: true,
        latestCommandMark: { code: "B", kind: "command-start" },
      })),
      cleanup: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({
      homePath: root,
      adapter,
      scrollbackStore: scrollbackStore as never,
    });

    await expect(registry.list()).resolves.toMatchObject([
      { name: "main", latestSeq: 12, lastSeenSeq: 11, unread: true, visualStatus: "running" },
    ]);
  });

  it("expires stale persisted waiting metadata for quiet live sessions without deleting it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T12:00:30.000Z"));
    const root = await tempRoot();
    const persistPath = join(root, "system", "shell-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      persistPath,
      JSON.stringify({
        sessions: {
          main: {
            name: "main",
            status: "active",
            createdAt: "2026-06-24T12:00:00.000Z",
            updatedAt: "2026-06-25T12:00:00.000Z",
            attachedClients: 0,
            tabs: [],
            lastSeenSeq: 8,
            visualStatus: "waiting",
          },
        },
      }),
      { flag: "wx" },
    );
    const adapter = {
      listSessions: vi.fn(async () => ["main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const scrollbackStore = {
      latestSeq: vi.fn(async () => 8),
      latestActivity: vi.fn(async () => ({
        latestSeq: 8,
        latestOutputAt: null,
        commandRunning: null,
        latestCommandMark: null,
      })),
      cleanup: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({
      homePath: root,
      adapter,
      scrollbackStore: scrollbackStore as never,
    });

    await expect(registry.list()).resolves.toMatchObject([
      { name: "main", latestSeq: 8, lastSeenSeq: 8, unread: false, visualStatus: "idle" },
    ]);
    const raw = await readFile(persistPath, "utf-8");
    expect(JSON.parse(raw).sessions.main.visualStatus).toBe("waiting");
  });

  it("strips legacy waiting metadata when unrelated UI state is written", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T12:00:00.000Z"));
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => ["main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const scrollbackStore = {
      latestSeq: vi.fn(async () => 1),
      latestActivity: vi.fn(async () => ({
        latestSeq: 1,
        latestOutputAt: null,
        commandRunning: null,
        latestCommandMark: null,
      })),
      cleanup: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({
      homePath: root,
      adapter,
      scrollbackStore: scrollbackStore as never,
    });

    await registry.updateUiState("main", { visualStatus: "waiting" });
    vi.setSystemTime(new Date("2026-06-25T12:00:11.900Z"));
    await registry.updateUiState("main", { lastSeenSeq: 1 });
    vi.setSystemTime(new Date("2026-06-25T12:00:12.100Z"));

    await expect(registry.list()).resolves.toMatchObject([
      { name: "main", latestSeq: 1, lastSeenSeq: 1, unread: false, visualStatus: "idle" },
    ]);

    const raw = await readFile(join(root, "system", "shell-sessions.json"), "utf-8");
    expect(JSON.parse(raw).sessions.main).toMatchObject({
      lastSeenSeq: 1,
      updatedAt: "2026-06-25T12:00:11.900Z",
    });
    expect(JSON.parse(raw).sessions.main).not.toHaveProperty("visualStatus");
    expect(JSON.parse(raw).sessions.main).not.toHaveProperty("visualStatusUpdatedAt");
  });

  it("does not let repeated legacy writes create waiting intent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T12:00:00.000Z"));
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => ["main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const scrollbackStore = {
      latestSeq: vi.fn(async () => 1),
      latestActivity: vi.fn(async () => ({
        latestSeq: 1,
        latestOutputAt: null,
        commandRunning: null,
        latestCommandMark: null,
      })),
      cleanup: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({
      homePath: root,
      adapter,
      scrollbackStore: scrollbackStore as never,
    });

    await registry.updateUiState("main", { visualStatus: "waiting" });
    vi.setSystemTime(new Date("2026-06-25T12:00:11.900Z"));
    await registry.updateUiState("main", { visualStatus: "waiting" });
    vi.setSystemTime(new Date("2026-06-25T12:00:12.100Z"));

    await expect(registry.list()).resolves.toMatchObject([
      { name: "main", latestSeq: 1, lastSeenSeq: 1, unread: false, visualStatus: "idle" },
    ]);

    const raw = await readFile(join(root, "system", "shell-sessions.json"), "utf-8");
    expect(JSON.parse(raw).sessions.main).not.toHaveProperty("visualStatus");
    expect(JSON.parse(raw).sessions.main).not.toHaveProperty("visualStatusUpdatedAt");
  });

  it("rejects UI state updates for sessions absent from metadata and live sessions", async () => {
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => []),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.updateUiState("ghost", { placement: "active" })).rejects.toMatchObject({
      code: "session_not_found",
      status: 404,
    });

    await expect(readFile(join(root, "system", "shell-sessions.json"), "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(adapter.listSessions).toHaveBeenCalled();
  });

  it("uses agent lifecycle snapshots for waiting and shell fallback for idle", async () => {
    const root = await tempRoot();
    const agentStateStore = new AgentSessionStateStore({ homePath: root });
    await agentStateStore.apply({
      sessionName: "codex-backend",
      agent: "codex",
      type: "attention-requested",
      occurredAt: "2026-07-18T10:00:01.000Z",
      action: "Requested approval",
    });
    const adapter = {
      listSessions: vi.fn(async () => ["codex-backend", "shell-main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter, agentStateStore });

    await expect(registry.list()).resolves.toMatchObject([
      { name: "codex-backend", agent: "codex", visualStatus: "waiting", unread: false },
      { name: "shell-main", visualStatus: "idle", unread: false },
    ]);
  });

  it("renames live sessions while preserving durable UI state and scrollback", async () => {
    const root = await tempRoot();
    const live = new Set(["main"]);
    const adapter = {
      listSessions: vi.fn(async () => Array.from(live)),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
      renameSession: vi.fn(async (name: string, nextName: string) => {
        live.delete(name);
        live.add(nextName);
      }),
    };
    const scrollbackStore = {
      latestSeq: vi.fn(async (name: string) => (name === "review-main" ? 9 : null)),
      cleanup: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
    };
    const preferencesStore = {
      rename: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({
      homePath: root,
      adapter,
      scrollbackStore: scrollbackStore as never,
      preferencesStore: preferencesStore as never,
    });

    await registry.updateUiState("main", {
      placement: "background",
      lastSeenSeq: 3,
      visualStatus: "finished",
    });

    await expect(registry.rename("main", "review-main")).resolves.toMatchObject({
      name: "review-main",
      placement: "background",
      latestSeq: 9,
      lastSeenSeq: 3,
      unread: true,
      visualStatus: "finished",
      attachCommand: "mos shell attach review-main",
    });

    expect(adapter.renameSession).toHaveBeenCalledWith("main", "review-main");
    expect(scrollbackStore.rename).toHaveBeenCalledWith("main", "review-main");
    expect(preferencesStore.rename).toHaveBeenCalledWith("main", "review-main");
    const raw = await readFile(join(root, "system", "shell-sessions.json"), "utf-8");
    const sessions = JSON.parse(raw).sessions;
    expect(sessions.main).toBeUndefined();
    expect(sessions["review-main"].placement).toBe("background");
  });

  it("rolls back zellij, scrollback, and preferences when renamed metadata cannot persist", async () => {
    const root = await tempRoot();
    const systemDir = join(root, "system");
    const live = new Set(["main"]);
    const adapter = {
      listSessions: vi.fn(async () => Array.from(live)),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
      renameSession: vi.fn(async (name: string, nextName: string) => {
        live.delete(name);
        live.add(nextName);
      }),
    };
    const scrollbackStore = {
      latestSeq: vi.fn(async () => null),
      cleanup: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
    };
    const preferencesStore = {
      rename: vi.fn(async () => {
        if (preferencesStore.rename.mock.calls.length === 1) {
          await rm(systemDir, { recursive: true, force: true });
          await writeFile(systemDir, "not a directory", { flag: "wx" });
        }
      }),
    };
    const registry = new ShellRegistry({
      homePath: root,
      adapter,
      scrollbackStore: scrollbackStore as never,
      preferencesStore: preferencesStore as never,
    });

    await registry.updateUiState("main", { placement: "background" });

    await expect(registry.rename("main", "review-main")).rejects.toBeInstanceOf(Error);

    expect(adapter.renameSession).toHaveBeenNthCalledWith(1, "main", "review-main");
    expect(adapter.renameSession).toHaveBeenNthCalledWith(2, "review-main", "main");
    expect(scrollbackStore.rename).toHaveBeenNthCalledWith(1, "main", "review-main");
    expect(scrollbackStore.rename).toHaveBeenNthCalledWith(2, "review-main", "main");
    expect(preferencesStore.rename).toHaveBeenNthCalledWith(1, "main", "review-main");
    expect(preferencesStore.rename).toHaveBeenNthCalledWith(2, "review-main", "main");
    expect(Array.from(live)).toEqual(["main"]);
  });

  it("retargets aliases and pane references when a canonical live session is renamed", async () => {
    const root = await tempRoot();
    const persistPath = join(root, "system", "shell-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      persistPath,
      JSON.stringify({
        aliases: {
          "workspace-main": "main",
          "matrix-sess_run_8162a7cca11891c0": "main",
        },
        references: [
          { id: "pane-main", source: "pane", sessionName: "main" },
        ],
        sessions: {
          main: {
            name: "main",
            status: "active",
            createdAt: "2026-06-25T12:00:00.000Z",
            updatedAt: "2026-06-25T12:00:00.000Z",
            attachedClients: 0,
            tabs: [],
          },
        },
      }),
      { flag: "wx" },
    );
    const live = new Set(["main"]);
    const adapter = {
      listSessions: vi.fn(async () => Array.from(live)),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
      renameSession: vi.fn(async (name: string, nextName: string) => {
        live.delete(name);
        live.add(nextName);
      }),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.rename("main", "review-main")).resolves.toMatchObject({
      name: "review-main",
      aliases: [
        { name: "matrix-sess_run_8162a7cca11891c0", target: "review-main", source: "legacy" },
        { name: "workspace-main", target: "review-main", source: "workspace" },
      ],
      references: [{ id: "pane-main", source: "pane", sessionName: "review-main" }],
    });

    const raw = await readFile(persistPath, "utf-8");
    const persisted = JSON.parse(raw);
    expect(persisted.aliases).toEqual({
      "workspace-main": "review-main",
      "matrix-sess_run_8162a7cca11891c0": "review-main",
    });
    expect(persisted.references).toEqual([
      { id: "pane-main", source: "pane", sessionName: "review-main" },
    ]);
  });

  it("returns aliases and references for an idempotent same-name rename", async () => {
    const root = await tempRoot();
    const persistPath = join(root, "system", "shell-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      persistPath,
      JSON.stringify({
        aliases: {
          "workspace-main": "main",
        },
        references: [
          { id: "pane-main", source: "pane", sessionName: "main" },
        ],
        sessions: {
          main: {
            name: "main",
            status: "active",
            createdAt: "2026-06-25T12:00:00.000Z",
            updatedAt: "2026-06-25T12:00:00.000Z",
            attachedClients: 0,
            tabs: [],
          },
        },
      }),
      { flag: "wx" },
    );
    const adapter = {
      listSessions: vi.fn(async () => ["main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
      renameSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.rename("main", "main")).resolves.toMatchObject({
      name: "main",
      aliases: [{ name: "workspace-main", target: "main", source: "workspace" }],
      references: [{ id: "pane-main", source: "pane", sessionName: "main" }],
    });
    expect(adapter.renameSession).not.toHaveBeenCalled();
  });

  it("renames a canonical live session through a known alias", async () => {
    const root = await tempRoot();
    const persistPath = join(root, "system", "shell-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      persistPath,
      JSON.stringify({
        aliases: {
          "workspace-main": "main",
        },
        references: [
          { id: "pane-main", source: "pane", sessionName: "main" },
        ],
        sessions: {
          main: {
            name: "main",
            status: "active",
            createdAt: "2026-06-25T12:00:00.000Z",
            updatedAt: "2026-06-25T12:00:00.000Z",
            attachedClients: 0,
            tabs: [],
          },
        },
      }),
      { flag: "wx" },
    );
    const live = new Set(["main"]);
    const adapter = {
      listSessions: vi.fn(async () => Array.from(live)),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
      renameSession: vi.fn(async (name: string, nextName: string) => {
        live.delete(name);
        live.add(nextName);
      }),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.rename("workspace-main", "review-main")).resolves.toMatchObject({
      name: "review-main",
      aliases: [{ name: "workspace-main", target: "review-main", source: "workspace" }],
      references: [{ id: "pane-main", source: "pane", sessionName: "review-main" }],
    });
    expect(adapter.renameSession).toHaveBeenCalledWith("main", "review-main");
  });

  it("consumes an existing alias when renaming the canonical session to that alias name", async () => {
    const root = await tempRoot();
    const persistPath = join(root, "system", "shell-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      persistPath,
      JSON.stringify({
        aliases: {
          "workspace-main": "main",
        },
        references: [
          { id: "pane-main", source: "pane", sessionName: "main" },
        ],
        sessions: {
          main: {
            name: "main",
            status: "active",
            createdAt: "2026-06-25T12:00:00.000Z",
            updatedAt: "2026-06-25T12:00:00.000Z",
            attachedClients: 0,
            tabs: [],
          },
        },
      }),
      { flag: "wx" },
    );
    const live = new Set(["main"]);
    const adapter = {
      listSessions: vi.fn(async () => Array.from(live)),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
      renameSession: vi.fn(async (name: string, nextName: string) => {
        live.delete(name);
        live.add(nextName);
      }),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.rename("main", "workspace-main")).resolves.toMatchObject({
      name: "workspace-main",
      aliases: [],
      references: [{ id: "pane-main", source: "pane", sessionName: "workspace-main" }],
    });
    const raw = await readFile(persistPath, "utf-8");
    expect(JSON.parse(raw).aliases).toBeUndefined();
  });

  it("connects by adopting an orphan active zellij session", async () => {
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => ["main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.get("main")).resolves.toMatchObject({
      name: "main",
      status: "active",
    });
  });

  it("connects by resurrecting an orphan exited zellij session", async () => {
    const root = await tempRoot();
    const persistPath = join(root, "system", "shell-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      persistPath,
      JSON.stringify({
        sessions: {
          main: { name: "main", status: "exited", createdAt: "x", updatedAt: "x", attachedClients: 0, tabs: [] },
        },
      }),
      { flag: "wx" },
    );
    const adapter = {
      listSessions: vi.fn(async () => ["main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.get("main")).resolves.toMatchObject({
      name: "main",
      status: "active",
    });
    const raw = await readFile(persistPath, "utf-8");
    expect(JSON.parse(raw).sessions.main.status).toBe("active");
  });

  it("adopts existing zellij sessions when creating a duplicate name", async () => {
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => ["main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.create({ name: "main" })).resolves.toMatchObject({
      name: "main",
      status: "active",
    });

    expect(adapter.createSession).not.toHaveBeenCalled();
  });

  it("returns alias metadata when create adopts an existing live session", async () => {
    const root = await tempRoot();
    const persistPath = join(root, "system", "shell-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      persistPath,
      JSON.stringify({
        aliases: {
          "workspace-main": "main",
        },
        sessions: {},
      }),
      { flag: "wx" },
    );
    const adapter = {
      listSessions: vi.fn(async () => ["main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.create({ name: "main" })).resolves.toMatchObject({
      name: "main",
      aliases: [{ name: "workspace-main", target: "main", source: "workspace" }],
    });
    expect(adapter.createSession).not.toHaveBeenCalled();
  });

  it("keeps a live background session attached across reopen and reconnect reads without creating or deleting it", async () => {
    const root = await tempRoot();
    const persistPath = join(root, "system", "shell-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      persistPath,
      JSON.stringify({
        sessions: {
          main: {
            name: "main",
            status: "active",
            createdAt: "2026-06-25T12:00:00.000Z",
            updatedAt: "2026-06-25T12:00:00.000Z",
            attachedClients: 0,
            tabs: [],
            placement: "background",
          },
          docs: {
            name: "docs",
            status: "active",
            createdAt: "2026-06-25T12:00:01.000Z",
            updatedAt: "2026-06-25T12:00:01.000Z",
            attachedClients: 0,
            tabs: [],
            placement: "active",
          },
        },
      }),
      { flag: "wx" },
    );
    const adapter = {
      listSessions: vi.fn(async () => ["main", "docs"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "main",
        status: "active",
        placement: "background",
        attachCommand: "mos shell attach main",
      }),
    ]));
    await expect(registry.get("main")).resolves.toMatchObject({
      name: "main",
      status: "active",
      placement: "background",
      attachCommand: "mos shell attach main",
    });
    await expect(registry.list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "main", status: "active" }),
    ]));

    expect(adapter.createSession).not.toHaveBeenCalled();
    expect(adapter.deleteSession).not.toHaveBeenCalled();
    expect(adapter.listSessions).toHaveBeenCalledTimes(3);
  });

  it("collapses workspace and legacy aliases onto one canonical live session during normal reads", async () => {
    const root = await tempRoot();
    const persistPath = join(root, "system", "shell-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      persistPath,
      JSON.stringify({
        aliases: {
          "workspace-main": "main",
          "matrix-sess_run_8162a7cca11891c0": "main",
        },
        sessions: {
          main: {
            name: "main",
            status: "active",
            createdAt: "2026-06-25T12:00:00.000Z",
            updatedAt: "2026-06-25T12:00:00.000Z",
            attachedClients: 0,
            tabs: [],
          },
        },
      }),
      { flag: "wx" },
    );
    const adapter = {
      listSessions: vi.fn(async () => ["main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.list()).resolves.toMatchObject([
      {
        name: "main",
        canonicalName: "main",
        attachCommand: "mos shell attach main",
        aliases: [
          { name: "matrix-sess_run_8162a7cca11891c0", target: "main", source: "legacy" },
          { name: "workspace-main", target: "main", source: "workspace" },
        ],
      },
    ]);

    expect(adapter.createSession).not.toHaveBeenCalled();
  });

  it("ignores malformed alias metadata without blocking normal session reads", async () => {
    const root = await tempRoot();
    const persistPath = join(root, "system", "shell-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      persistPath,
      JSON.stringify({
        aliases: {
          "Bad Alias": "main",
          "legacy-good": "Main",
        },
        sessions: {
          main: {
            name: "main",
            status: "active",
            createdAt: "2026-06-25T12:00:00.000Z",
            updatedAt: "2026-06-25T12:00:00.000Z",
            attachedClients: 0,
            tabs: [],
          },
        },
      }),
      { flag: "wx" },
    );
    const adapter = {
      listSessions: vi.fn(async () => ["main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.list()).resolves.toMatchObject([
      { name: "main", aliases: [] },
    ]);
  });

  it("surfaces stale pane references as recoverable rows during normal reads", async () => {
    const root = await tempRoot();
    const persistPath = join(root, "system", "shell-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      persistPath,
      JSON.stringify({
        references: [
          { id: "pane-stale-docs", source: "pane", sessionName: "docs" },
        ],
        sessions: {
          main: {
            name: "main",
            status: "active",
            createdAt: "2026-06-25T12:00:00.000Z",
            updatedAt: "2026-06-25T12:00:00.000Z",
            attachedClients: 0,
            tabs: [],
          },
        },
      }),
      { flag: "wx" },
    );
    const adapter = {
      listSessions: vi.fn(async () => ["main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.list()).resolves.toMatchObject([
      { name: "main", status: "active", recoverable: false },
      {
        name: "docs",
        status: "exited",
        recoverable: true,
        recoveryReason: "missing_runtime_session",
        references: [{ id: "pane-stale-docs", source: "pane", sessionName: "docs" }],
      },
    ]);

    expect(adapter.createSession).not.toHaveBeenCalled();
    expect(adapter.deleteSession).not.toHaveBeenCalled();
  });

  it("deduplicates stale pane references that point through an alias and canonical name", async () => {
    const root = await tempRoot();
    const persistPath = join(root, "system", "shell-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      persistPath,
      JSON.stringify({
        aliases: {
          "workspace-docs": "docs",
        },
        references: [
          { id: "pane-alias-docs", source: "pane", sessionName: "workspace-docs" },
          { id: "pane-canonical-docs", source: "pane", sessionName: "docs" },
        ],
        sessions: {
          main: {
            name: "main",
            status: "active",
            createdAt: "2026-06-25T12:00:00.000Z",
            updatedAt: "2026-06-25T12:00:00.000Z",
            attachedClients: 0,
            tabs: [],
          },
        },
      }),
      { flag: "wx" },
    );
    const adapter = {
      listSessions: vi.fn(async () => ["main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    const sessions = await registry.list();

    expect(sessions.filter((session) => session.canonicalName === "docs")).toHaveLength(1);
    expect(sessions).toMatchObject([
      { name: "main", status: "active", recoverable: false },
      {
        name: "docs",
        canonicalName: "docs",
        status: "exited",
        recoverable: true,
        recoveryReason: "missing_runtime_session",
        aliases: [{ name: "workspace-docs", target: "docs", source: "workspace" }],
        references: [
          { id: "pane-alias-docs", source: "pane", sessionName: "workspace-docs" },
          { id: "pane-canonical-docs", source: "pane", sessionName: "docs" },
        ],
      },
    ]);
  });

  it("resolves known legacy aliases for open and delete without touching unrelated live sessions", async () => {
    const root = await tempRoot();
    const persistPath = join(root, "system", "shell-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      persistPath,
      JSON.stringify({
        aliases: {
          "matrix-sess_run_8162a7cca11891c0": "main",
        },
        sessions: {
          main: {
            name: "main",
            status: "active",
            createdAt: "2026-06-25T12:00:00.000Z",
            updatedAt: "2026-06-25T12:00:00.000Z",
            attachedClients: 0,
            tabs: [],
          },
          docs: {
            name: "docs",
            status: "active",
            createdAt: "2026-06-25T12:00:01.000Z",
            updatedAt: "2026-06-25T12:00:01.000Z",
            attachedClients: 0,
            tabs: [],
          },
        },
      }),
      { flag: "wx" },
    );
    const live = new Set(["main", "docs"]);
    const adapter = {
      listSessions: vi.fn(async () => Array.from(live)),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async (name: string) => {
        live.delete(name);
      }),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.get("matrix-sess_run_8162a7cca11891c0")).resolves.toMatchObject({
      name: "main",
      canonicalName: "main",
      attachCommand: "mos shell attach main",
    });
    await expect(registry.delete("matrix-sess_run_8162a7cca11891c0")).resolves.toBeUndefined();

    expect(adapter.deleteSession).toHaveBeenCalledWith("main", {});
    expect(Array.from(live)).toEqual(["docs"]);
    const raw = await readFile(persistPath, "utf-8");
    const persisted = JSON.parse(raw);
    expect(persisted.sessions.main).toBeUndefined();
    expect(persisted.sessions.docs).toBeDefined();
    expect(persisted.aliases?.["matrix-sess_run_8162a7cca11891c0"]).toBeUndefined();
  });

  it("force deletes live orphan zellij sessions missing from metadata", async () => {
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => ["bench"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.delete("bench", { force: true })).resolves.toBeUndefined();

    expect(adapter.deleteSession).toHaveBeenCalledWith("bench", { force: true });
  });

  it("deletes metadata-tracked sessions without listing live zellij sessions", async () => {
    const root = await tempRoot();
    const persistPath = join(root, "system", "shell-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      persistPath,
      JSON.stringify({
        sessions: {
          main: { name: "main", status: "active", createdAt: "x", updatedAt: "x", attachedClients: 0, tabs: [] },
        },
      }),
      { flag: "wx" },
    );
    const adapter = {
      listSessions: vi.fn(async () => {
        throw new Error("zellij list unavailable");
      }),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.delete("main")).resolves.toBeUndefined();

    expect(adapter.listSessions).not.toHaveBeenCalled();
    expect(adapter.deleteSession).toHaveBeenCalledWith("main", {});
  });

  it("rolls back zellij sessions if metadata persistence fails", async () => {
    const root = await tempRoot();
    const systemDir = join(root, "system");
    const adapter = {
      listSessions: vi.fn(async () => []),
      createSession: vi.fn(async () => {
        await rm(systemDir, { recursive: true, force: true });
        await writeFile(systemDir, "not a directory", { flag: "wx" });
      }),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({
      homePath: root,
      adapter,
    });

    await expect(registry.create({ name: "main" })).rejects.toBeInstanceOf(Error);
    expect(adapter.deleteSession).toHaveBeenCalledWith("main", { force: true });
  });
});
