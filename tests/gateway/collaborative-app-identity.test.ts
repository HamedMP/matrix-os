import { describe, expect, it } from "vitest";

import {
  CollaborativeAppIdentityError,
  createCollaborativeAppBuildIdentity,
} from "../../packages/gateway/src/collaboration/collaborative-app-identity.js";

const catalogId = "50000000-0000-4000-8000-000000000001";
const base = {
  appId: "team-tracker",
  catalogId,
  registrationIncarnation: "a".repeat(64),
  manifestVersion: "1.0.0",
  manifest: { slug: "team-tracker", version: "1.0.0", runtime: "vite" },
  declaredSchema: { tables: [{ name: "tasks", columns: ["id", "title", "done"] }] },
  assetDigest: "b".repeat(64),
  bridgeContractVersion: "matrix-app-bridge-v1",
  runtimeAbi: "matrix-runtime-v1",
};

describe("collaborative app exact build identity", () => {
  it("is deterministic across object key order and carries bounded exact inputs", () => {
    const first = createCollaborativeAppBuildIdentity(base);
    const second = createCollaborativeAppBuildIdentity({
      ...base,
      manifest: { runtime: "vite", version: "1.0.0", slug: "team-tracker" },
      declaredSchema: { tables: [{ columns: ["id", "title", "done"], name: "tasks" }] },
    });
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      appId: base.appId,
      catalogId,
      registrationIncarnation: base.registrationIncarnation,
      manifestVersion: "1.0.0",
      assetDigest: base.assetDigest,
      bridgeContractVersion: base.bridgeContractVersion,
      runtimeAbi: base.runtimeAbi,
    });
    for (const digest of [first.buildId, first.manifestDigest, first.schemaDigest]) {
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("does not reattach a same-slug replacement", () => {
    const original = createCollaborativeAppBuildIdentity(base);
    const replacement = createCollaborativeAppBuildIdentity({
      ...base,
      registrationIncarnation: "c".repeat(64),
    });
    expect(replacement.appId).toBe(original.appId);
    expect(replacement.catalogId).toBe(original.catalogId);
    expect(replacement.buildId).not.toBe(original.buildId);
  });

  it.each([
    ["manifest", { manifest: { ...base.manifest, version: "1.0.1" }, manifestVersion: "1.0.1" }],
    ["schema", { declaredSchema: { tables: [{ name: "tasks", columns: ["id", "title", "done", "assignee"] }] } }],
    ["assets", { assetDigest: "d".repeat(64) }],
    ["bridge contract", { bridgeContractVersion: "matrix-app-bridge-v2" }],
    ["runtime ABI", { runtimeAbi: "matrix-runtime-v2" }],
  ])("changes the build id after %s drift", (_label, drift) => {
    expect(createCollaborativeAppBuildIdentity({ ...base, ...drift }).buildId)
      .not.toBe(createCollaborativeAppBuildIdentity(base).buildId);
  });

  it("rejects unbounded, non-JSON, and malformed identity inputs", () => {
    for (const invalid of [
      { ...base, catalogId: "not-a-uuid" },
      { ...base, registrationIncarnation: "mutable" },
      { ...base, assetDigest: "invalid" },
      { ...base, manifestVersion: "v".repeat(129) },
      { ...base, manifest: { value: BigInt(1) } },
      { ...base, manifest: { value: "x".repeat(257 * 1024) } },
      { ...base, declaredSchema: { value: "x".repeat(257 * 1024) } },
    ]) {
      expect(() => createCollaborativeAppBuildIdentity(invalid as never)).toThrow(CollaborativeAppIdentityError);
    }
  });
});
