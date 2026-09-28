import { describe, expect, it } from "vitest";
import {
  decidePrune,
  referencedKeysToSkip,
  validatePlanForApply,
} from "../../scripts/host-bundle-prune.mjs";

const now = Date.parse("2026-09-28T00:00:00Z");
const old = "2026-05-01T00:00:00Z";
const tarball = (version: string) => `system-bundles/${version}/matrix-host-bundle.tar.gz`;
const manifest = (version: string) => `system-bundles/${version}/incremental-manifest.json`;
const object = (key: string, modified = old) => ({ key, size: 10, modified: new Date(modified) });
const release = (version: string, channel: string | null, createdAt = old, withManifest = false) => ({
  version, channel, created_at: createdAt, bundle_key: tarball(version), checksum_key: null,
  incremental_manifest_key: withManifest ? manifest(version) : null,
});

function baseInput(overrides: Partial<Parameters<typeof decidePrune>[0]> = {}) {
  return {
    now, keepPerChannel: 2, keepRecentDays: 14, pinned: [] as string[], fleetVersions: [] as string[],
    releases: [
      release("v1", "stable"), release("v2", "stable"), release("v3", "stable"),
      release("v-machine", "dev"), release("v-snapshot", "dev"), release("v-pr", null),
      release("v-recent", null, "2026-09-25T00:00:00Z"),
    ],
    channels: [{ channel: "stable", version: "v3" }],
    history: [{ channel: "stable", version: "v3" }, { channel: "stable", version: "v2" }],
    machines: [{ image_version: "v-machine", target_bundle_version: null }],
    jobs: [], leases: [],
    snapshots: [{ bundle_version: "v-snapshot", state: "ready" }],
    objects: ["v1", "v2", "v3", "v-machine", "v-snapshot", "v-pr", "v-recent"].map((v) => object(tarball(v))),
    ...overrides,
  };
}

describe("host bundle prune plan", () => {
  it("keeps referenced, recent and pinned versions and deletes the rest", () => {
    const plan = decidePrune(baseInput({ pinned: ["v1"], fleetVersions: [] }));
    const decisions = Object.fromEntries(plan.report.map((row) => [row.version, row.decision]));
    expect(decisions).toEqual({
      v1: "KEEP", v2: "KEEP", v3: "KEEP", "v-machine": "KEEP", "v-snapshot": "KEEP", "v-recent": "KEEP", "v-pr": "DELETE",
    });
    expect(plan.deleteKeys).toEqual([tarball("v-pr")]);
  });

  it("keeps live fleet versions and versions of unfinished jobs and active leases", () => {
    const plan = decidePrune(baseInput({
      fleetVersions: ["v1"], jobs: [{ target_bundle_version: "v-pr" }],
    }));
    expect(plan.deleteKeys).toEqual([]);
    const lease = decidePrune(baseInput({ leases: [{ target_bundle_version: "v-pr" }] }));
    expect(lease.deleteKeys).not.toContain(tarball("v-pr"));
  });

  it("keeps a recent orphaned upload and deletes an old one", () => {
    const plan = decidePrune(baseInput({ objects: [
      ...baseInput().objects, object(tarball("orphan-old")), object(tarball("orphan-new"), "2026-09-27T00:00:00Z"),
    ] }));
    expect(plan.deleteKeys).toContain(tarball("orphan-old"));
    expect(plan.deleteKeys).not.toContain(tarball("orphan-new"));
  });

  it("never deletes keys a kept release references, and leaves unrecognized paths alone", () => {
    const plan = decidePrune(baseInput({
      releases: [...baseInput().releases, { ...release("v-shared", "stable"), bundle_key: tarball("v-pr") }],
      history: [...baseInput().history, { channel: "stable", version: "v-shared" }],
      objects: [...baseInput().objects, object("system-bundles/channels/stable.json")],
    }));
    expect(plan.deleteKeys).not.toContain(tarball("v-pr"));
    expect(plan.unrecognized.map((item) => item.key)).toEqual(["system-bundles/channels/stable.json"]);
  });

  it("deletes shared objects only when no kept manifest lists them", () => {
    const shared = (sha: string) => object(`system-bundles/objects/sha256/${sha}`);
    const input = baseInput({
      releases: baseInput().releases.map((row) => row.version === "v3" ? release("v3", "stable", old, true) : row),
      objects: [...baseInput().objects, shared("aaa"), shared("zzz")],
    });
    expect(decidePrune(input, { manifestShas: new Map([["v3", ["aaa"]]]) }).deleteKeys)
      .toContain("system-bundles/objects/sha256/zzz");
    expect(decidePrune(input, { manifestShas: new Map([["v3", ["aaa"]]]) }).deleteKeys)
      .not.toContain("system-bundles/objects/sha256/aaa");
    const failSafe = decidePrune(input, { manifestShas: new Map([["v3", null]]) });
    expect(failSafe.deleteKeys.filter((key) => key.includes("/objects/"))).toEqual([]);
  });

  it("refuses a plan that would delete every version", () => {
    expect(() => decidePrune(baseInput({ channels: [], history: [], machines: [], snapshots: [],
      releases: [release("v-pr", null)], objects: [object(tarball("v-pr"))] }))).toThrow("every version");
  });

  it("warns about channel pointers with no objects", () => {
    const plan = decidePrune(baseInput({ channels: [{ channel: "stable", version: "v3" }, { channel: "beta", version: "gone" }] }));
    expect(plan.missingPointers).toEqual(["beta=gone"]);
  });
});

describe("host bundle prune apply checks", () => {
  const plan = { bucket: "bundles", generatedAt: "2026-09-27T12:00:00Z", keepPerChannel: 3,
    deleteKeys: [tarball("v-pr"), "system-bundles/objects/sha256/zzz"] };

  it("requires a fresh plan for the same bucket and an exact key-count confirmation", () => {
    expect(() => validatePlanForApply(plan, { bucket: "bundles", confirm: "2", now })).not.toThrow();
    expect(() => validatePlanForApply(plan, { bucket: "other", confirm: "2", now })).toThrow("bucket");
    expect(() => validatePlanForApply(plan, { bucket: "bundles", confirm: "1", now })).toThrow("CONFIRM_DELETE_KEYS=2");
    expect(() => validatePlanForApply(plan, { bucket: "bundles", confirm: "2", now: now + 25 * 3_600_000 })).toThrow("old");
  });

  it("rejects keys outside system-bundles or with path traversal", () => {
    for (const key of ["backups/user/db.dump", "system-bundles/../x", "system-bundles//x"]) {
      expect(() => validatePlanForApply({ ...plan, deleteKeys: [key] }, { bucket: "bundles", confirm: "1", now }))
        .toThrow("unsafe key");
    }
  });

  it("skips keys whose version became referenced after planning", () => {
    expect(referencedKeysToSkip(plan.deleteKeys, new Set(["v-pr"]))).toEqual([tarball("v-pr")]);
    expect(referencedKeysToSkip(plan.deleteKeys, new Set(["zzz"]))).toEqual([]);
  });
});
