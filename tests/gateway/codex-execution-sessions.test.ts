import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createCodexExecutionSessions } from "../../packages/gateway/src/coding-agents/codex-execution-sessions.js";

async function fixture() {
  const homePath = await mkdtemp(join(tmpdir(), "codex-session-expiry-"));
  const directory = join(homePath, "system/ai-providers");
  await mkdir(directory, { recursive: true });
  const indexPath = join(directory, "codex-execution-sessions.json");
  const marker = join(directory, "codex-execution-revocation.json");
  const rows = [
    { sessionId: "sess_expired", userId: "owner", binding: "a".repeat(64), expiresAt: Date.now() - 1000 },
    { sessionId: "sess_fresh", userId: "owner", binding: "a".repeat(64), expiresAt: Date.now() + 3600000 },
  ];
  await writeFile(indexPath, JSON.stringify(rows));
  return { homePath, indexPath, marker, rows };
}

it.each(["get", "register"])("%s drains only expired references without fencing a fresh child", async (operation) => {
  const f = await fixture();
  try {
    const stopSession = vi.fn(async (id: string) => {
      expect(id).toBe("sess_expired");
      // The independent final-child check remains open while the expired stop is pending.
      await expect(createCodexExecutionSessions(f.homePath).assertOpen()).resolves.toBeUndefined();
      await expect(stat(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.parse(await readFile(f.indexPath, "utf8"))).toEqual(f.rows);
    });
    const sessions = createCodexExecutionSessions(f.homePath, stopSession);
    if (operation === "get") expect(await sessions.get("sess_fresh")).toMatchObject({ userId: "owner" });
    else await sessions.register("owner", "sess_new", "a".repeat(64));
    expect(stopSession).toHaveBeenCalledExactlyOnceWith("sess_expired");
    const persisted = JSON.parse(await readFile(f.indexPath, "utf8"));
    expect(persisted.map((row: { sessionId: string }) => row.sessionId)).toEqual(operation === "get" ? ["sess_fresh"] : ["sess_fresh", "sess_new"]);
    const reopened = createCodexExecutionSessions(f.homePath, stopSession);
    expect(await reopened.get("sess_fresh")).toMatchObject({ userId: "owner" });
    expect(stopSession).toHaveBeenCalledTimes(1);
  } finally { await rm(f.homePath, { recursive: true, force: true }); }
});

it("retains references and a persistent fence after an uncertain expired stop", async () => {
  const f = await fixture();
  try {
    const stopSession = vi.fn(async () => { throw new Error("unknown stop outcome"); });
    const sessions = createCodexExecutionSessions(f.homePath, stopSession);
    await expect(sessions.get("sess_fresh")).rejects.toThrow("unavailable");
    expect(stopSession).toHaveBeenCalledExactlyOnceWith("sess_expired");
    expect(JSON.parse(await readFile(f.indexPath, "utf8"))).toEqual(f.rows);
    await expect(stat(f.marker)).resolves.toBeDefined();
    await expect(createCodexExecutionSessions(f.homePath).get("sess_fresh")).rejects.toThrow("unavailable");
  } finally { await rm(f.homePath, { recursive: true, force: true }); }
});
