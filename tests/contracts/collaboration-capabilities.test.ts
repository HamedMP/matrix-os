import {
  COLLABORATION_PRESET_CAPABILITIES,
  CollaborationAudienceSchema,
  CollaborationCapabilityActionSchema,
  CollaborationCreateGrantRequestSchema,
  CollaborationDirectErrorSchema,
  CollaborationEffectiveAccessSchema,
  CollaborationGrantActivationSchema,
  CollaborationGrantSchema,
  CollaborationPatchGrantRequestSchema,
  CollaborationPresetSchema,
  CollaborationReadinessSchema,
  CollaborationResourceKindSchema,
  expandCollaborationPreset,
  readinessItemsForResourceKind,
} from "@matrix-os/contracts";
import { describe, expect, it } from "vitest";

const scopeId = "10000000-0000-4000-8000-000000000001";
const grantId = "40000000-0000-4000-8000-000000000001";
const requestId = "20000000-0000-4000-8000-000000000001";
const now = "2026-09-20T12:00:00.000Z";
const later = "2026-09-27T12:00:00.000Z";
const organizationId = "org_2abcDEF123";

const activeGrant = {
  id: grantId,
  scopeId,
  organizationId,
  audience: { kind: "organization" },
  preset: "contributor",
  state: "active",
  policyVersion: "policy-v1",
  revision: "3",
  createdAt: now,
  updatedAt: now,
};

describe("collaboration capability contracts (S02 T013)", () => {
  it("freezes exactly two presets", () => {
    expect(CollaborationPresetSchema.options).toEqual(["viewer", "contributor"]);
    for (const deferred of ["discussant", "maintainer", "editor", "owner"]) {
      expect(CollaborationPresetSchema.safeParse(deferred).success).toBe(false);
    }
  });

  it("expands presets into an explicit closed action vocabulary", () => {
    const viewer = expandCollaborationPreset("viewer");
    const contributor = expandCollaborationPreset("contributor");
    expect(viewer).toEqual(COLLABORATION_PRESET_CAPABILITIES.viewer);
    expect(contributor).toEqual(COLLABORATION_PRESET_CAPABILITIES.contributor);
    for (const action of ["chat.read", "discussion.read", "files.read", "app.view", "terminal.observe"]) {
      expect(viewer).toContain(action);
      expect(contributor).toContain(action);
    }
    for (const action of ["discussion.post", "ai.submit", "files.write", "app.mutate", "git.commit", "git.push", "git.pr", "terminal.control"]) {
      expect(viewer).not.toContain(action);
      expect(contributor).toContain(action);
    }
    expect(new Set(contributor).size).toBe(contributor.length);
    for (const action of contributor) expect(CollaborationCapabilityActionSchema.safeParse(action).success).toBe(true);
    expect(CollaborationCapabilityActionSchema.safeParse("git.force_push")).toMatchObject({ success: false });
    expect(CollaborationCapabilityActionSchema.safeParse("integrations.delegate")).toMatchObject({ success: false });
    expect(CollaborationCapabilityActionSchema.safeParse("management.transfer")).toMatchObject({ success: false });
  });

  it("freezes six standalone-shareable resource kinds", () => {
    expect(CollaborationResourceKindSchema.options).toEqual(["project", "chat", "terminal", "app_instance", "file", "folder"]);
  });

  it("accepts only organization or current-member audiences", () => {
    expect(CollaborationAudienceSchema.parse({ kind: "organization" })).toEqual({ kind: "organization" });
    expect(CollaborationAudienceSchema.parse({ kind: "member", actorId: "user_2abc" })).toEqual({ kind: "member", actorId: "user_2abc" });
    for (const forged of [
      { kind: "personal", actorId: "user_2abc" },
      { kind: "group", groupId: "grp_1" },
      { kind: "guest", email: "a@b.c" },
      { kind: "organization", organizationId: "org_other" },
      { kind: "member" },
      { kind: "member", actorId: "user_2abc", email: "a@b.c" },
    ]) {
      expect(CollaborationAudienceSchema.safeParse(forged).success).toBe(false);
    }
  });

  it("stores one whole-project preset per grant and rejects selectors, cohorts and departure survival", () => {
    expect(CollaborationGrantSchema.parse(activeGrant)).toMatchObject({ preset: "contributor", audience: { kind: "organization" } });
    expect(CollaborationGrantSchema.parse({ ...activeGrant, expiresAt: later }).expiresAt).toBe(later);
    for (const extra of [
      { selectors: [{ kind: "folder", path: "src" }] },
      { folderIds: ["a"] },
      { appActions: ["mutate"] },
      { commands: ["npm test"] },
      { integrations: ["slack"] },
      { survivesDeparture: true },
      { milestone: "m1" },
      { cohort: "beta" },
      { ceilings: {} },
      { denies: [] },
      { role: "editor" },
    ]) {
      expect(CollaborationGrantSchema.safeParse({ ...activeGrant, ...extra }).success).toBe(false);
    }
    expect(CollaborationGrantSchema.safeParse({ ...activeGrant, organizationId: "user_2abc" }).success).toBe(false);
    expect(CollaborationGrantSchema.safeParse({ ...activeGrant, preset: "maintainer" }).success).toBe(false);
    expect(CollaborationGrantSchema.safeParse({ ...activeGrant, state: "departed_active" }).success).toBe(false);
    expect(CollaborationGrantSchema.safeParse({ ...activeGrant, expiresAt: "2026-09-20" }).success).toBe(false);
  });

  it("models per-member activations for organization-wide grants as active or declined only", () => {
    const activation = {
      grantId,
      actorId: "user_2abc",
      state: "active",
      decidedAt: now,
      membershipEvidenceEpoch: "12",
    };
    expect(CollaborationGrantActivationSchema.parse(activation)).toEqual(activation);
    expect(CollaborationGrantActivationSchema.parse({ ...activation, state: "declined" }).state).toBe("declined");
    expect(CollaborationGrantActivationSchema.safeParse({ ...activation, state: "pending" }).success).toBe(false);
    expect(CollaborationGrantActivationSchema.safeParse({ ...activation, state: "left" }).success).toBe(false);
    expect(CollaborationGrantActivationSchema.safeParse({ ...activation, membershipEvidenceEpoch: -1 }).success).toBe(false);
    expect(CollaborationGrantActivationSchema.safeParse({ ...activation, activatedBy: "user_owner" }).success).toBe(false);
  });

  it("bounds grant mutations to idempotent conditional writes", () => {
    const create = { clientRequestId: requestId, expectedRevision: "3", audience: { kind: "member", actorId: "user_2abc" }, preset: "viewer" };
    expect(CollaborationCreateGrantRequestSchema.parse(create)).toEqual(create);
    expect(CollaborationCreateGrantRequestSchema.parse({ ...create, expiresAt: later }).expiresAt).toBe(later);
    expect(CollaborationCreateGrantRequestSchema.safeParse({ ...create, clientRequestId: "not-a-uuid" }).success).toBe(false);
    expect(CollaborationCreateGrantRequestSchema.safeParse({ ...create, expectedRevision: "3.0" }).success).toBe(false);
    expect(CollaborationCreateGrantRequestSchema.safeParse({ ...create, ownerId: "user_forged" }).success).toBe(false);
    expect(CollaborationCreateGrantRequestSchema.safeParse({ ...create, organizationId: "org_other" }).success).toBe(false);
    const patch = { clientRequestId: requestId, expectedRevision: "3", expectedGrantRevision: "1", preset: "contributor" };
    expect(CollaborationPatchGrantRequestSchema.parse(patch)).toEqual(patch);
    expect(CollaborationPatchGrantRequestSchema.safeParse({ ...patch, audience: { kind: "organization" } }).success).toBe(false);
    expect(CollaborationPatchGrantRequestSchema.safeParse({ clientRequestId: requestId, expectedRevision: "3", expectedGrantRevision: "1" }).success).toBe(false);
  });

  it("reports effective access with safe reasons and a fixed evidence deadline", () => {
    const denied = {
      scopeId,
      actorId: "user_2abc",
      organizationId,
      preset: null,
      actions: [],
      reasons: ["membership_required"],
      evidenceExpiresAt: now,
    };
    expect(CollaborationEffectiveAccessSchema.parse(denied)).toEqual(denied);
    const allowed = { ...denied, preset: "viewer", actions: expandCollaborationPreset("viewer"), reasons: [] };
    expect(CollaborationEffectiveAccessSchema.parse(allowed)).toEqual(allowed);
    expect(CollaborationEffectiveAccessSchema.safeParse({ ...allowed, actions: [...allowed.actions, "git.push"] }).success).toBe(false);
    expect(CollaborationEffectiveAccessSchema.safeParse({ ...denied, preset: "viewer" }).success).toBe(false);
    expect(CollaborationEffectiveAccessSchema.safeParse({ ...denied, reasons: ["postgres connection refused"] }).success).toBe(false);
    expect(CollaborationEffectiveAccessSchema.safeParse({ ...denied, reasons: [] }).success).toBe(false);
  });

  it("scopes readiness items to the shared resource type", () => {
    expect(readinessItemsForResourceKind("project")).toEqual(["ai_source", "submit_mode", "git_identity", "chat_root_inventory"]);
    expect(readinessItemsForResourceKind("chat")).toEqual(["ai_source", "submit_mode", "git_identity", "chat_root_inventory"]);
    for (const kind of ["file", "folder", "app_instance", "terminal"] as const) {
      expect(readinessItemsForResourceKind(kind)).toEqual([]);
    }
    const ready = {
      resourceKind: "project",
      state: "ready",
      missingOwnerSetup: [],
      sourceKind: "owner_account",
      effectiveSubmitMode: "members",
      items: [
        { item: "ai_source", status: "ready" },
        { item: "submit_mode", status: "ready" },
        { item: "git_identity", status: "ready", identityLabel: "Release Bot (service identity)" },
        { item: "chat_root_inventory", status: "ready", chatRootCount: 2, dirtyRootCount: 1 },
      ],
    };
    expect(CollaborationReadinessSchema.parse(ready)).toEqual(ready);
    const setup = { ...ready, state: "owner_setup_needed", missingOwnerSetup: ["forge_credential"], items: ready.items.map((item) => item.item === "git_identity" ? { item: "git_identity", status: "missing" } : item) };
    expect(CollaborationReadinessSchema.parse(setup).missingOwnerSetup).toEqual(["forge_credential"]);
    expect(CollaborationReadinessSchema.safeParse({ ...ready, state: "owner_setup_needed" }).success).toBe(false);
    expect(CollaborationReadinessSchema.safeParse({ ...ready, missingOwnerSetup: ["ai_source"] }).success).toBe(false);
    expect(CollaborationReadinessSchema.safeParse({ ...ready, resourceKind: "file" }).success).toBe(false);
    const fileReady = { resourceKind: "file", state: "ready", missingOwnerSetup: [], items: [] };
    expect(CollaborationReadinessSchema.parse(fileReady)).toEqual(fileReady);
    expect(CollaborationReadinessSchema.safeParse({ ...fileReady, sourceKind: "owner_account" }).success).toBe(false);
    expect(CollaborationReadinessSchema.safeParse({ ...ready, items: [...ready.items, { item: "integration_delegation", status: "ready" }] }).success).toBe(false);
    expect(CollaborationReadinessSchema.safeParse({ ...ready, items: [{ ...ready.items[3], status: "ready", identityLabel: "/home/matrix/.gitconfig" }] }).success).toBe(false);
  });

  it("keeps errors generic", () => {
    expect(CollaborationDirectErrorSchema.parse({ code: "membership_required", safeMessage: "You are not a current member of this organization.", retryable: false })).toMatchObject({ code: "membership_required" });
    expect(CollaborationDirectErrorSchema.parse({ code: "upgrade_required", safeMessage: "Update Matrix OS to continue.", retryable: false }).code).toBe("upgrade_required");
    expect(CollaborationDirectErrorSchema.safeParse({ code: "membership_required", safeMessage: "postgres: relation missing", retryable: false }).success).toBe(false);
    expect(CollaborationDirectErrorSchema.safeParse({ code: "membership_required", safeMessage: "Token sk-abcdefghijklmnop rejected", retryable: false }).success).toBe(false);
    expect(CollaborationDirectErrorSchema.safeParse({ code: "clerk_error", safeMessage: "Clerk failed", retryable: true }).success).toBe(false);
    expect(CollaborationDirectErrorSchema.safeParse({ code: "membership_required", safeMessage: "no", retryable: false, stack: "at x" }).success).toBe(false);
  });
});
