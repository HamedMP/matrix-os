/**
 * The Company Brain change bus: per-scope queues that coalesce, listeners in reaction order after emit returns, a
 * budget per listener, bounded queues, a drain with a deadline on close, and the erase helper.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  BRAIN_HOOK_DOCUMENT_IDS_MAX, BRAIN_HOOK_QUEUE_MAX_SCOPES, type BrainChangeEvent, type BrainChangeListener,
  type BrainChangeListenerName,
} from "../../packages/gateway/src/brain/contracts.js";
import {
  BRAIN_HOOK_QUEUE_HARD_MAX_SCOPES, createBrainChangeHooks, eraseBrainScope,
} from "../../packages/gateway/src/brain/hooks.js";
import type { BrainScopeKey } from "../../packages/gateway/src/brain/index.js";

const AT = "2026-10-01T10:00:00.000Z";
const scope = (n: number | string): BrainScopeKey => ({ ownerId: "owner_a", scopeId: `scope_${n}` });
const documents = (s: BrainScopeKey, ids: readonly string[] | null, sourceId: string | null = "src_a"):
  BrainChangeEvent => ({ type: "documents_changed", scope: s, sourceId, documentIds: ids, at: AT });
const claims = (s: BrainScopeKey, ids: readonly string[] | null = null): BrainChangeEvent =>
  ({ type: "claims_changed", scope: s, extractor: "rules/v1", documentIds: ids, at: AT });
const erased = (s: BrainScopeKey): BrainChangeEvent => ({ type: "scope_erased", scope: s, at: AT });

interface Recorded { readonly name: BrainChangeListenerName; readonly event: BrainChangeEvent; readonly signal: AbortSignal }

function recorder(handle?: (name: BrainChangeListenerName, event: BrainChangeEvent, signal: AbortSignal) => Promise<void>) {
  const calls: Recorded[] = [];
  const listener = (name: BrainChangeListenerName): BrainChangeListener => ({
    name,
    handle: async (event, signal) => {
      calls.push({ name, event, signal });
      await handle?.(name, event, signal);
    },
  });
  return { calls, listeners: [listener("search"), listener("graph"), listener("brief")] };
}

/** Lets the worker run every queued scope. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("brain change hooks", () => {
  let errorLog: MockInstance<typeof console.error>;
  let warnLog: MockInstance<typeof console.warn>;
  beforeEach(() => {
    errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    warnLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    errorLog.mockRestore();
    warnLog.mockRestore();
  });

  it("runs the reacting listeners in order after emit returns, one scope at a time", async () => {
    const { calls, listeners } = recorder();
    const hooks = createBrainChangeHooks({ listeners: [...listeners].reverse() });
    hooks.emit(documents(scope(1), ["d1"]));
    hooks.emit(erased(scope(2)));
    expect(calls).toEqual([]);
    await settle();
    expect(calls.map((call) => `${call.name}:${call.event.type}:${call.event.scope.scopeId}`)).toEqual([
      // The brief listener purges stored briefs that cite a tombstoned document.
      "search:documents_changed:scope_1", "graph:documents_changed:scope_1", "brief:documents_changed:scope_1",
      "search:scope_erased:scope_2", "graph:scope_erased:scope_2", "brief:scope_erased:scope_2",
    ]);
    hooks.emit(claims(scope(1)));
    await settle();
    expect(calls.slice(6).map((call) => call.name)).toEqual(["search", "graph"]);
    await hooks.close(1_000);
  });

  it("coalesces a scope's queued events: ids merge, unknown or too many become null, an erase supersedes", async () => {
    const { calls, listeners } = recorder();
    const hooks = createBrainChangeHooks({ listeners: listeners.filter((listener) => listener.name === "search") });
    hooks.emit(documents(scope(1), ["d1", "d2"]));
    hooks.emit(documents(scope(1), ["d2", "d3"]));
    hooks.emit(claims(scope(1), ["d9"]));
    hooks.emit(documents(scope(2), ["d1"], "src_a"));
    hooks.emit(documents(scope(2), null, "src_b"));
    hooks.emit(claims(scope(2), ["d1"]));
    hooks.emit(claims(scope(2), Array.from({ length: BRAIN_HOOK_DOCUMENT_IDS_MAX }, (_, i) => `x${i}`)));
    hooks.emit(documents(scope(3), ["d1"]));
    hooks.emit(erased(scope(3)));
    hooks.emit(documents(scope(3), ["d4"]));
    await settle();
    expect(calls.map((call) => call.event)).toEqual([
      documents(scope(1), ["d1", "d2", "d3"]),
      claims(scope(1), ["d9"]),
      documents(scope(2), null, null),
      claims(scope(2), null),
      erased(scope(3)),
      documents(scope(3), ["d4"]),
    ]);
    await hooks.close(1_000);
  });

  it("logs a failing listener by error name and keeps running the others", async () => {
    const brief = vi.fn(async () => undefined);
    const hooks = createBrainChangeHooks({
      listeners: [
        { name: "search", handle: async () => { throw new RangeError("secret detail"); } },
        { name: "graph", handle: () => { throw new TypeError("thrown before a promise"); } },
        { name: "brief", handle: brief },
      ],
    });
    hooks.emit(erased(scope(1)));
    await settle();
    const odd = createBrainChangeHooks({ listeners: [{ name: "search", handle: () => Promise.reject("plain text") }] });
    odd.emit(documents(scope(1), null));
    await odd.close(1_000);
    expect(errorLog.mock.calls).toEqual([
      ["[brain-hooks] search failed:", "RangeError"],
      ["[brain-hooks] graph failed:", "TypeError"],
      ["[brain-hooks] search failed:", "string"],
    ]);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("secret");
    expect(brief).toHaveBeenCalledTimes(1);
    await hooks.close(1_000);
  });

  it("leaves a listener behind at its budget and aborts its signal", async () => {
    const seen: AbortSignal[] = [];
    const { calls, listeners } = recorder(async (name, _event, signal) => {
      if (name !== "search") return;
      seen.push(signal);
      await new Promise<void>(() => undefined);
    });
    const hooks = createBrainChangeHooks({ listeners, listenerBudgetMs: 20 });
    hooks.emit(documents(scope(1), ["d1"]));
    await vi.waitFor(() => expect(calls.map((call) => call.name)).toEqual(["search", "graph", "brief"]));
    expect(seen[0]?.aborted).toBe(true);
    await hooks.close(1_000);
  });

  it("collapses the oldest scope past the bound; past the hard bound an erase evicts a change-only scope", async () => {
    const { calls, listeners } = recorder();
    const hooks = createBrainChangeHooks({ listeners: listeners.filter((listener) => listener.name === "graph") });
    hooks.emit(erased(scope(0)));
    hooks.emit(documents(scope(0), ["d0"]));
    for (let i = 1; i < BRAIN_HOOK_QUEUE_MAX_SCOPES; i += 1) hooks.emit(documents(scope(i), [`d${i}`]));
    hooks.emit(documents(scope("over"), ["d"]));
    for (let i = BRAIN_HOOK_QUEUE_MAX_SCOPES; i < BRAIN_HOOK_QUEUE_HARD_MAX_SCOPES - 1; i += 1) {
      hooks.emit(documents(scope(i), ["d"]));
    }
    hooks.emit(documents(scope("dropped"), ["d"]));
    hooks.emit(erased(scope("kept")));
    expect(warnLog).toHaveBeenCalledWith("[brain-hooks] queue full; event dropped until the next refresh:", "documents_changed");
    expect(warnLog)
      .toHaveBeenCalledWith("[brain-hooks] queue full; a queued scope's change events dropped for an erase");
    await settle();
    await vi.waitFor(() => expect(calls).toHaveLength(BRAIN_HOOK_QUEUE_HARD_MAX_SCOPES + 1));
    // scope_0 holds an erase, so scope_1 (the oldest scope with only change events) made room for the new erase.
    expect(calls.slice(0, 3).map((call) => call.event)).toEqual([
      erased(scope(0)), documents(scope(0), null), documents(scope(2), ["d2"]),
    ]);
    const scopes = calls.map((call) => call.event.scope.scopeId);
    expect(scopes).not.toContain("scope_1");
    expect(scopes).not.toContain("scope_dropped");
    expect(scopes.at(-1)).toBe("scope_kept");
    await hooks.close(1_000);
  });

  it("never queues more scopes than the hard bound, erases included", async () => {
    const { calls, listeners } = recorder();
    const hooks = createBrainChangeHooks({ listeners: listeners.filter((listener) => listener.name === "brief") });
    for (let i = 0; i < BRAIN_HOOK_QUEUE_HARD_MAX_SCOPES + 3; i += 1) hooks.emit(erased(scope(i)));
    hooks.emit(documents(scope("late"), ["d"]));
    // An erase of a scope already queued takes no new room.
    hooks.emit(erased(scope(0)));
    const dropped = ["[brain-hooks] queue full of erases; scope_erased dropped"];
    expect(errorLog.mock.calls).toEqual([dropped, dropped, dropped]);
    await settle();
    await vi.waitFor(() => expect(calls).toHaveLength(BRAIN_HOOK_QUEUE_HARD_MAX_SCOPES));
    const scopes = calls.map((call) => call.event.scope.scopeId);
    expect(new Set(scopes).size).toBe(BRAIN_HOOK_QUEUE_HARD_MAX_SCOPES);
    expect(scopes.at(-1)).toBe(`scope_${BRAIN_HOOK_QUEUE_HARD_MAX_SCOPES - 1}`);
    expect(scopes).not.toContain(`scope_${BRAIN_HOOK_QUEUE_HARD_MAX_SCOPES}`);
    expect(scopes).not.toContain("scope_late");
    await hooks.close(1_000);
  });

  it("drains queued events on close, then drops later events; a stuck listener ends at the deadline", async () => {
    const { calls, listeners } = recorder();
    const hooks = createBrainChangeHooks({ listeners });
    hooks.emit(documents(scope(1), ["d1"]));
    await hooks.close(1_000);
    expect(calls.map((call) => call.name)).toEqual(["search", "graph", "brief"]);
    hooks.emit(documents(scope(1), ["d2"]));
    await settle();
    expect(calls).toHaveLength(3);
    expect(warnLog).toHaveBeenCalledWith("[brain-hooks] event after close dropped:", "documents_changed");

    const stuck: AbortSignal[] = [];
    const blocked = createBrainChangeHooks({
      listeners: [{ name: "search", handle: (_event, signal) => {
        stuck.push(signal);
        return new Promise<void>(() => undefined);
      } }],
    });
    blocked.emit(documents(scope(1), ["d1"]));
    blocked.emit(documents(scope(2), ["d1"]));
    await vi.waitFor(() => expect(stuck).toHaveLength(1));
    await blocked.close(20);
    expect(stuck[0]?.aborted).toBe(true);
    expect(warnLog).toHaveBeenCalledWith("[brain-hooks] closed before the queue drained; the next refresh repairs it");
    await settle();
    expect(stuck).toHaveLength(1);
  });

  it("runs an event emitted while the worker drains, from a listener or after the queue emptied", async () => {
    const hooks = createBrainChangeHooks({
      listeners: [{ name: "search", handle: async (event) => {
        seen.push(event.scope.scopeId);
        if (event.scope.scopeId === "scope_1") hooks.emit(documents(scope(2), ["d2"]));
      } }],
    });
    const seen: string[] = [];
    hooks.emit(documents(scope(1), ["d1"]));
    await vi.waitFor(() => expect(seen).toEqual(["scope_1", "scope_2"]));
    hooks.emit(documents(scope(3), ["d3"]));
    await vi.waitFor(() => expect(seen).toEqual(["scope_1", "scope_2", "scope_3"]));
    await hooks.close(1_000);
  });

  it("refuses two listeners with one name", () => {
    const { listeners } = recorder();
    expect(() => createBrainChangeHooks({ listeners: [listeners[0]!, listeners[0]!] }))
      .toThrow("Duplicate brain change listener: search");
  });

  it("erases the scope first, then announces it; a failed erase announces nothing", async () => {
    const order: string[] = [];
    const hooks = { emit: vi.fn((event: BrainChangeEvent) => { order.push(event.type); }), close: vi.fn() };
    const repository = { eraseScope: vi.fn(async () => { order.push("erase"); }) };
    await eraseBrainScope(repository, hooks, scope(1), () => new Date(AT));
    expect(order).toEqual(["erase", "scope_erased"]);
    expect(hooks.emit).toHaveBeenCalledWith(erased(scope(1)));

    await eraseBrainScope(repository, hooks, scope(3));
    expect(hooks.emit).toHaveBeenLastCalledWith({ type: "scope_erased", scope: scope(3), at: expect.any(String) });
    repository.eraseScope.mockRejectedValueOnce(new Error("store down"));
    await expect(eraseBrainScope(repository, hooks, scope(2))).rejects.toThrow("store down");
    expect(hooks.emit).toHaveBeenCalledTimes(2);
  });
});
