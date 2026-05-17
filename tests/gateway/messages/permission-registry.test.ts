import { describe, expect, it } from "vitest";
import { createPermissionRegistry } from "../../../packages/gateway/src/messages/permission-registry.js";
import type { HermesPermission } from "../../../packages/gateway/src/messages/schemas.js";

const basePermission: HermesPermission = {
  ownerId: "user_a",
  roomId: "!room:matrixos.local",
  readEnabled: false,
  replyEnabled: false,
  automationEnabled: false,
  mentionOnly: true,
  revision: 1,
  createdAt: "2026-05-13T00:00:00.000Z",
  updatedAt: "2026-05-13T00:00:00.000Z",
};

describe("permission registry", () => {
  it("defaults every Hermes access mode to deny", () => {
    const registry = createPermissionRegistry(() => null);

    expect(registry.canRead("user_a", "!room:matrixos.local")).toBe(false);
    expect(registry.canReply("user_a", "!room:matrixos.local")).toBe(false);
    expect(registry.canAutomate("user_a", "!room:matrixos.local")).toBe(false);
  });

  it("requires a mention match when mentionOnly is enabled", () => {
    const registry = createPermissionRegistry(() => ({
      ...basePermission,
      readEnabled: true,
      mentionOnly: true,
    }));

    expect(registry.canRead("user_a", "!room:matrixos.local", { mentionsOwner: false })).toBe(false);
    expect(registry.canRead("user_a", "!room:matrixos.local", { mentionsOwner: true })).toBe(true);
  });

  it("separates read, reply, and automation grants", () => {
    const registry = createPermissionRegistry(() => ({
      ...basePermission,
      readEnabled: true,
      replyEnabled: false,
      automationEnabled: true,
      mentionOnly: false,
    }));

    expect(registry.canRead("user_a", "!room:matrixos.local")).toBe(true);
    expect(registry.canReply("user_a", "!room:matrixos.local")).toBe(false);
    expect(registry.canAutomate("user_a", "!room:matrixos.local")).toBe(true);
  });
});
