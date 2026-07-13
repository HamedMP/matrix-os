import {
  MAX_SCROLLBACK_CHARS,
  MAX_SCROLLBACK_SESSIONS,
  appendScrollback,
  clearAllScrollback,
  clearScrollback,
  getScrollback,
  resetScrollback,
} from "@/lib/terminal-scrollback";

describe("terminal scrollback cache", () => {
  beforeEach(() => {
    clearAllScrollback();
  });

  it("accumulates output per session and returns undefined for unknown sessions", () => {
    appendScrollback("main", "hello ");
    appendScrollback("main", "world");
    expect(getScrollback("main")).toBe("hello world");
    expect(getScrollback("other")).toBeUndefined();
  });

  it("keeps only the most recent MAX_SCROLLBACK_CHARS characters", () => {
    appendScrollback("main", "A".repeat(MAX_SCROLLBACK_CHARS));
    appendScrollback("main", "B".repeat(1000));
    const cached = getScrollback("main");
    expect(cached).toHaveLength(MAX_SCROLLBACK_CHARS);
    expect(cached?.endsWith("B".repeat(1000))).toBe(true);
    expect(cached?.startsWith("B")).toBe(false);
  });

  it("caps at MAX_SCROLLBACK_SESSIONS, evicting the least-recently-used", () => {
    for (let i = 0; i < MAX_SCROLLBACK_SESSIONS; i += 1) {
      appendScrollback(`s${i}`, `data-${i}`);
    }
    // Touch the oldest so it is no longer the LRU victim.
    expect(getScrollback("s0")).toBe("data-0");
    // Adding one more evicts s1 (now the least-recently-used), not s0.
    appendScrollback("overflow", "new");
    expect(getScrollback("s1")).toBeUndefined();
    expect(getScrollback("s0")).toBe("data-0");
    expect(getScrollback("overflow")).toBe("new");
  });

  it("resetScrollback replaces the buffer with the authoritative value", () => {
    appendScrollback("main", "stale preview");
    resetScrollback("main", "authoritative replay");
    expect(getScrollback("main")).toBe("authoritative replay");
  });

  it("clearScrollback drops one session and clearAllScrollback empties the cache", () => {
    appendScrollback("a", "one");
    appendScrollback("b", "two");
    clearScrollback("a");
    expect(getScrollback("a")).toBeUndefined();
    expect(getScrollback("b")).toBe("two");
    clearAllScrollback();
    expect(getScrollback("b")).toBeUndefined();
  });

  it("ignores empty session ids and empty chunks", () => {
    appendScrollback("", "ignored");
    appendScrollback("main", "");
    expect(getScrollback("")).toBeUndefined();
    expect(getScrollback("main")).toBeUndefined();
  });
});
