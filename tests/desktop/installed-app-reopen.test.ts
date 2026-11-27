import { describe, expect, it, vi } from "vitest";
import {
  createInstalledAppReopen,
  MAX_REOPEN_APPS,
  REOPEN_CONCURRENCY,
  REOPEN_TTL_MS,
  reopenEach,
} from "@desktop/main/installed-apps/reopen";

const id = (index: number) => `6f1c2a4e-2b7d-4c1a-9f3e-${index.toString(16).padStart(12, "0")}`;

function memoryStore() {
  let value: unknown = null;
  return {
    get: vi.fn(async () => value as never),
    set: vi.fn(async (next: unknown) => { value = next; }),
    delete: vi.fn(async () => { value = null; }),
    peek: () => value,
  };
}

describe("reopening installed apps after a restart", () => {
  it("reopens the apps that were open at quit, once", async () => {
    const store = memoryStore();
    let now = 1_000_000;
    const reopen = createInstalledAppReopen({ store, now: () => now });
    await reopen.save([id(1), id(2), id(1)]);
    expect(store.peek()).toEqual({ savedAt: 1_000_000, installIds: [id(1), id(2)] });
    now += REOPEN_TTL_MS - 1;
    expect(await reopen.take()).toEqual([id(1), id(2)]);
    expect(await reopen.take()).toEqual([]);
  });

  it("forgets apps closed more than 15 minutes ago, or saved in the future", async () => {
    const store = memoryStore();
    let now = 1_000_000;
    const reopen = createInstalledAppReopen({ store, now: () => now });
    await reopen.save([id(1)]);
    now += REOPEN_TTL_MS + 1;
    expect(await reopen.take()).toEqual([]);
    await reopen.save([id(1)]);
    now -= 60_000;
    expect(await reopen.take()).toEqual([]);
  });

  it("caps the list and drops anything that is not an install id", async () => {
    const store = memoryStore();
    const reopen = createInstalledAppReopen({ store, now: () => 5 });
    await reopen.save([...Array.from({ length: 40 }, (_, index) => id(index)), "../notes"]);
    expect((store.peek() as { installIds: string[] }).installIds).toHaveLength(MAX_REOPEN_APPS);
    expect(await reopen.take()).toHaveLength(MAX_REOPEN_APPS);
  });

  it("clears the saved list when nothing was open", async () => {
    const store = memoryStore();
    const reopen = createInstalledAppReopen({ store, now: () => 5 });
    await reopen.save([]);
    expect(store.delete).toHaveBeenCalledOnce();
  });

  it("treats an unreadable saved list as nothing to reopen", async () => {
    const reopen = createInstalledAppReopen({
      store: { get: async () => { throw new Error("disk"); }, set: async () => undefined, delete: async () => undefined },
      now: () => 5,
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await reopen.take()).toEqual([]);
    vi.restoreAllMocks();
  });

  it("opens at most four apps at a time and survives a failing one", async () => {
    let active = 0;
    let peak = 0;
    const opened: string[] = [];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await reopenEach(Array.from({ length: 10 }, (_, index) => id(index)), async (installId) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((settle) => setTimeout(settle, 5));
      active -= 1;
      if (installId === id(3)) throw new Error("boom");
      opened.push(installId);
    });
    expect(peak).toBe(REOPEN_CONCURRENCY);
    expect(opened).toHaveLength(9);
    vi.restoreAllMocks();
  });
});
