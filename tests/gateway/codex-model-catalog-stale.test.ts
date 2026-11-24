import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_CATALOG_STALE_WINDOW_MS } from "../../packages/gateway/src/chat/codex-model-catalog.js";
import { createChatSendTimer } from "../../packages/gateway/src/chat/send-timing.js";
import { codexCatalogFixture, codexProvider } from "../helpers/codex-model-catalog-fixture.js";

const alice = { userId: "fixture_owner_a", source: "jwt" as const };
const TTL = 1_000;
const T0 = new Date("2026-11-10T00:00:00.000Z").getTime();

function at(offsetMs: number) { vi.setSystemTime(T0 + offsetMs); }

/** A catalog that went stale after one verified lookup of `model-a`. */
async function staleFixture() {
  const f = codexCatalogFixture({ cacheTtlMs: TTL });
  await expect(f.source(codexProvider, alice)).resolves.toMatchObject({ defaultModel: "model-a" });
  at(TTL + 1);
  return f;
}

describe("Codex model catalog stale-while-revalidate", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("serves an expired verified catalog immediately while one background lookup refreshes it", async () => {
    const f = await staleFixture();
    f.setModel(undefined);
    await expect(f.source(codexProvider, alice)).resolves.toMatchObject({ defaultModel: "model-a" });
    expect(f.attempts).toHaveLength(2);
    f.attempts[1]!.reply("model-b");
    await vi.waitFor(async () => {
      await expect(f.source(codexProvider, alice)).resolves.toMatchObject({ defaultModel: "model-b" });
    });
    expect(f.attempts).toHaveLength(2);
  });

  it("deduplicates the background refresh across concurrent and repeated stale reads", async () => {
    const f = await staleFixture();
    f.setModel(undefined);
    const reads = await Promise.all(Array.from({ length: 5 }, () => f.source(codexProvider, alice)));
    await f.source(codexProvider, alice);
    expect(reads.every((read) => read?.defaultModel === "model-a")).toBe(true);
    expect(f.attempts).toHaveLength(2);
    f.attempts[1]!.reply("model-b");
  });

  it("never serves stale data across an account change, even if the old refresh finishes later", async () => {
    const f = await staleFixture();
    f.setModel(undefined);
    await f.source(codexProvider, alice);
    expect(f.attempts).toHaveLength(2);
    f.source.invalidate(alice);
    f.setModel("model-b");
    const fresh = f.source(codexProvider, alice);
    f.attempts[1]!.reply("model-old-account");
    await expect(fresh).resolves.toMatchObject({ defaultModel: "model-b" });
    await expect(f.source(codexProvider, alice)).resolves.toMatchObject({ defaultModel: "model-b" });
    expect(f.attempts).toHaveLength(3);
  });

  it("blocks for a fresh lookup when the provider's auth or install state changed since verification", async () => {
    for (const changed of [{ authStatus: "expired" as const }, { installStatus: "installing" as const }]) {
      const f = await staleFixture();
      f.setModel("model-b");
      await expect(f.source({ ...codexProvider, ...changed }, alice)).resolves.toMatchObject({ defaultModel: "model-b" });
      expect(f.attempts).toHaveLength(2);
      at(0);
    }
  });

  it("blocks like a cold read once the stale window lapses", async () => {
    const f = await staleFixture();
    at(CODEX_CATALOG_STALE_WINDOW_MS);
    f.setModel(undefined);
    let settled = false;
    const read = f.source(codexProvider, alice).then((value) => { settled = true; return value; });
    await vi.waitFor(() => expect(f.attempts).toHaveLength(2));
    await Promise.resolve();
    expect(settled).toBe(false);
    f.attempts[1]!.reply("model-b");
    await expect(read).resolves.toMatchObject({ defaultModel: "model-b" });
  });

  it("logs a failed refresh, keeps serving within the window, then fails closed after it lapses", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = await staleFixture();
    f.setModel(null);
    await expect(f.source(codexProvider, alice)).resolves.toMatchObject({ defaultModel: "model-a" });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("[chat-providers] Codex catalog background refresh failed", expect.stringMatching(/^[A-Za-z]+$/)));
    await expect(f.source(codexProvider, alice)).resolves.toMatchObject({ defaultModel: "model-a" });
    expect(f.attempts).toHaveLength(2);
    at(CODEX_CATALOG_STALE_WINDOW_MS);
    await expect(f.source(codexProvider, alice)).rejects.toThrow();
    await expect(f.source(codexProvider, alice)).rejects.toThrow("unavailable");
    expect(f.attempts).toHaveLength(3);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("/synthetic");
  });

  it("does not resurrect a stale entry evicted by the owner cap", async () => {
    const f = await staleFixture();
    for (let index = 0; index < 64; index++) await f.source(codexProvider, { userId: `fixture_${index}`, source: "jwt" });
    f.setModel("model-b");
    await expect(f.source(codexProvider, alice)).resolves.toMatchObject({ defaultModel: "model-b" });
    expect(f.attempts).toHaveLength(66);
  });

  it("labels stale reads in send timings", async () => {
    const f = await staleFixture();
    f.setModel(undefined);
    const lines: string[] = [];
    vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => { lines.push(String(args[1])); });
    await createChatSendTimer("req_stale").run(() => f.source(codexProvider, alice));
    expect(lines.map((line) => (JSON.parse(line) as { result?: string }).result)).toEqual(["stale_hit"]);
    f.attempts[1]!.reply("model-b");
  });
});
