import { createComposerChoiceStore, MAX_REMEMBERED_COMPUTERS } from "@/lib/remembered-composer-choice";

const STORAGE_KEY = "matrix_os_composer_choice_v1";
const GPT_HIGH = { instanceId: "codex_default", model: "gpt-5.6-sol", options: [{ id: "effort", value: "high" }] };
const CLAUDE = { instanceId: "claude_default", model: "claude-opus-5" };

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: jest.fn(async (key: string) => items.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      items.set(key, value);
    }),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("the composer choice remembered on this phone", () => {
  it("is not known until the phone's storage has been read, then is nothing when nothing was saved", async () => {
    const store = createComposerChoiceStore(memoryStorage());

    expect(store.choice("user_a:alice:primary")).toBeUndefined();
    await store.load();

    expect(store.choice("user_a:alice:primary")).toBeNull();
  });

  it("is kept for each account and computer, and read back after the app restarts", async () => {
    const storage = memoryStorage();
    const store = createComposerChoiceStore(storage);
    await store.load();

    store.remember("user_a:alice:primary", { selection: GPT_HIGH });
    store.remember("user_a:bob:primary", { selection: CLAUDE });
    await flush();

    const restarted = createComposerChoiceStore(storage);
    await restarted.load();
    expect(restarted.choice("user_a:alice:primary")).toEqual({ selection: GPT_HIGH });
    expect(restarted.choice("user_a:bob:primary")).toEqual({ selection: CLAUDE });
    expect(restarted.choice("user_b:alice:primary")).toBeNull();
  });

  it("keeps the other parts of a choice when one part is changed", async () => {
    const store = createComposerChoiceStore(memoryStorage());
    await store.load();

    store.remember("user_a:alice:primary", { selection: GPT_HIGH, laterField: "kept" } as never);
    store.remember("user_a:alice:primary", { selection: CLAUDE });

    expect(store.choice("user_a:alice:primary")).toEqual({ selection: CLAUDE, laterField: "kept" });
  });

  it("waits for the saved choices before saving one made while they were still being read", async () => {
    const storage = memoryStorage({
      [STORAGE_KEY]: JSON.stringify({ entries: [{ scope: "user_a:bob:primary", choice: { selection: CLAUDE } }] }),
    });
    const store = createComposerChoiceStore(storage);

    store.remember("user_a:alice:primary", { selection: GPT_HIGH });
    await flush();

    const restarted = createComposerChoiceStore(storage);
    await restarted.load();
    expect(restarted.choice("user_a:bob:primary")).toEqual({ selection: CLAUDE });
    expect(restarted.choice("user_a:alice:primary")).toEqual({ selection: GPT_HIGH });
  });

  it(`remembers at most ${MAX_REMEMBERED_COMPUTERS} computers, dropping the one chosen for longest ago`, async () => {
    const store = createComposerChoiceStore(memoryStorage());
    await store.load();

    for (let index = 0; index <= MAX_REMEMBERED_COMPUTERS; index += 1) {
      store.remember(`user_a:computer${index}:primary`, { selection: CLAUDE });
    }

    expect(store.choice("user_a:computer0:primary")).toBeNull();
    expect(store.choice(`user_a:computer${MAX_REMEMBERED_COMPUTERS}:primary`)).toEqual({ selection: CLAUDE });
  });

  it("ignores what it cannot read as a choice, keeping the entries it can", async () => {
    const storage = memoryStorage({
      [STORAGE_KEY]: JSON.stringify({ entries: [
        { scope: "user_a:alice:primary", choice: { selection: { instanceId: 42 } } },
        { scope: "user_a:bob:primary", choice: { selection: CLAUDE } },
      ] }),
    });
    const store = createComposerChoiceStore(storage);
    await store.load();

    expect(store.choice("user_a:alice:primary")).toBeNull();
    expect(store.choice("user_a:bob:primary")).toEqual({ selection: CLAUDE });
  });

  it("starts with nothing remembered when the phone's storage cannot be read, and says why without details", async () => {
    const storage = memoryStorage({ [STORAGE_KEY]: "{not json" });
    const store = createComposerChoiceStore(storage);
    await store.load();

    expect(store.choice("user_a:alice:primary")).toBeNull();
    expect(console.warn).toHaveBeenCalledWith("[mobile] remembered composer choice unavailable", "SyntaxError");
  });

  it("keeps the choice for this session when it cannot be saved", async () => {
    const storage = memoryStorage();
    storage.setItem.mockRejectedValue(new Error("disk full"));
    const store = createComposerChoiceStore(storage);
    await store.load();

    store.remember("user_a:alice:primary", { selection: CLAUDE });
    await flush();

    expect(store.choice("user_a:alice:primary")).toEqual({ selection: CLAUDE });
    expect(console.warn).toHaveBeenCalledWith("[mobile] composer choice could not be remembered", "Error");
  });

  it("tells whoever is listening when a choice changes", async () => {
    const store = createComposerChoiceStore(memoryStorage());
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);
    await store.load();
    listener.mockClear();

    store.remember("user_a:alice:primary", { selection: CLAUDE });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.remember("user_a:alice:primary", { selection: GPT_HIGH });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
