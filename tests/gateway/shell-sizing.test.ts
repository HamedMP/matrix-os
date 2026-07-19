import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createSessionSizing } from "../../packages/gateway/src/shell/sizing.js";

describe("shell session sizing arbiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function harness(options: { initial?: { cols: number; rows: number } | null } = {}) {
    const applied: Array<{ cols: number; rows: number }> = [];
    const persisted: Array<{ cols: number; rows: number }> = [];
    const sizing = createSessionSizing({
      initialSize: options.initial ?? null,
      debounceMs: 10,
      onApply: (size) => {
        applied.push(size);
      },
      persist: (size) => {
        persisted.push(size);
      },
    });
    return { sizing, applied, persisted };
  }

  it("uses the component-wise minimum across hard clients", async () => {
    const { sizing, applied } = harness();
    sizing.attach("a", "hard", { cols: 200, rows: 50 });
    sizing.attach("b", "hard", { cols: 190, rows: 60 });
    await vi.advanceTimersByTimeAsync(20);

    expect(sizing.current()).toEqual({ cols: 190, rows: 50 });
    expect(applied.at(-1)).toEqual({ cols: 190, rows: 50 });
  });

  it("soft clients never influence the canonical size", async () => {
    const { sizing, applied } = harness();
    sizing.attach("desktop", "hard", { cols: 200, rows: 50 });
    await vi.advanceTimersByTimeAsync(20);
    const before = sizing.current();

    sizing.attach("phone", "soft", { cols: 60, rows: 30 });
    sizing.declared("phone", { cols: 40, rows: 20 });
    await vi.advanceTimersByTimeAsync(20);

    expect(sizing.current()).toEqual(before);
    expect(applied.at(-1)).toEqual(before);
  });

  it("legacy resizes pass through only while no classified client is attached", async () => {
    const { sizing } = harness();
    sizing.attach("old-web", "legacy", { cols: 100, rows: 30 });
    expect(sizing.legacyResizeAllowed()).toBe(true);

    sizing.attach("new-cli", "hard", { cols: 200, rows: 50 });
    expect(sizing.legacyResizeAllowed()).toBe(false);

    sizing.detach("new-cli");
    expect(sizing.legacyResizeAllowed()).toBe(true);
  });

  it("recomputes when a hard client detaches and persists the result", async () => {
    const { sizing, persisted } = harness();
    sizing.attach("small", "hard", { cols: 100, rows: 30 });
    sizing.attach("big", "hard", { cols: 200, rows: 50 });
    await vi.advanceTimersByTimeAsync(20);
    expect(sizing.current()).toEqual({ cols: 100, rows: 30 });

    sizing.detach("small");
    await vi.advanceTimersByTimeAsync(20);
    expect(sizing.current()).toEqual({ cols: 200, rows: 50 });
    expect(persisted.at(-1)).toEqual({ cols: 200, rows: 50 });
  });

  it("pins soft-only sessions to the persisted size, never the soft viewport", async () => {
    const { sizing, applied } = harness({ initial: { cols: 150, rows: 40 } });
    sizing.attach("phone", "soft", { cols: 60, rows: 30 });
    await vi.advanceTimersByTimeAsync(20);

    expect(sizing.current()).toEqual({ cols: 150, rows: 40 });
    // the soft client's pty is pinned to canonical (FR-009), not its viewport
    expect(applied).toEqual([{ cols: 150, rows: 40 }]);
  });

  it("debounces rapid attach/detach churn into one application", async () => {
    const { sizing, applied } = harness();
    sizing.attach("a", "hard", { cols: 200, rows: 50 });
    sizing.attach("b", "hard", { cols: 190, rows: 48 });
    sizing.detach("b");
    sizing.attach("c", "hard", { cols: 180, rows: 45 });
    await vi.advanceTimersByTimeAsync(20);

    expect(applied).toHaveLength(1);
    expect(applied[0]).toEqual({ cols: 180, rows: 45 });
  });

  it("clamps declared sizes to protocol bounds", async () => {
    const { sizing } = harness();
    sizing.attach("weird", "hard", { cols: 9_999, rows: 0 });
    await vi.advanceTimersByTimeAsync(20);
    const size = sizing.current();
    expect(size!.cols).toBeLessThanOrEqual(500);
    expect(size!.rows).toBeGreaterThanOrEqual(1);
  });

  it("cancels a pending apply when the last classified client detaches", async () => {
    const { sizing, applied, persisted } = harness();
    sizing.attach("cli", "hard", { cols: 120, rows: 40 });
    sizing.detach("cli"); // detach before the debounce fires
    await vi.advanceTimersByTimeAsync(50);

    expect(applied).toEqual([]);
    expect(persisted).toEqual([]);
  });

  it("dispose cancels pending applications", async () => {
    const { sizing, applied } = harness();
    sizing.attach("a", "hard", { cols: 200, rows: 50 });
    sizing.dispose();
    await vi.advanceTimersByTimeAsync(50);
    expect(applied).toEqual([]);
  });
});
