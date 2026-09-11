import { describe, expect, it } from "vitest";
import type { CollaborationProjectInventory, CollaborationScope } from "@matrix-os/contracts";
import {
  deriveProjectPresentation,
  projectMembershipEffectLabel,
} from "../../packages/ui/src/collaboration/project-state.js";

describe("project collaboration presentation", () => {
  it("allows only an owner to confirm a complete unblocked private inventory", () => {
    expect(deriveProjectPresentation(scope(), inventory()).canConfirm).toBe(true);
    expect(deriveProjectPresentation(scope({ role: "editor" }), inventory()).canConfirm).toBe(false);
    const blocked = deriveProjectPresentation(scope(), inventory({
      blockers: [{
        kind: "terminal",
        id: "release",
        code: "terminal_incarnation_unavailable",
      }],
    }));
    expect(blocked).toMatchObject({
      canConfirm: false,
      blockerMessages: ["release must be made shareable before the whole project can be shared."],
    });
  });

  it("derives safe unavailable states during destructive lifecycle operations", () => {
    expect(deriveProjectPresentation(scope({ lifecycle: "deleting" }), inventory())).toMatchObject({
      isAvailable: false,
      statusLabel: "Deleting shared project",
    });
    expect(deriveProjectPresentation(scope({ lifecycle: "recovering" }), inventory())).toMatchObject({
      isAvailable: true,
      canConfirm: false,
      statusLabel: "Recovering project sharing",
    });
  });

  it("names the exact standalone item without implying project access", () => {
    expect(projectMembershipEffectLabel({
      actor: { actorId: "user_ada", displayName: "Ada" },
      role: "viewer",
      effect: "retain_item_only",
      resourceKind: "chat",
      resourceId: "Private notes",
    })).toBe("Ada keeps standalone access only to Private notes.");
  });
});

function scope(overrides: Partial<CollaborationScope> = {}): CollaborationScope {
  return {
    id: "10000000-0000-4000-8000-000000000501",
    ownerId: "user_owner",
    kind: "project",
    resourceId: "project_alpha",
    membershipMode: "direct",
    lifecycle: "private",
    revision: "1",
    authEpoch: "1",
    authorityGeneration: "1",
    role: "owner",
    capabilities: {
      read: false,
      discuss: false,
      manageMembers: true,
      requestAi: false,
      observeTerminal: false,
      controlTerminal: false,
      stopTerminal: false,
    },
    ...overrides,
  };
}

function inventory(overrides: Partial<CollaborationProjectInventory> = {}): CollaborationProjectInventory {
  return {
    scopeId: "10000000-0000-4000-8000-000000000501",
    projectId: "project_alpha",
    projectRevision: "1",
    scopeRevision: "1",
    ownedItems: [],
    externalReferences: [],
    blockers: [],
    membershipEffects: [],
    inventoryHash: "a".repeat(64),
    membershipHash: "b".repeat(64),
    inventoryToken: "c".repeat(64),
    expiresAt: "2026-09-11T12:00:00.000Z",
    ...overrides,
  };
}
