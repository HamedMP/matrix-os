import { describe, expect, it } from "vitest";
import {
  AppStoreCatalogQuerySchema,
  AppStoreCreateSubmissionSchema,
  AppStoreListingActionSchema,
  AppStoreManifestSchema,
  AppStoreReviewDecisionSchema,
  AppStoreSlugSchema,
  capabilitiesDigest,
  compareSemver,
  compareStoreStorage,
  deriveAppStoreCapabilities,
  parseSemver,
} from "../../packages/contracts/src/app-store";

const baseManifest = {
  name: "Habit Garden",
  slug: "habit-garden",
  description: "Track habits with a garden that grows.",
  version: "1.2.0",
  runtime: "vite",
  runtimeVersion: "^1.0.0",
  build: { command: "pnpm build", output: "dist" },
  integrations: {
    required: [{ service: "gmail", actions: ["list_messages"] }],
    optional: [{ service: "google_calendar", actions: ["list_events", "create_event"] }],
  },
  permissions: ["ai"],
  storage: { tables: { habits: { columns: { title: "text", streak: "integer" }, indexes: ["title"] } } },
};

describe("AppStoreManifestSchema", () => {
  it("accepts a clean vite manifest", () => {
    expect(AppStoreManifestSchema.parse(baseManifest).name).toBe("Habit Garden");
  });

  it.each([
    ["listingTrust", { listingTrust: "first_party" }],
    ["hidden", { hidden: true }],
    ["serve", { serve: { start: "node server.js" } }],
    ["distributionStatus", { distributionStatus: "installable" }],
    ["unknown", { telemetryKey: "x" }],
  ])("rejects forbidden field %s", (_name, extra) => {
    expect(AppStoreManifestSchema.safeParse({ ...baseManifest, ...extra }).success).toBe(false);
  });

  it("requires the vite runtime and a strict semver", () => {
    expect(AppStoreManifestSchema.safeParse({ ...baseManifest, runtime: "node" }).success).toBe(false);
    expect(AppStoreManifestSchema.safeParse({ ...baseManifest, version: "1.2" }).success).toBe(false);
    expect(AppStoreManifestSchema.safeParse({ ...baseManifest, version: "01.2.0" }).success).toBe(false);
  });

  it("rejects unknown permissions and duplicate integrations", () => {
    expect(AppStoreManifestSchema.safeParse({ ...baseManifest, permissions: ["matrix.projects"] }).success).toBe(false);
    expect(AppStoreManifestSchema.safeParse({
      ...baseManifest,
      integrations: { required: [{ service: "gmail", actions: ["a"] }], optional: [{ service: "gmail", actions: ["b"] }] },
    }).success).toBe(false);
    expect(AppStoreManifestSchema.safeParse({
      ...baseManifest,
      integrations: { required: [{ service: "gmail", actions: ["a", "a"] }] },
    }).success).toBe(false);
  });

  it("rejects undeclared index columns and unknown column types", () => {
    expect(AppStoreManifestSchema.safeParse({
      ...baseManifest,
      storage: { tables: { habits: { columns: { title: "text" }, indexes: ["missing"] } } },
    }).success).toBe(false);
    expect(AppStoreManifestSchema.safeParse({
      ...baseManifest,
      storage: { tables: { habits: { columns: { title: "varchar" } } } },
    }).success).toBe(false);
  });

  it("rejects more than eight integrations", () => {
    const required = Array.from({ length: 9 }, (_, i) => ({ service: `svc_${i}`, actions: ["read"] }));
    expect(AppStoreManifestSchema.safeParse({ ...baseManifest, integrations: { required } }).success).toBe(false);
  });
});

describe("capabilities", () => {
  it("derives sorted capabilities from the manifest", () => {
    const capabilities = deriveAppStoreCapabilities(AppStoreManifestSchema.parse(baseManifest));
    expect(capabilities).toEqual({
      integrations: {
        required: [{ service: "gmail", actions: ["list_messages"] }],
        optional: [{ service: "google_calendar", actions: ["create_event", "list_events"] }],
      },
      permissions: ["ai"],
      tables: [{ name: "habits", columns: ["streak", "title"] }],
    });
  });

  it("produces a digest that ignores key order", async () => {
    const a = deriveAppStoreCapabilities(AppStoreManifestSchema.parse(baseManifest));
    const reordered = { tables: a.tables, permissions: a.permissions, integrations: { optional: a.integrations.optional, required: a.integrations.required } };
    expect(await capabilitiesDigest(a)).toMatch(/^[a-f0-9]{64}$/);
    expect(await capabilitiesDigest(reordered)).toBe(await capabilitiesDigest(a));
    expect(await capabilitiesDigest({ ...a, permissions: [] })).not.toBe(await capabilitiesDigest(a));
  });
});

describe("compareStoreStorage", () => {
  const previous = { tables: { habits: { columns: { title: "text", streak: "integer" } } } };

  it("allows additive changes", () => {
    expect(compareStoreStorage(previous, {
      tables: {
        habits: { columns: { title: "text", streak: "int", note: "text" }, indexes: ["note"] },
        logs: { columns: { at: "timestamptz" } },
      },
    })).toEqual({ ok: true, issues: [] });
  });

  it("refuses removed tables, removed columns and type changes", () => {
    expect(compareStoreStorage(previous, { tables: {} }).issues).toContain("table_removed:habits");
    expect(compareStoreStorage(previous, { tables: { habits: { columns: { title: "text" } } } }).issues)
      .toContain("column_removed:habits.streak");
    expect(compareStoreStorage(previous, { tables: { habits: { columns: { title: "jsonb", streak: "integer" } } } }).issues)
      .toContain("column_type_changed:habits.title");
  });

  it("treats a missing previous storage as additive", () => {
    expect(compareStoreStorage(undefined, previous).ok).toBe(true);
  });
});

describe("semver helpers", () => {
  it("parses and orders versions", () => {
    expect(parseSemver("2.10.3")).toEqual({ major: 2, minor: 10, patch: 3 });
    expect(parseSemver("2.10")).toBeNull();
    expect(compareSemver("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("0.9.0", "1.0.0")).toBeLessThan(0);
  });
});

describe("request schemas", () => {
  it("validates slugs", () => {
    expect(AppStoreSlugSchema.safeParse("habit-garden").success).toBe(true);
    for (const bad of ["ab", "1abc", "Habit", "habit_garden", "a".repeat(49)]) {
      expect(AppStoreSlugSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("bounds catalog queries", () => {
    expect(AppStoreCatalogQuerySchema.parse({})).toEqual({ sort: "popular", limit: 24 });
    expect(AppStoreCatalogQuerySchema.parse({ limit: "10", sort: "rating" })).toMatchObject({ limit: 10, sort: "rating" });
    expect(AppStoreCatalogQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
    expect(AppStoreCatalogQuerySchema.safeParse({ q: "x".repeat(81) }).success).toBe(false);
    expect(AppStoreCatalogQuerySchema.safeParse({ category: "weapons" }).success).toBe(false);
  });

  it("requires messages for request_changes and reject", () => {
    expect(AppStoreReviewDecisionSchema.safeParse({ type: "approve" }).success).toBe(true);
    expect(AppStoreReviewDecisionSchema.safeParse({ type: "retry_build" }).success).toBe(false);
    expect(AppStoreReviewDecisionSchema.safeParse({ type: "reject" }).success).toBe(false);
    expect(AppStoreReviewDecisionSchema.safeParse({ type: "request_changes", message: " " }).success).toBe(false);
    expect(AppStoreReviewDecisionSchema.safeParse({ type: "publish", message: "x" }).success).toBe(false);
    expect(AppStoreListingActionSchema.safeParse({ type: "suspend", message: "Policy" }).success).toBe(true);
    expect(AppStoreListingActionSchema.safeParse({ type: "delete", message: "x" }).success).toBe(false);
  });

  it("validates submissions", () => {
    const submission = {
      submissionKey: "alice:4b0e3f4e-7d2c-4f8f-8a7b-2f6f0d3a1b9c:1.2.0",
      listing: { slug: "habit-garden", name: "Habit Garden", tagline: "Grow habits", description: "Track habits.", category: "lifestyle" },
      version: "1.2.0",
      changelog: "First release",
      license: "MIT",
      manifest: baseManifest,
      source: { sha256: "a".repeat(64), size: 1024 },
      generalizationReport: { ai: "completed", changes: [{ category: "secret", file: "src/api.ts", summary: "Moved API key to settings" }] },
    };
    expect(AppStoreCreateSubmissionSchema.safeParse(submission).success).toBe(true);
    expect(AppStoreCreateSubmissionSchema.safeParse({ ...submission, license: "WTFPL" }).success).toBe(false);
    expect(AppStoreCreateSubmissionSchema.safeParse({ ...submission, source: { sha256: "a".repeat(64), size: 17 * 1024 * 1024 } }).success).toBe(false);
    expect(AppStoreCreateSubmissionSchema.safeParse({ ...submission, authorId: "someone-else" }).success).toBe(false);
  });
});
