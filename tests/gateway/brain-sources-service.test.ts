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
