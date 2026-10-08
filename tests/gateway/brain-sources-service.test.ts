import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrainApiError } from "../../packages/gateway/src/brain/api/types.js";
import {
  BrainFeatureError, type BrainAnySourceKindHandler, type BrainIntegrationService,
} from "../../packages/gateway/src/brain/contracts.js";
import { BrainStoreError } from "../../packages/gateway/src/brain/types.js";
import {
  createBrainSourceKindRegistry, createBrainSourcesService, runBrainSourceSync, type BrainSourcesCoreDeps,
} from "../../packages/gateway/src/brain/sources/core/index.js";
import { createBrainSourcesConnectQueue } from "../../packages/gateway/src/brain/sources/core/registry.js";
import {
  fakeHandler, gate, OWNER, SCOPE_A, SCOPE_B, sourcesHarness, type FakeHandler, type SourcesHarness,
} from "./helpers/brain-sources-fixture.js";

let harness: SourcesHarness;
beforeEach(async () => {
  harness = await sourcesHarness();
});
afterEach(async () => {
  await harness.destroy();
  vi.restoreAllMocks();
});

function service(handlers: BrainAnySourceKindHandler[], extra: Partial<BrainSourcesCoreDeps> = {}) {
  return createBrainSourcesService({
    repository: harness.repository, resolver: harness.resolver, handlers, runner: runBrainSourceSync, hooks: harness.hooks,
    ...extra,
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  if (error instanceof BrainFeatureError || error instanceof BrainApiError || error instanceof BrainStoreError) return error.code;
  throw new Error(`expected a coded error, got ${String(error)}`);
}

const accountsOf = (labels: readonly string[]) =>
  vi.fn(async (_owner: string, _service: BrainIntegrationService) => labels);

describe("kind registry", () => {
  it("keeps one handler per connectable kind and refuses duplicates and unknown kinds", () => {
    const registry = createBrainSourceKindRegistry([fakeHandler("linear"), fakeHandler("matrix_notes")]);
    expect(registry.kinds).toEqual(["matrix_notes", "linear"]);
    expect(registry.get("linear")?.kind).toBe("linear");
    for (const kind of ["git", "github", "slack", "__proto__", "toString"]) expect(registry.get(kind)).toBeNull();
    expect(() => createBrainSourceKindRegistry([fakeHandler("linear"), fakeHandler("linear")])).toThrow(TypeError);
    expect(() => createBrainSourceKindRegistry([{ ...fakeHandler("linear"), kind: "git" } as never])).toThrow(TypeError);
  });

  it("runs queued work one at a time per key, caps the keys and drops a key when its work settles", async () => {
    const run = createBrainSourcesConnectQueue(1);
    const held = gate();
    const order: string[] = [];
    const first = run("a", async () => { await held.wait; order.push("first"); return 1; });
    const second = run("a", async () => { order.push("second"); return 2; });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await codeOf(run("b", async () => 3))).toBe("brain_unavailable");
    held.open();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(order).toEqual(["first", "second"]);
    await expect(run("a", async () => { throw new Error("work failed"); })).rejects.toThrow("work failed");
    expect(await run("b", async () => 4)).toBe(4);
  });
});

describe("connect", () => {
  it("runs parse, identify, check, create and save in order, then answers the same source without changing it", async () => {
    const handler = fakeHandler("matrix_notes");
    const sources = service([handler]);
    const first = await sources.connect(OWNER, "alpha", { kind: "matrix_notes", config: { items: ["b", "a"] } });
    expect(handler.calls).toEqual(["parse", "identify", "check", "save", "load"]);
    expect(first).toMatchObject({
      created: true,
      source: {
        kind: "matrix_notes", label: "Fake b, a", externalRef: null, status: "active", revision: 1,
        config: { items: ["b", "a"], accountLabel: null }, lastSync: null,
      },
    });
    handler.calls.length = 0;
    const again = await sources.connect(OWNER, "proj_a", { kind: "matrix_notes", config: { items: ["a", "b"], includeEventBodies: true }, label: "Other" });
    expect(again).toMatchObject({ created: false, source: { sourceId: first.source.sourceId, label: "Fake b, a" } });
    expect(handler.calls).toEqual(["parse", "identify", "check", "load", "load"]);
    expect([...handler.configs.values()]).toEqual([{ items: ["b", "a"] }]);
  });

  it("saves the config of a source whose earlier connect never stored one", async () => {
    const handler = fakeHandler("matrix_notes");
    const { source } = await harness.repository.createSource(SCOPE_A, { kind: "matrix_notes", externalRef: "matrix_notes:a:", label: "x" });
    const result = await service([handler]).connect(OWNER, "proj_a", { kind: "matrix_notes", config: { items: ["a"] } });
    expect(result).toMatchObject({ created: false, source: { sourceId: source.sourceId, config: { items: ["a"] } } });
  });

  it("leaves no live source when the pre-check or the config save refuses, or the label is taken by a cap", async () => {
    const refusing = fakeHandler("github", { checkConfig: async () => { throw new BrainFeatureError("source_conflict"); } });
    expect(await codeOf(service([refusing]).connect(OWNER, "proj_a", { kind: "github", config: { items: ["r"] } }))).toBe("source_conflict");
    expect(refusing.calls).not.toContain("save");
    const saving = fakeHandler("github", { saveConfig: async () => { throw new BrainFeatureError("source_conflict"); } });
    expect(await codeOf(service([saving]).connect(OWNER, "proj_a", { kind: "github", config: { items: ["r"] } }))).toBe("source_conflict");
    expect(await harness.liveSources()).toEqual([]);
    const failing = fakeHandler("linear", { saveConfig: async () => { throw new Error("disk"); } });
    const deleteSource = vi.spyOn(harness.repository, "deleteSource").mockRejectedValueOnce(new Error("down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(service([failing]).connect(OWNER, "proj_a", { kind: "linear", config: { items: ["x"] } })).rejects.toThrow("disk");
    expect(deleteSource).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("[brain-sources] connect rollback failed:", "Error");
  });

  it("keeps each kind within its cap, also when connects race in one process or across two", async () => {
    const sources = service([fakeHandler("github")]);
    await sources.connect(OWNER, "proj_a", { kind: "github", config: { items: ["one"] } });
    expect(await codeOf(sources.connect(OWNER, "proj_a", { kind: "github", config: { items: ["two"] } }))).toBe("source_conflict");
    expect((await sources.connect(OWNER, "proj_a", { kind: "github", config: { items: ["one"] } })).created).toBe(false);

    // One process: the second connect waits for the first and then sees it.
    const local = vi.spyOn(harness.repository, "createSource");
    const queued = await Promise.allSettled([
      sources.connect(OWNER, "proj_b", { kind: "github", config: { items: ["left"] } }),
      sources.connect(OWNER, "proj_b", { kind: "github", config: { items: ["right"] } }),
    ]);
    expect(queued.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(local).toHaveBeenCalledOnce();
    local.mockRestore();

    // Two processes: both pass the pre-check, the later create sees the earlier one and removes itself.
    const both = gate();
    const firstDone = gate();
    let arrived = 0;
    const createSource = harness.repository.createSource.bind(harness.repository);
    vi.spyOn(harness.repository, "createSource").mockImplementation(async (scope, input) => {
      arrived += 1;
      if (arrived === 1) {
        await both.wait;
        const created = await createSource(scope, input);
        firstDone.open();
        return created;
      }
      both.open();
      await firstDone.wait;
      harness.tick();
      return createSource(scope, input);
    });
    const other = service([fakeHandler("github")]);
    const results = await Promise.allSettled([
      sources.connect("owner_b", "proj_c", { kind: "github", config: { items: ["left"] } }),
      other.connect("owner_b", "proj_c", { kind: "github", config: { items: ["right"] } }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(((results[1] as PromiseRejectedResult).reason as BrainFeatureError).code).toBe("source_conflict");
    expect(await harness.liveSources({ ownerId: "owner_b", scopeId: "personal:project:proj_c" })).toHaveLength(1);
  });

  it("refuses unavailable and unknown kinds before parsing", async () => {
    const off = fakeHandler("linear", { availability: async () => ({ available: false, reason: "not_connected" }) });
    const unset = fakeHandler("google_drive", { availability: async () => ({ available: false, reason: "not_configured" }) });
    const sources = service([off, unset]);
    expect(await codeOf(sources.connect(OWNER, "proj_a", { kind: "linear", config: { items: ["a"] } }))).toBe("source_not_connected");
    expect(await codeOf(sources.connect(OWNER, "proj_a", { kind: "google_drive", config: { items: ["a"] } }))).toBe("source_kind_unsupported");
    expect(await codeOf(sources.connect(OWNER, "proj_a", { kind: "slack_bridge", config: {} }))).toBe("source_kind_unsupported");
    expect(await codeOf(sources.connect(OWNER, "proj_a", { kind: "linear" as never, config: { items: ["UPPER"] } })))
      .toBe("source_not_connected");
    expect(off.calls).toEqual([]);
    const slow = fakeHandler("linear", { availability: () => new Promise(() => undefined) });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await codeOf(service([slow], { callTimeoutMs: 100 }).connect(OWNER, "proj_a", { kind: "linear", config: { items: ["a"] } })))
      .toBe("brain_unavailable");
    expect(await codeOf(service([fakeHandler("linear")]).connect(OWNER, "proj_a", { kind: "linear", config: { items: [] } })))
      .toBe("source_config_invalid");
  });
});

describe("account pinning", () => {
  it("pins the owner's only account, keeps a named one and refuses none, unknown or several", async () => {
    const handler = fakeHandler("linear");
    const one = accountsOf(["work"]);
    const pinned = await service([handler], { accounts: one }).connect(OWNER, "proj_a", { kind: "linear", config: { items: ["eng"] } });
    expect(one).toHaveBeenCalledWith(OWNER, "linear");
    expect(pinned.source.config).toEqual({ items: ["eng"], accountLabel: "work" });
    const several = service([handler], { accounts: accountsOf(["work", "home"]) });
    expect(await codeOf(several.connect(OWNER, "proj_a", { kind: "linear", config: { items: ["ops"] } }))).toBe("source_config_invalid");
    const named = await several.connect(OWNER, "proj_a", { kind: "linear", config: { items: ["ops"], accountLabel: "home" } });
    expect(named.source.config).toEqual({ items: ["ops"], accountLabel: "home" });
    expect(await codeOf(several.connect(OWNER, "proj_a", { kind: "linear", config: { items: ["ops"], accountLabel: "gone" } })))
      .toBe("source_not_connected");
    const none = service([handler], { accounts: accountsOf([]) });
    expect(await codeOf(none.connect(OWNER, "proj_a", { kind: "linear", config: { items: ["x"] } }))).toBe("source_not_connected");
  });

  it("skips kinds without an account and GitHub token mode, and bounds the lookup", async () => {
    const accounts = accountsOf(["a", "b"]);
    await service([fakeHandler("matrix_notes")], { accounts }).connect(OWNER, "proj_a", { kind: "matrix_notes", config: { items: ["n"] } });
    await service([fakeHandler("github")], { accounts }).connect(OWNER, "proj_a", { kind: "github", config: { items: ["r"], mode: "token" } });
    expect(accounts).not.toHaveBeenCalled();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hanging = service([fakeHandler("linear")], { accounts: () => new Promise(() => undefined), callTimeoutMs: 100 });
    expect(await codeOf(hanging.connect(OWNER, "proj_a", { kind: "linear", config: { items: ["x"] } }))).toBe("brain_unavailable");
  });
});

describe("update and remove", () => {
  it("changes label and status under the revision and refuses a stale one", async () => {
    const sources = service([fakeHandler("linear")]);
    const { source } = await sources.connect(OWNER, "proj_a", { kind: "linear", config: { items: ["a"] } });
    const paused = await sources.update(OWNER, "proj_a", source.sourceId, { expectedRevision: 1, status: "paused", label: "Mine" });
    expect(paused).toMatchObject({ status: "paused", label: "Mine", revision: 2, config: { items: ["a"] } });
    expect(await codeOf(sources.update(OWNER, "proj_a", source.sourceId, { expectedRevision: 1, status: "active" }))).toBe("revision_conflict");
    expect(await codeOf(sources.update(OWNER, "proj_a", source.sourceId, { expectedRevision: 2 }))).toBe("invalid_request");
  });

  it("leaves the source as it was when its new config cannot be saved", async () => {
    const handler = fakeHandler("linear", {
      saveConfig: async (config) => { if (config.includeEventBodies === true) throw new Error("config save failed"); },
    });
    const sources = service([handler]);
    const { source } = await sources.connect(OWNER, "proj_a", { kind: "linear", config: { items: ["a"] } });
    await expect(sources.update(OWNER, "proj_a", source.sourceId, {
      expectedRevision: 1, label: "Renamed", status: "paused", config: { items: ["a"], includeEventBodies: true },
    })).rejects.toThrow("config save failed");
    expect(await harness.repository.getSource(SCOPE_A, source.sourceId))
      .toMatchObject({ revision: 1, label: source.label, status: "active" });
    expect([...handler.configs.values()]).toEqual([{ items: ["a"] }]);
    // The revision the client holds is still the current one.
    expect((await sources.update(OWNER, "proj_a", source.sourceId, { expectedRevision: 1, label: "Renamed" })).revision).toBe(2);
  });

  it("saves a new config that keeps the identity and the pinned account, and refuses one that changes it", async () => {
    const handler = fakeHandler("linear");
    const sources = service([handler], { accounts: accountsOf(["work"]) });
    const { source } = await sources.connect(OWNER, "proj_a", { kind: "linear", config: { items: ["a"] } });
    const updated = await sources.update(OWNER, "proj_a", source.sourceId, {
      expectedRevision: 1, config: { items: ["a"], includeEventBodies: true },
    });
    expect(updated).toMatchObject({ sourceId: source.sourceId, revision: 2, config: { items: ["a"], accountLabel: "work" } });
    expect([...handler.configs.values()]).toEqual([{ items: ["a"], includeEventBodies: true, accountLabel: "work" }]);
    expect(await codeOf(sources.update(OWNER, "proj_a", source.sourceId, { expectedRevision: 2, config: { items: ["b"] } })))
      .toBe("source_config_invalid");
    expect(await codeOf(sources.update(OWNER, "proj_a", source.sourceId, { expectedRevision: 2, config: { nope: 1 } })))
      .toBe("source_config_invalid");
  });

  it("saves the config of a kind without an account as given, with or without an account lookup", async () => {
    const handler = fakeHandler("matrix_notes");
    const sources = service([handler], { accounts: accountsOf(["work"]) });
    const { source } = await sources.connect(OWNER, "proj_a", { kind: "matrix_notes", config: { items: ["n"] } });
    const updated = await sources.update(OWNER, "proj_a", source.sourceId, {
      expectedRevision: 1, config: { items: ["n"], includeEventBodies: true },
    });
    expect(updated).toMatchObject({ revision: 2, config: { items: ["n"], accountLabel: null } });
    expect([...handler.configs.values()]).toEqual([{ items: ["n"], includeEventBodies: true }]);
  });

  it("replaces a config the schema now refuses and refuses config for git and kinds without a handler", async () => {
    const handler = fakeHandler("linear", { refuseStored: true });
    const sources = service([handler]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { source } = await sources.connect(OWNER, "proj_a", { kind: "linear", config: { items: ["a"] } });
    expect((await sources.list(OWNER, "proj_a")).items[0]!.config).toBeNull();
    expect(warn).toHaveBeenCalledWith("[brain-sources] stored config refused:", "linear");
    expect((await sources.update(OWNER, "proj_a", source.sourceId, { expectedRevision: 1, config: { items: ["a"] } })).revision).toBe(2);
    const git = await harness.repository.createSource(SCOPE_A, { kind: "git", externalRef: "https://github.com/acme/app", label: "App" });
    expect(await codeOf(sources.update(OWNER, "proj_a", git.source.sourceId, { expectedRevision: 1, config: {} })))
      .toBe("source_kind_unsupported");
    expect((await sources.update(OWNER, "proj_a", git.source.sourceId, { expectedRevision: 1, status: "paused" })).status).toBe("paused");
  });

  it("removes and reconnects a calendar source when event bodies are turned off", async () => {
    const handler = fakeHandler("google_calendar");
    const sources = service([handler]);
    const { source } = await sources.connect(OWNER, "proj_a", { kind: "google_calendar", config: { items: ["c"], includeEventBodies: true } });
    const kept = await sources.update(OWNER, "proj_a", source.sourceId, { expectedRevision: 1, config: { items: ["c"], includeEventBodies: true } });
    expect(kept.sourceId).toBe(source.sourceId);
    const fresh = await sources.update(OWNER, "proj_a", source.sourceId, {
      expectedRevision: 2, status: "paused", config: { items: ["c"], includeEventBodies: false },
    });
    expect(fresh).toMatchObject({ status: "paused", revision: 1, label: source.label });
    expect(fresh.sourceId).not.toBe(source.sourceId);
    expect((await harness.liveSources()).map((live) => live.sourceId)).toEqual([fresh.sourceId]);
    expect(harness.hooks.events).toEqual([expect.objectContaining({ type: "documents_changed", sourceId: source.sourceId, documentIds: null })]);
  });

  it("leaves a reconnecting source and its documents as they were when the new config cannot be saved", async () => {
    let refuse = false;
    const handler = fakeHandler("google_calendar", {
      saveConfig: async () => { if (refuse) throw new Error("config save failed"); },
    });
    const sources = service([handler]);
    const bodies = { items: ["c"], includeEventBodies: true };
    const { source } = await sources.connect(OWNER, "proj_a", { kind: "google_calendar", config: bodies });
    expect((await sources.sync(OWNER, "proj_a", source.sourceId)).counts.written).toBe(1);
    const events = harness.hooks.events.length;
    refuse = true;
    const noBodies = { expectedRevision: 1, label: "Renamed", status: "paused", config: { items: ["c"], includeEventBodies: false } } as const;
    await expect(sources.update(OWNER, "proj_a", source.sourceId, noBodies)).rejects.toThrow("config save failed");
    expect((await harness.liveSources()).map((live) => live.sourceId)).toEqual([source.sourceId]);
    expect(await harness.repository.getSource(SCOPE_A, source.sourceId))
      .toMatchObject({ revision: 1, label: source.label, status: "active" });
    expect((await harness.repository.listDocuments(SCOPE_A, { sourceId: source.sourceId })).items).toHaveLength(1);
    expect([...handler.configs.values()]).toEqual([bodies]);
    expect(harness.hooks.events).toHaveLength(events);
    // The revision the client holds is still the current one; the new source keeps the old one's place among its kind.
    refuse = false;
    harness.tick();
    const fresh = await sources.update(OWNER, "proj_a", source.sourceId, noBodies);
    expect(fresh).toMatchObject({ revision: 1, label: "Renamed", status: "paused", createdAt: source.createdAt });
    expect((await harness.liveSources()).map((live) => live.sourceId)).toEqual([fresh.sourceId]);
  });

  it("hands the caller's signal to the run, so a background run's stop ends it between pages", async () => {
    const runner = vi.fn(runBrainSourceSync);
    const sources = service([fakeHandler("linear")], { runner: runner as never });
    const { source } = await sources.connect(OWNER, "proj_a", { kind: "linear", config: { items: ["a"] } });
    const controller = new AbortController();
    await sources.sync(OWNER, "proj_a", source.sourceId, controller.signal);
    expect(runner.mock.lastCall?.[0]).toMatchObject({ signal: controller.signal });
    await sources.sync(OWNER, "proj_a", source.sourceId);
    expect(runner.mock.lastCall?.[0]).not.toHaveProperty("signal");
  });

  it("removes a source with its revision, tombstones its documents and announces it", async () => {
    const sources = service([fakeHandler("linear")]);
    const { source } = await sources.connect(OWNER, "proj_a", { kind: "linear", config: { items: ["a", "b"] } });
    expect((await sources.sync(OWNER, "proj_a", source.sourceId)).counts.written).toBe(2);
    expect((await harness.repository.listDocuments(SCOPE_A, { sourceId: source.sourceId })).items).toHaveLength(2);
    expect(await codeOf(sources.remove(OWNER, "proj_a", source.sourceId, 9))).toBe("conflict");
    const removed = await sources.remove(OWNER, "proj_a", source.sourceId, 1);
    expect(removed).toMatchObject({ sourceId: source.sourceId, revision: 2, config: null, lastSync: null });
    expect((await harness.repository.listDocuments(SCOPE_A, { sourceId: source.sourceId })).items).toEqual([]);
    expect(harness.hooks.events.at(-1)).toMatchObject({ type: "documents_changed", sourceId: source.sourceId, documentIds: null });
    expect(await codeOf(sources.remove(OWNER, "proj_a", source.sourceId, 2))).toBe("source_not_found");
  });
});

describe("list and not found", () => {
  it("lists live sources oldest first with config, last sync and every kind's availability", async () => {
    const handlers = [
      fakeHandler("linear"),
      fakeHandler("google_drive", { availability: async () => ({ available: false, reason: "not_connected" }) }),
      fakeHandler("google_calendar", { availability: async () => { throw new TypeError("lookup"); } }),
      fakeHandler("matrix_notes", { availability: () => new Promise(() => undefined) }),
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sources = service(handlers, { callTimeoutMs: 100, gitSync: vi.fn() });
    await harness.repository.createSource(SCOPE_A, { kind: "git", externalRef: "https://github.com/acme/app", label: "App" });
    harness.tick();
    await harness.repository.createSource(SCOPE_A, { kind: "slack", externalRef: "T/C", label: "Other system" });
    const { source } = await sources.connect(OWNER, "proj_a", { kind: "linear", config: { items: ["a"] } });
    await sources.sync(OWNER, "proj_a", source.sourceId);
    const view = await sources.list(OWNER, "proj_a");
    expect(view.items.map((item) => [item.kind, item.externalRef])).toEqual([["git", "https://github.com/acme/app"], ["linear", null]]);
    expect(view.items[1]).toMatchObject({ config: { items: ["a"] }, lastSync: { status: "succeeded", nextAction: "", errorCode: null } });
    expect(view.kinds).toEqual([
      { kind: "git", available: true, reason: null }, { kind: "github", available: false, reason: "not_configured" },
      { kind: "matrix_notes", available: false, reason: "not_configured" },
      { kind: "matrix_files", available: false, reason: "not_configured" },
      { kind: "matrix_chat", available: false, reason: "not_configured" }, { kind: "linear", available: true, reason: null },
      { kind: "google_drive", available: false, reason: "not_connected" },
      { kind: "google_calendar", available: false, reason: "not_configured" },
      { kind: "slack_bridge", available: false, reason: "not_configured" },
    ]);
    expect(warn).toHaveBeenCalledWith("[brain-sources] google_calendar availability failed:", "TypeError");
    expect(warn).toHaveBeenCalledWith("[brain-sources] matrix_notes availability failed:", "BrainSourcesDeadlineError");
    expect((await service([]).list(OWNER, "proj_a")).kinds[0]).toEqual({ kind: "git", available: false, reason: "not_configured" });
  });

  it("orders by creation time then id, reads every page of sources and lets store failures through", async () => {
    const sources = service([fakeHandler("linear")]);
    const first = await sources.connect(OWNER, "proj_a", { kind: "linear", config: { items: ["a"] } });
    const second = await sources.connect(OWNER, "proj_a", { kind: "linear", config: { items: ["b"] } });
    harness.tick();
    const third = await sources.connect(OWNER, "proj_a", { kind: "linear", config: { items: ["c"] } });
    const sameTime = [first.source.sourceId, second.source.sourceId].sort();
    expect((await sources.list(OWNER, "proj_a")).items.map((item) => item.sourceId)).toEqual([...sameTime, third.source.sourceId]);
    const listSources = harness.repository.listSources.bind(harness.repository);
    const spy = vi.spyOn(harness.repository, "listSources")
      .mockImplementation((scope, options) => listSources(scope, { ...options, limit: 1 }));
    expect((await sources.list(OWNER, "proj_a")).items).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
    const broken = service([fakeHandler("linear", { loadError: new TypeError("store down") })]);
    await expect(broken.list(OWNER, "proj_a")).rejects.toThrow("store down");
  });

  it("answers project_not_found and source_not_found the same way whatever the cause", async () => {
    const sources = service([fakeHandler("linear")]);
    const { source } = await sources.connect(OWNER, "proj_a", { kind: "linear", config: { items: ["a"] } });
    for (const [owner, project] of [["owner_b", "proj_a"], [OWNER, "proj_zz"], [OWNER, "Bad Ref"], ["owner_b", "alpha"]]) {
      expect(await codeOf(sources.list(owner!, project!))).toBe("project_not_found");
      expect(await codeOf(sources.sync(owner!, project!, source.sourceId))).toBe("project_not_found");
    }
    const unknown = await harness.repository.createSource(SCOPE_A, { kind: "slack", externalRef: "T/C", label: "x" });
    const removed = await sources.connect(OWNER, "proj_a", { kind: "linear", config: { items: ["gone"] } });
    await sources.remove(OWNER, "proj_a", removed.source.sourceId, 1);
    for (const id of [`src_${"0".repeat(32)}`, "src_bad", "", unknown.source.sourceId, removed.source.sourceId]) {
      expect(await codeOf(sources.sync(OWNER, "proj_a", id))).toBe("source_not_found");
      expect(await codeOf(sources.receipts(OWNER, "proj_a", id, 5))).toBe("source_not_found");
      expect(await codeOf(sources.update(OWNER, "proj_a", id, { expectedRevision: 1, label: "x" }))).toBe("source_not_found");
      expect(await codeOf(sources.remove(OWNER, "proj_a", id, 1))).toBe("source_not_found");
    }
    expect(await codeOf(sources.sync(OWNER, "proj_b", source.sourceId))).toBe("source_not_found");
  });
});
