import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { AgentProviderSummary } from "@matrix-os/contracts";
import { createCodexModelCatalogSource } from "../../packages/gateway/src/chat/codex-model-catalog";

const provider: AgentProviderSummary = { id: "codex", kind: "codex", displayName: "Codex", availability: "available", installStatus: "installed", authStatus: "unknown", supportedModes: ["default"], defaultMode: "default", setupActions: [] };
const alice = { userId: "fixture_owner_a", source: "jwt" as const };
const bob = { userId: "fixture_owner_b", source: "jwt" as const };

// Only process I/O is fake. Cache, invalidation, normalization and exit fencing are real.
function fixture() {
  const attempts: { reply: (model: string | null) => void; close: () => void; kills: string[] }[] = [];
  let autoReply: string | null | undefined = "old-model";
  let autoClose = true;
  const source = createCodexModelCatalogSource({ executable: "/synthetic/codex", cwd: "/synthetic/home",
    maxAttempts: 1, timeoutMs: 50, terminateGraceMs: 2,
    spawnProcess: () => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      const attempt = { reply: (model: string | null) => child.stdout.write(JSON.stringify({ id: 2,
        result: model === null ? {} : { data: [{ id: model, model, displayName: model, hidden: false, isDefault: true,
          defaultReasoningEffort: "low", supportedReasoningEfforts: [] }], nextCursor: null } }) + "\n"),
        close: () => { child.emit("close", 0); }, kills: [] as string[] };
      attempts.push(attempt);
      Object.assign(child, { kill: (signal: string) => { attempt.kills.push(signal); if (autoClose) queueMicrotask(attempt.close); return true; } });
      child.stdin.on("data", (chunk: Buffer) => {
        const request = JSON.parse(chunk.toString()) as { id?: number };
        if (request.id === 1) queueMicrotask(() => child.stdout.write('{"id":1,"result":{}}\n'));
        if (request.id === 2 && autoReply !== undefined) queueMicrotask(() => attempt.reply(autoReply!));
      });
      return child as never;
    },
  });
  return { source, attempts, setModel: (value: string | null | undefined) => { autoReply = value; }, setAutoClose: (value: boolean) => { autoClose = value; } };
}

describe("native Codex login source invalidation contract", () => {
  it("evicts the successful owner's positive cache while retaining another owner's inventory", async () => {
    const f = fixture();
    await expect(f.source(provider, alice)).resolves.toMatchObject({ defaultModel: "old-model" });
    await f.source(provider, bob);
    f.setModel("new-model");
    f.source.invalidate(alice);
    await expect(f.source(provider, alice)).resolves.toMatchObject({ defaultModel: "new-model" });
    await expect(f.source(provider, bob)).resolves.toMatchObject({ defaultModel: "old-model" });
    expect(f.attempts).toHaveLength(3);
  });

  it("drops a negative cache immediately after confirmed login without dropping another owner's failure", async () => {
    const f = fixture(); f.setModel(null);
    await expect(f.source(provider, alice)).rejects.toThrow();
    await expect(f.source(provider, bob)).rejects.toThrow();
    f.setModel("new-model"); f.source.invalidate(alice);
    await expect(f.source(provider, alice)).resolves.toMatchObject({ defaultModel: "new-model" });
    await expect(f.source(provider, bob)).rejects.toThrow();
    expect(f.attempts).toHaveLength(3);
  });

  it.each(["old-model", null])("fences a pending pre-login result=%s and waits for exit before the new lookup", async result => {
    const f = fixture(); f.setModel(undefined);
    const old = f.source(provider, alice).then(value => value, () => null);
    await vi.waitFor(() => expect(f.attempts).toHaveLength(1));
    f.source.invalidate(alice);
    const fresh = f.source(provider, alice);
    expect(f.attempts).toHaveLength(1);
    f.setModel("new-model"); f.attempts[0]!.reply(result);
    await old;
    await expect(fresh).resolves.toMatchObject({ defaultModel: "new-model" });
    await expect(f.source(provider, alice)).resolves.toMatchObject({ defaultModel: "new-model" });
    expect(f.attempts).toHaveLength(2);
    expect(f.attempts[0]!.kills).toEqual(["SIGTERM"]);
  });

  it("never clears an unconfirmed-child-exit safety fence when login invalidates metadata", async () => {
    const f = fixture(); f.setAutoClose(false); f.setModel(null);
    try {
      await expect(f.source(provider, alice)).rejects.toThrow("process did not exit");
      f.source.invalidate(alice); f.setModel("new-model");
      await expect(f.source(provider, alice)).rejects.toThrow("unavailable");
      expect(f.attempts).toHaveLength(1);
      f.setAutoClose(true); f.attempts[0]!.close();
      await Promise.resolve();
      await expect(f.source(provider, alice)).resolves.toMatchObject({ defaultModel: "new-model" });
      expect(f.attempts).toHaveLength(2);
    } finally { f.attempts.forEach(attempt => attempt.close()); }
  });

  it("bounds owner inventory retention and keeps ordinary cached reads spawn-free", async () => {
    const f = fixture();
    await f.source(provider, alice); await f.source(provider, alice);
    expect(f.attempts).toHaveLength(1);
    for (let index = 0; index < 64; index++) await f.source(provider, { userId: `fixture_${index}` });
    f.setModel("new-model");
    await expect(f.source(provider, alice)).resolves.toMatchObject({ defaultModel: "new-model" });
    expect(f.attempts).toHaveLength(66);
  });
});
