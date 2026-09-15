import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodingAgentThreadStore, createFakeCodingAgentProvider } from "../../packages/gateway/src/coding-agents/thread-store.js";

const owner = { userId: "owner_test", source: "jwt" as const };
const terminalRef = { workspaceId: `tws_${"1".repeat(32)}`, tabId: `tt_${"2".repeat(32)}` };
const legacy = { ownerId: owner.userId, workspaceSessionId: "sess_old", terminalSessionId: "main", runtimeStatus: "failed", occurredAt: "2026-09-10T00:00:00.000Z" };
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function harness(stops: unknown[]) {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-legacy-stops-"));
  homes.push(homePath);
  const path = join(homePath, "system/coding-agents/threads.json");
  await mkdir(join(homePath, "system/coding-agents"), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 1, threads: [], events: [], turns: [], pendingTerminalStops: stops }));
  const store = () => createCodingAgentThreadStore({ homePath, providers: [createFakeCodingAgentProvider({ providerId: "codex" })] });
  return { path, store };
}
const request = { providerId: "codex", prompt: "Respond without tools.", clientRequestId: "req_legacy_repro", terminalRef, projectId: "test-project" };

describe("persisted legacy terminal stops", () => {
  it("admits a new coding Run with 89 historical stops and preserves them across restart and reconciliation", async () => {
    const stops = Array.from({ length: 89 }, (_, i) => ({ ...legacy, terminalSessionId: `old_${i}` }));
    const { path, store } = await harness(stops);
    const before = await readFile(path, "utf8");
    await store().listThreads(owner);
    expect(await readFile(path, "utf8")).toBe(before);
    const created = await store().createThread(owner, request);
    expect(created.snapshot.thread.status).toBe("running");
    expect(created.snapshot.events.items.some(event => event.type === "assistant.text.delta")).toBe(true);
    const restarted = store();
    await restarted.reconcileTerminalTabStopped({ ownerId: owner.userId, terminalRef, runtimeStatus: "failed" });
    expect((await restarted.getThread(owner, created.snapshot.thread.id)).thread.status).toBe("failed");
    await restarted.reconcileTerminalTabStopped({ ownerId: owner.userId, terminalRef, runtimeStatus: "failed" });
    await restarted.deleteProjectThreads(owner, "test-project");
    expect(JSON.parse(await readFile(path, "utf8")).pendingTerminalStops).toEqual(stops);
  });

  it("keeps modern stop matching exact while legacy stops coexist", async () => {
    const { path, store } = await harness([legacy]);
    const threads = store();
    await threads.reconcileTerminalTabStopped({ ownerId: "other_owner", terminalRef, runtimeStatus: "failed" });
    const first = await threads.createThread(owner, request);
    expect(first.snapshot.thread.status).toBe("running");
    const secondRef = { ...terminalRef, tabId: `tt_${"3".repeat(32)}` };
    await threads.reconcileTerminalTabStopped({ ownerId: owner.userId, terminalRef: secondRef, runtimeStatus: "failed" });
    const second = await threads.createThread(owner, { ...request, terminalRef: secondRef, clientRequestId: "req_second" });
    expect(second.snapshot.thread.status).toBe("failed");
    expect(JSON.parse(await readFile(path, "utf8")).pendingTerminalStops).toEqual([legacy, expect.objectContaining({ ownerId: "other_owner", terminalRef })]);
  });

  it.each([
    { ...legacy, terminalSessionId: "" },
    { ...legacy, runtimeStatus: "running" },
    { ...legacy, unexpected: true },
    { ...legacy, terminalRef },
    { ...legacy, ownerId: "" },
  ])("rejects malformed or ambiguous legacy records %#", async stop => {
    const { store } = await harness([stop]);
    await expect(store().listThreads(owner)).rejects.toMatchObject({ name: "ZodError" });
  });
});
