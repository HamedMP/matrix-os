import { QueryClient, type QueryKey } from "@tanstack/react-query";

import { createQueryPersistence, type PersistedQueryKind } from "../lib/query-persistence";

const CHATS_SLOT = "matrix_os_query_cache_v1:chats";
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-05T12:00:00.000Z");

const chatsKey = (userId: string) => ["mobile", "chats", userId, "computer"] as const;

/** A chat-list-shaped kind: `["mobile", "chats", userId, computerKey]` holding `{ items: string[] }`. */
const chatsKind: PersistedQueryKind = {
  id: "chats",
  ownerOf: (queryKey: QueryKey) => (
    queryKey.length === 4 && queryKey[1] === "chats" && typeof queryKey[2] === "string" ? queryKey[2] : null
  ),
  parse: (data) => {
    const items = (data as { items?: unknown }).items;
    if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) throw new Error("Invalid chat list");
    return { items: items as string[] };
  },
};

/** AsyncStorage stand-in. Only ever holds the one slot these tests write. */
function memoryStorage(initial: Record<string, string> = {}) {
  const values: Record<string, string> = { ...initial };
  return {
    values,
    getItem: jest.fn(async (key: string) => values[key] ?? null),
    setItem: jest.fn(async (key: string, value: string) => { values[key] = value; }),
    removeItem: jest.fn(async (key: string) => { delete values[key]; }),
  };
}

function saved(userId: string, items: unknown, updatedAt = NOW - 60_000) {
  return JSON.stringify({ userId, queryKey: chatsKey(userId), updatedAt, data: { items } });
}

function setup(initial: Record<string, string> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const storage = memoryStorage(initial);
  const persistence = createQueryPersistence({ queryClient, storage, kinds: [chatsKind], now: () => NOW });
  return { queryClient, storage, persistence };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("restore", () => {
  it("loads a saved query as stale data, so the screen shows it and still refetches", async () => {
    const { queryClient, persistence } = setup({ [CHATS_SLOT]: saved("user_a", ["chat_1"]) });

    await persistence.restore();

    expect(queryClient.getQueryData(chatsKey("user_a"))).toEqual({ items: ["chat_1"] });
    expect(queryClient.getQueryState(chatsKey("user_a"))?.dataUpdatedAt).toBe(NOW - 60_000);
    queryClient.clear();
  });

  it("drops a saved query that no longer fits the schema", async () => {
    const { queryClient, storage, persistence } = setup({ [CHATS_SLOT]: saved("user_a", [{ id: "old shape" }]) });

    await persistence.restore();

    expect(queryClient.getQueryData(chatsKey("user_a"))).toBeUndefined();
    expect((CHATS_SLOT in storage.values)).toBe(false);
  });

  it("drops a saved query that is not valid JSON", async () => {
    const { queryClient, storage, persistence } = setup({ [CHATS_SLOT]: "{not json" });

    await persistence.restore();

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect((CHATS_SLOT in storage.values)).toBe(false);
  });

  it("drops a saved query older than a week", async () => {
    const { queryClient, storage, persistence } = setup({
      [CHATS_SLOT]: saved("user_a", ["chat_1"], NOW - 8 * DAY_MS),
    });

    await persistence.restore();

    expect(queryClient.getQueryData(chatsKey("user_a"))).toBeUndefined();
    expect((CHATS_SLOT in storage.values)).toBe(false);
  });

  it("drops a saved query whose key belongs to a different user than it claims", async () => {
    const forged = JSON.stringify({
      userId: "user_a", queryKey: chatsKey("user_b"), updatedAt: NOW - 1_000, data: { items: ["chat_1"] },
    });
    const { queryClient, storage, persistence } = setup({ [CHATS_SLOT]: forged });

    await persistence.restore();

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect((CHATS_SLOT in storage.values)).toBe(false);
  });

  it("keeps a result fetched before the restore finished", async () => {
    const { queryClient, persistence } = setup({ [CHATS_SLOT]: saved("user_a", ["chat_old"]) });
    queryClient.setQueryData(chatsKey("user_a"), { items: ["chat_fresh"] }, { updatedAt: NOW });

    await persistence.restore();

    expect(queryClient.getQueryData(chatsKey("user_a"))).toEqual({ items: ["chat_fresh"] });
    queryClient.clear();
  });

  it("carries on when storage cannot be read", async () => {
    const { queryClient, storage, persistence } = setup();
    storage.getItem.mockRejectedValue(new Error("storage unavailable"));

    await expect(persistence.restore()).resolves.toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
});

describe("saving", () => {
  it("saves a signed-in user's query once per burst of updates", async () => {
    const { queryClient, storage, persistence } = setup();
    await persistence.setOwner("user_a");
    const stop = persistence.start();

    queryClient.setQueryData(chatsKey("user_a"), { items: ["chat_1"] });
    queryClient.setQueryData(chatsKey("user_a"), { items: ["chat_1", "chat_2"] });
    await jest.advanceTimersByTimeAsync(1_000);

    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.values[CHATS_SLOT]!)).toMatchObject({
      userId: "user_a", queryKey: chatsKey("user_a"), data: { items: ["chat_1", "chat_2"] },
    });
    stop();
    queryClient.clear();
  });

  it("saves nothing before the signed-in user is known", async () => {
    const { queryClient, storage, persistence } = setup();
    const stop = persistence.start();

    queryClient.setQueryData(chatsKey("user_a"), { items: ["chat_1"] });
    await jest.advanceTimersByTimeAsync(1_000);

    expect(storage.setItem).not.toHaveBeenCalled();
    stop();
    queryClient.clear();
  });

  it("saves nothing for a user other than the one signed in", async () => {
    const { queryClient, storage, persistence } = setup();
    await persistence.setOwner("user_a");
    const stop = persistence.start();

    queryClient.setQueryData(chatsKey("user_b"), { items: ["chat_1"] });
    await jest.advanceTimersByTimeAsync(1_000);

    expect(storage.setItem).not.toHaveBeenCalled();
    stop();
    queryClient.clear();
  });

  it("ignores queries that are not a persisted kind", async () => {
    const { queryClient, storage, persistence } = setup();
    await persistence.setOwner("user_a");
    const stop = persistence.start();

    queryClient.setQueryData(["mobile", "chats", "detail", "user_a", "computer", "chat_1"], { messages: [] });
    await jest.advanceTimersByTimeAsync(1_000);

    expect(storage.setItem).not.toHaveBeenCalled();
    stop();
    queryClient.clear();
  });

  it("does not write back what it has just restored", async () => {
    const { queryClient, storage, persistence } = setup({ [CHATS_SLOT]: saved("user_a", ["chat_1"]) });
    await persistence.setOwner("user_a");
    const stop = persistence.start();

    await persistence.restore();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(storage.setItem).not.toHaveBeenCalled();
    stop();
    queryClient.clear();
  });

  it("removes the saved copy rather than keep an outdated one when a result is too large", async () => {
    const { queryClient, storage, persistence } = setup({ [CHATS_SLOT]: saved("user_a", ["chat_1"]) });
    await persistence.setOwner("user_a");
    const stop = persistence.start();

    queryClient.setQueryData(chatsKey("user_a"), { items: ["x".repeat(600 * 1024)] });
    await jest.advanceTimersByTimeAsync(1_000);

    expect(storage.setItem).not.toHaveBeenCalled();
    expect((CHATS_SLOT in storage.values)).toBe(false);
    stop();
    queryClient.clear();
  });

  it("stops saving once stopped", async () => {
    const { queryClient, storage, persistence } = setup();
    await persistence.setOwner("user_a");
    const stop = persistence.start();

    queryClient.setQueryData(chatsKey("user_a"), { items: ["chat_1"] });
    stop();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(storage.setItem).not.toHaveBeenCalled();
    queryClient.clear();
  });
});

describe("setOwner", () => {
  it("removes everything saved when the user signs out", async () => {
    const { queryClient, storage, persistence } = setup({ [CHATS_SLOT]: saved("user_a", ["chat_1"]) });
    await persistence.restore();

    await persistence.setOwner(null);

    expect((CHATS_SLOT in storage.values)).toBe(false);
    expect(queryClient.getQueryData(chatsKey("user_a"))).toBeUndefined();
  });

  it("removes another user's restored data when someone else is signed in", async () => {
    const { queryClient, storage, persistence } = setup({ [CHATS_SLOT]: saved("user_a", ["chat_1"]) });
    await persistence.restore();

    await persistence.setOwner("user_b");

    expect((CHATS_SLOT in storage.values)).toBe(false);
    expect(queryClient.getQueryData(chatsKey("user_a"))).toBeUndefined();
  });

  it("removes what the previous user saved in this session when someone else signs in", async () => {
    const { queryClient, storage, persistence } = setup();
    await persistence.setOwner("user_a");
    const stop = persistence.start();
    queryClient.setQueryData(chatsKey("user_a"), { items: ["chat_1"] });
    await jest.advanceTimersByTimeAsync(1_000);
    expect((CHATS_SLOT in storage.values)).toBe(true);

    await persistence.setOwner("user_b");

    expect((CHATS_SLOT in storage.values)).toBe(false);
    expect(queryClient.getQueryData(chatsKey("user_a"))).toBeUndefined();
    stop();
    queryClient.clear();
  });

  it("does not leave a write that was still in flight when the user changed", async () => {
    const { queryClient, storage, persistence } = setup();
    await persistence.setOwner("user_a");
    const stop = persistence.start();
    let finishWrite: () => void = () => undefined;
    storage.setItem.mockImplementationOnce(async (key: string, value: string) => {
      await new Promise<void>((resolve) => { finishWrite = resolve; });
      storage.values[key] = value;
    });
    queryClient.setQueryData(chatsKey("user_a"), { items: ["chat_1"] });
    await jest.advanceTimersByTimeAsync(1_000);

    const switching = persistence.setOwner("user_b");
    await jest.advanceTimersByTimeAsync(0);
    finishWrite();
    await switching;

    expect((CHATS_SLOT in storage.values)).toBe(false);
    stop();
    queryClient.clear();
  });

  it("keeps the new user's entry when the previous user's write lands late", async () => {
    const { queryClient, storage, persistence } = setup();
    await persistence.setOwner("user_a");
    const stop = persistence.start();
    let finishWrite: () => void = () => undefined;
    storage.setItem.mockImplementationOnce(async (key: string, value: string) => {
      await new Promise<void>((resolve) => { finishWrite = resolve; });
      storage.values[key] = value;
    });
    queryClient.setQueryData(chatsKey("user_a"), { items: ["chat_a"] });
    await jest.advanceTimersByTimeAsync(1_000);

    const switching = persistence.setOwner("user_b");
    await jest.advanceTimersByTimeAsync(0);
    queryClient.setQueryData(chatsKey("user_b"), { items: ["chat_b"] });
    await jest.advanceTimersByTimeAsync(1_000);
    finishWrite();
    await switching;
    await jest.advanceTimersByTimeAsync(0);

    expect(JSON.parse(storage.values[CHATS_SLOT]!)).toMatchObject({ userId: "user_b", data: { items: ["chat_b"] } });
    stop();
    queryClient.clear();
  });

  it("restores first when the owner is set before anything was restored", async () => {
    const { queryClient, storage, persistence } = setup({ [CHATS_SLOT]: saved("user_a", ["chat_1"]) });

    await persistence.setOwner("user_a");

    expect((CHATS_SLOT in storage.values)).toBe(true);
    expect(queryClient.getQueryData(chatsKey("user_a"))).toEqual({ items: ["chat_1"] });
    queryClient.clear();
  });

  it("keeps the signed-in user's own restored data", async () => {
    const { queryClient, storage, persistence } = setup({ [CHATS_SLOT]: saved("user_a", ["chat_1"]) });
    await persistence.restore();

    await persistence.setOwner("user_a");

    expect((CHATS_SLOT in storage.values)).toBe(true);
    expect(queryClient.getQueryData(chatsKey("user_a"))).toEqual({ items: ["chat_1"] });
    queryClient.clear();
  });

  it("does not let a restore still in flight bring back another user's data", async () => {
    const { queryClient, storage, persistence } = setup({ [CHATS_SLOT]: saved("user_a", ["chat_1"]) });

    const restoring = persistence.restore();
    await persistence.setOwner("user_b");
    await restoring;

    expect(queryClient.getQueryData(chatsKey("user_a"))).toBeUndefined();
    expect((CHATS_SLOT in storage.values)).toBe(false);
  });
});
