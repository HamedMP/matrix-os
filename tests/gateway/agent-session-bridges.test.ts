import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeAgentBridgeEvents,
  registerAgentBridges,
} from "../../packages/gateway/src/shell/agent-session-bridges.js";
import {
  ingestAgentBridgePayload,
  withBridgeFileLock,
} from "../../packages/gateway/src/shell/agent-session-bridge-cli.js";
import { AgentSessionStateStore } from "../../packages/gateway/src/shell/agent-session-state.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "matrix-agent-bridges-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent session bridge adapters", () => {
  it("normalizes Claude lifecycle, permission, subtitle, and tool events", () => {
    expect(normalizeAgentBridgeEvents({
      agent: "claude",
      eventName: "UserPromptSubmit",
      sessionName: "calm-otter",
      occurredAt: "2026-07-18T10:00:00.000Z",
      payload: { prompt: "Refactor the terminal sidebar. Keep the layout stable." },
    })).toEqual([expect.objectContaining({
      type: "turn-started",
      agent: "claude",
      subtitle: "Refactor the terminal sidebar.",
    })]);

    expect(normalizeAgentBridgeEvents({
      agent: "claude",
      eventName: "PermissionRequest",
      sessionName: "calm-otter",
      occurredAt: "2026-07-18T10:00:01.000Z",
      payload: {},
    })).toEqual([expect.objectContaining({
      type: "attention-requested",
      action: "Requested approval",
    })]);

    expect(normalizeAgentBridgeEvents({
      agent: "claude",
      eventName: "PostToolUse",
      sessionName: "calm-otter",
      occurredAt: "2026-07-18T10:00:02.000Z",
      payload: { tool_name: "Edit", tool_input: { file_path: "/repo/TerminalSidebarItems.tsx", old_string: "secret" } },
    })).toEqual([expect.objectContaining({
      type: "action-updated",
      action: "Edited TerminalSidebarItems.tsx",
    })]);
  });

  it("normalizes Codex hooks without retaining prompts or tool arguments", () => {
    const events = normalizeAgentBridgeEvents({
      agent: "codex",
      eventName: "Stop",
      sessionName: "calm-otter",
      occurredAt: "2026-07-18T10:00:02.000Z",
      payload: {
        last_assistant_message: "Implemented the session metadata. Additional private details follow.",
        tool_input: { command: "cat ~/.ssh/id_rsa" },
      },
    });

    expect(events).toEqual([expect.objectContaining({
      type: "turn-completed",
      agent: "codex",
      subtitle: "Implemented the session metadata.",
    })]);
    expect(JSON.stringify(events)).not.toContain("id_rsa");
  });

  it("normalizes OpenCode plugin events", () => {
    expect(normalizeAgentBridgeEvents({
      agent: "opencode",
      eventName: "session.status",
      sessionName: "calm-otter",
      occurredAt: "2026-07-18T10:00:00.000Z",
      payload: { properties: { status: { type: "busy" } } },
    })).toEqual([expect.objectContaining({ type: "turn-started", agent: "opencode" })]);

    expect(normalizeAgentBridgeEvents({
      agent: "opencode",
      eventName: "permission.asked",
      sessionName: "calm-otter",
      occurredAt: "2026-07-18T10:00:01.000Z",
      payload: {},
    })).toEqual([expect.objectContaining({ type: "attention-requested" })]);

    expect(normalizeAgentBridgeEvents({
      agent: "opencode",
      eventName: "permission.replied",
      sessionName: "calm-otter",
      occurredAt: "2026-07-18T10:00:02.000Z",
      payload: {},
    })).toEqual([expect.objectContaining({ type: "turn-started" })]);

    expect(normalizeAgentBridgeEvents({
      agent: "opencode",
      eventName: "session.idle",
      sessionName: "calm-otter",
      occurredAt: "2026-07-18T10:00:03.000Z",
      payload: {},
    })).toEqual([expect.objectContaining({ type: "turn-completed" })]);
  });

  it("normalizes Pi extension events", () => {
    expect(normalizeAgentBridgeEvents({
      agent: "pi",
      eventName: "before_agent_start",
      sessionName: "calm-otter",
      occurredAt: "2026-07-18T10:00:00.000Z",
      payload: { prompt: "Improve the terminal session cards." },
    })).toEqual([expect.objectContaining({
      type: "turn-started",
      agent: "pi",
      subtitle: "Improve the terminal session cards.",
    })]);

    expect(normalizeAgentBridgeEvents({
      agent: "pi",
      eventName: "agent_end",
      sessionName: "calm-otter",
      occurredAt: "2026-07-18T10:00:02.000Z",
      payload: { summary: "Finished the terminal card redesign." },
    })).toEqual([expect.objectContaining({ type: "turn-completed" })]);
  });
});

describe("agent session bridge registration", () => {
  it("registers all providers additively, privately, and idempotently", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, ".claude", "settings.json"), JSON.stringify({
      theme: "dark",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/user/policy.sh" }] }],
      },
    }));
    await mkdir(join(root, ".codex"), { recursive: true });
    await writeFile(join(root, ".codex", "hooks.json"), JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "/user/start.sh" }] }],
      },
    }));
    await mkdir(join(root, ".config", "opencode", "plugins"), { recursive: true });
    await writeFile(join(root, ".config", "opencode", "plugins", "user-plugin.js"), "export const UserPlugin = () => ({});\n");
    await mkdir(join(root, ".pi", "agent", "extensions"), { recursive: true });
    await writeFile(join(root, ".pi", "agent", "extensions", "user-extension.ts"), "export default () => {};\n");

    const command = "/opt/matrix/bin/matrix-agent-bridge";
    await registerAgentBridges({ homePath: root, command });
    await registerAgentBridges({ homePath: root, command });

    const claude = JSON.parse(await readFile(join(root, ".claude", "settings.json"), "utf8"));
    expect(claude.theme).toBe("dark");
    expect(claude.hooks.PreToolUse).toContainEqual(expect.objectContaining({ matcher: "Bash" }));
    expect(claude.hooks.Stop.filter((entry: unknown) => JSON.stringify(entry).includes(command))).toHaveLength(1);

    const codex = JSON.parse(await readFile(join(root, ".codex", "hooks.json"), "utf8"));
    expect(codex.hooks.SessionStart).toContainEqual(expect.objectContaining({
      hooks: [expect.objectContaining({ command: "/user/start.sh" })],
    }));
    expect(codex.hooks.Stop.filter((entry: unknown) => JSON.stringify(entry).includes(command))).toHaveLength(1);
    const codexBridgeConfig = JSON.stringify(codex.hooks);
    expect(codexBridgeConfig).not.toContain('"async":true');
    expect(codex.hooks).not.toHaveProperty("PostToolUseFailure");
    expect(codex.hooks).not.toHaveProperty("SessionEnd");

    await expect(readFile(join(root, ".config", "opencode", "plugins", "user-plugin.js"), "utf8"))
      .resolves.toContain("UserPlugin");
    await expect(readFile(join(root, ".pi", "agent", "extensions", "user-extension.ts"), "utf8"))
      .resolves.toContain("export default");

    const opencodeBridge = join(root, ".config", "opencode", "plugins", "matrix-session-metadata.js");
    const piBridge = join(root, ".pi", "agent", "extensions", "matrix-session-metadata.ts");
    await expect(readFile(opencodeBridge, "utf8")).resolves.toContain(command);
    await expect(readFile(piBridge, "utf8")).resolves.toContain(command);
    expect((await stat(opencodeBridge)).mode & 0o777).toBe(0o600);
    expect((await stat(piBridge)).mode & 0o777).toBe(0o600);
  });

  it("preserves malformed provider configuration while registering the other bridges", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".claude"), { recursive: true });
    const settingsPath = join(root, ".claude", "settings.json");
    await writeFile(settingsPath, "{ user config is malformed");

    await expect(registerAgentBridges({ homePath: root })).resolves.toEqual({
      registered: ["codex", "opencode", "pi"],
      failed: ["claude"],
    });
    await expect(readFile(settingsPath, "utf8")).resolves.toBe("{ user config is malformed");
    await expect(readFile(join(root, ".codex", "hooks.json"), "utf8")).resolves.toContain(
      "matrix-agent-bridge codex Stop",
    );
    await expect(readFile(join(root, ".config", "opencode", "plugins", "matrix-session-metadata.js"), "utf8"))
      .resolves.toContain("matrix-agent-bridge");
    await expect(readFile(join(root, ".pi", "agent", "extensions", "matrix-session-metadata.ts"), "utf8"))
      .resolves.toContain("matrix-agent-bridge");
  });
});

describe("agent session bridge ingestion", () => {
  it("recovers a stale regular-file lock left by a crashed bridge", async () => {
    const root = await tempRoot();
    const directory = join(root, "system", "agent-sessions");
    const lockPath = join(directory, ".bridge.lock");
    await mkdir(directory, { recursive: true });
    await writeFile(lockPath, "stale", { mode: 0o600 });
    const staleAt = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleAt, staleAt);

    await expect(withBridgeFileLock(root, async () => "recovered")).resolves.toBe("recovered");
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the zellij shell name and persists only normalized metadata", async () => {
    const root = await tempRoot();
    const store = new AgentSessionStateStore({ homePath: root });

    await ingestAgentBridgePayload({
      agent: "codex",
      eventName: "PostToolUse",
      sessionName: "calm-otter",
      occurredAt: "2026-07-18T10:00:02.000Z",
      payload: {
        tool_name: "Edit",
        tool_input: { file_path: "/repo/registry.ts", old_string: "private prompt fragment" },
      },
      store,
    });

    await expect(store.get("calm-otter")).resolves.toMatchObject({
      agent: "codex",
      lastAction: "Edited registry.ts",
    });
    const snapshot = await readFile(join(root, "system", "agent-sessions", "calm-otter.json"), "utf8");
    expect(snapshot).not.toContain("private prompt fragment");
  });
});
