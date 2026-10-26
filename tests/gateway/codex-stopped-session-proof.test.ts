import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionManager } from "../../packages/gateway/src/agent-session-manager.js";
import { isSessionStopConfirmed } from "../../packages/gateway/src/coding-agents/session-start-cleanup-proof.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

describe("stopped legacy Codex session evidence", () => {
  it.each(["stopped", "alive", "probe-error", "foreign-owner", "stale-ref", "wrong-agent", "missing-session", "no-runtime"])(
    "issues private evidence only for the exact stopped background incarnation (%s)", async mode => {
      const homePath = await mkdtemp(join(tmpdir(), "stopped-codex-proof-")); homes.push(homePath);
      const ref = { id: `bg_${"a".repeat(32)}` };
      await mkdir(join(homePath, "system/sessions"), { recursive: true });
      if (mode !== "missing-session") await writeFile(join(homePath, "system/sessions/sess_old.json"), JSON.stringify({
        id: "sess_old", ownerId: mode === "foreign-owner" ? "other" : "owner", kind: "agent", agent: mode === "wrong-agent" ? "claude" : "codex",
        backgroundRef: mode === "stale-ref" ? { id: `bg_${"b".repeat(32)}` } : ref,
        runtime: { type: "background", status: "degraded" },
      }));
      const isRunning = vi.fn(async () => { if (mode === "probe-error") throw new Error("unavailable"); return mode === "alive"; });
      const manager = createAgentSessionManager({ homePath, worktreeManager: {} as never, agentLauncher: {} as never,
        terminalRuntime: {} as never, ...(mode === "no-runtime" ? {} : { backgroundRuntime: { isRunning } as never }) });
      const operation = () => (manager as unknown as { confirmStoppedSession(owner: string, id: string, ref: unknown): Promise<unknown> })
        .confirmStoppedSession("owner", "sess_old", ref);
      if (mode === "probe-error") await expect(operation()).rejects.toThrow();
      else expect(isSessionStopConfirmed(await operation(), "owner", "sess_old")).toBe(mode === "stopped");
    });
});
