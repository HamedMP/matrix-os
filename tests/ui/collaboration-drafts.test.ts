import { describe, expect, it, vi } from "vitest";
import { createDiscussionDraftStore, discussionDraftKey } from "../../packages/ui/src/collaboration/discussion-drafts";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("private collaboration discussion drafts", () => {
  it("isolates drafts by author, runtime, and scope", () => {
    const storage = memoryStorage();
    const store = createDiscussionDraftStore(storage);
    const ada = discussionDraftKey({ actorId: "ada", runtimeId: "owner-vps", scopeId: "scope-a" });
    const nima = discussionDraftKey({ actorId: "nima", runtimeId: "owner-vps", scopeId: "scope-a" });
    store.save(ada, "Ada's note");
    expect(store.load(ada)).toBe("Ada's note");
    expect(store.load(nima)).toBe("");
  });

  it("recovers safely from malformed or oversized persisted state", () => {
    const key = discussionDraftKey({ actorId: "ada", runtimeId: "owner-vps", scopeId: "scope-a" });
    const malformed = memoryStorage({ [key]: "{" });
    expect(createDiscussionDraftStore(malformed).load(key)).toBe("");

    const storage = memoryStorage();
    const store = createDiscussionDraftStore(storage);
    store.save(key, "x".repeat(30_000));
    expect(new TextEncoder().encode(store.load(key)).byteLength).toBeLessThanOrEqual(16 * 1024);

    store.save(key, "€".repeat(20_000));
    const unicodeDraft = store.load(key);
    expect(unicodeDraft.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(unicodeDraft).byteLength).toBeLessThanOrEqual(16 * 1024);
  });

  it("does not let storage cleanup failures escape and reports them safely", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storage = {
      getItem: () => "{",
      setItem: () => undefined,
      removeItem: () => { throw new TypeError("private storage details"); },
    };
    const store = createDiscussionDraftStore(storage);

    expect(() => store.load("draft-key")).not.toThrow();
    expect(() => store.clear("draft-key")).not.toThrow();
    expect(warning).toHaveBeenCalledWith("[collaboration-discussion] invalid draft discarded", "SyntaxError");
    expect(warning).toHaveBeenCalledWith("[collaboration-discussion] draft cleanup unavailable", "TypeError");
    expect(warning.mock.calls.flat().join(" ")).not.toContain("private storage details");
    warning.mockRestore();
  });
});
