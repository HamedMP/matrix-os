import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentSessionStateStore,
  deriveAgentVisualStatus,
  sanitizeAgentAction,
  sanitizeAgentModel,
  sanitizeAgentStrength,
  sanitizeAgentSubtitle,
  type NormalizedAgentEvent,
} from "../../packages/gateway/src/shell/agent-session-state.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "matrix-agent-session-state-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function event(
  type: NormalizedAgentEvent["type"],
  occurredAt: string,
  extra: Partial<NormalizedAgentEvent> = {},
): NormalizedAgentEvent {
  return {
    sessionName: "calm-otter",
    agent: "codex",
    type,
    occurredAt,
    ...extra,
  } as NormalizedAgentEvent;
}

describe("agent session state", () => {
  it("records agent identity without marking a newly started session as running or finished", async () => {
    const root = await tempRoot();
    const store = new AgentSessionStateStore({ homePath: root });

    const snapshot = await store.apply(event("session-started", "2026-07-18T10:00:00.000Z"));

    expect(snapshot.phase).toBe("started");
    expect(deriveAgentVisualStatus(snapshot, true)).toBe("idle");
  });

  it("records model metadata before the first prompt without marking the agent as running", async () => {
    const root = await tempRoot();
    const store = new AgentSessionStateStore({ homePath: root });

    const snapshot = await store.apply(event("metadata-updated", "2026-07-18T10:00:00.000Z", {
      model: "gpt-5.4",
      strength: "ultra",
    }));

    expect(snapshot).toMatchObject({ phase: "started", model: "gpt-5.4", strength: "ultra" });
    expect(deriveAgentVisualStatus(snapshot, false)).toBe("idle");
  });

  it("applies lifecycle precedence without exposing semantic tool states", async () => {
    const root = await tempRoot();
    const store = new AgentSessionStateStore({ homePath: root });

    await store.apply(event("turn-started", "2026-07-18T10:00:00.000Z"));
    expect(deriveAgentVisualStatus(await store.get("calm-otter"), false)).toBe("running");

    await store.apply(event("attention-requested", "2026-07-18T10:00:01.000Z", {
      action: "Requested approval",
    }));
    expect(deriveAgentVisualStatus(await store.get("calm-otter"), false)).toBe("waiting");

    await store.apply(event("action-updated", "2026-07-18T10:00:02.000Z", {
      action: "Edited registry.ts",
    }));
    expect(deriveAgentVisualStatus(await store.get("calm-otter"), false)).toBe("running");

    await store.apply(event("turn-completed", "2026-07-18T10:00:03.000Z", {
      subtitle: "Implemented the terminal session metadata.",
    }));
    const completed = await store.get("calm-otter");
    expect(deriveAgentVisualStatus(completed, true)).toBe("finished");
    expect(deriveAgentVisualStatus(completed, false)).toBe("idle");
  });

  it("rejects events older than the current snapshot", async () => {
    const root = await tempRoot();
    const store = new AgentSessionStateStore({ homePath: root });

    await store.apply(event("turn-completed", "2026-07-18T10:00:02.000Z", {
      subtitle: "New summary",
    }));
    await store.apply(event("turn-started", "2026-07-18T10:00:01.000Z", {
      subtitle: "Stale summary",
    }));

    await expect(store.get("calm-otter")).resolves.toMatchObject({
      phase: "completed",
      subtitle: "New summary",
      agentUpdatedAt: "2026-07-18T10:00:02.000Z",
    });
  });

  it("sanitizes and caps subtitles and meaningful actions", () => {
    expect(sanitizeAgentSubtitle("\u001b[31m  Fixed the thing.\nIgnored second line  ")).toBe(
      "Fixed the thing. Ignored second line",
    );
    expect(sanitizeAgentSubtitle("x".repeat(200))).toHaveLength(120);
    expect(sanitizeAgentAction("  Edited\nTerminalSidebarItems.tsx\u0000  ")).toBe(
      "Edited TerminalSidebarItems.tsx",
    );
    expect(sanitizeAgentAction("x".repeat(200))).toHaveLength(160);
    expect(sanitizeAgentModel("  openai/\u001b[31mgpt-5.4  ")).toBe("openai/gpt-5.4");
    expect(sanitizeAgentModel("x".repeat(120))).toHaveLength(80);
    expect(sanitizeAgentStrength("  HIGH\n ")).toBe("high");
    expect(sanitizeAgentStrength("ultra")).toBe("ultra");
    expect(sanitizeAgentStrength("not-a-strength")).toBeUndefined();
  });

  it("persists private atomic snapshots across store restarts", async () => {
    const root = await tempRoot();
    const store = new AgentSessionStateStore({ homePath: root });
    await store.apply(event("turn-completed", "2026-07-18T10:00:02.000Z", {
      subtitle: "A durable summary",
      action: "Edited registry.ts",
      model: "gpt-5.4",
      strength: "high",
    }));

    const snapshotPath = join(root, "system", "agent-sessions", "calm-otter.json");
    expect((await stat(snapshotPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(snapshotPath, "utf8"))).not.toHaveProperty("prompt");

    const reloaded = new AgentSessionStateStore({ homePath: root });
    await expect(reloaded.get("calm-otter")).resolves.toMatchObject({
      agent: "codex",
      subtitle: "A durable summary",
      lastAction: "Edited registry.ts",
      model: "gpt-5.4",
      strength: "high",
    });
  });

  it("keeps an old shell alias live after rename and removes all metadata on delete", async () => {
    const root = await tempRoot();
    const store = new AgentSessionStateStore({ homePath: root });
    await store.apply(event("turn-started", "2026-07-18T10:00:00.000Z"));

    await store.rename("calm-otter", "swift-falcon");
    await store.apply(event("turn-completed", "2026-07-18T10:00:02.000Z", {
      subtitle: "Updated through the old zellij name",
    }));

    await expect(store.get("swift-falcon")).resolves.toMatchObject({
      sessionName: "swift-falcon",
      subtitle: "Updated through the old zellij name",
    });
    await expect(store.get("calm-otter")).resolves.toMatchObject({
      sessionName: "swift-falcon",
    });

    await store.delete("swift-falcon");
    await expect(store.get("swift-falcon")).resolves.toBeNull();
    await expect(store.get("calm-otter")).resolves.toBeNull();
  });

  it("removes every alias in a legacy multi-hop rename chain on delete", async () => {
    const root = await tempRoot();
    const store = new AgentSessionStateStore({ homePath: root });
    await store.apply(event("turn-started", "2026-07-18T10:00:00.000Z"));
    await store.rename("calm-otter", "bright-heron");

    const aliasesPath = join(root, "system", "agent-sessions", "aliases.json");
    await writeFile(aliasesPath, `${JSON.stringify({
      version: 1,
      aliases: {
        "calm-otter": "swift-falcon",
        "swift-falcon": "bright-heron",
      },
    })}\n`);

    await store.delete("bright-heron");

    await expect(readFile(aliasesPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.get("calm-otter")).resolves.toBeNull();
    await expect(store.get("swift-falcon")).resolves.toBeNull();
  });

  it("creates the state directory with owner-only access", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "system"), { recursive: true });
    const store = new AgentSessionStateStore({ homePath: root });
    await store.apply(event("turn-started", "2026-07-18T10:00:00.000Z"));

    expect((await stat(join(root, "system", "agent-sessions"))).mode & 0o777).toBe(0o700);
  });

  it("evicts the oldest snapshot when the owner-local bound is reached", async () => {
    const root = await tempRoot();
    const store = new AgentSessionStateStore({ homePath: root, maxSnapshots: 2 });
    await store.apply(event("turn-started", "2026-07-18T10:00:00.000Z", { sessionName: "calm-otter" }));
    await store.apply(event("turn-started", "2026-07-18T10:00:01.000Z", { sessionName: "swift-falcon" }));
    await store.apply(event("turn-started", "2026-07-18T10:00:02.000Z", { sessionName: "bright-river" }));

    await expect(store.get("calm-otter")).resolves.toBeNull();
    await expect(store.get("swift-falcon")).resolves.not.toBeNull();
    await expect(store.get("bright-river")).resolves.not.toBeNull();
  });

  it("evicts corrupt snapshots without rejecting a successful event write", async () => {
    const root = await tempRoot();
    const directory = join(root, "system", "agent-sessions");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "corrupt-entry.json"), "{not valid snapshot json", { mode: 0o600 });
    const store = new AgentSessionStateStore({ homePath: root, maxSnapshots: 1 });

    await expect(store.apply(event("turn-started", "2026-07-18T10:00:00.000Z"))).resolves.toMatchObject({
      sessionName: "calm-otter",
      phase: "running",
    });
    await expect(readFile(join(directory, "corrupt-entry.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
