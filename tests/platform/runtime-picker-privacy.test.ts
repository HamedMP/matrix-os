import { describe, expect, it } from "vitest";

import { getRuntimePickerPage } from "../../packages/platform/src/auth-pages.js";
import type { UserMachineRecord } from "../../packages/platform/src/db.js";

function machine(serverType: string): UserMachineRecord & { displayVersion: string } {
  return {
    machineId: "machine-1",
    clerkUserId: "user-1",
    handle: "panda",
    runtimeSlot: "primary",
    provisioningClass: "customer",
    accessClerkUserIds: [],
    developerTools: ["codex"],
    hetznerServerId: 123,
    publicIPv4: null,
    publicIPv6: null,
    status: "running",
    imageVersion: "v2026.08.31-1122",
    sourceSnapshotId: null,
    sourceBaseGeneration: null,
    targetBundleVersion: null,
    targetBundleSha256: null,
    recoveryCreateActionId: null,
    recoveryEncryptedPayload: null,
    recoveryOldServerId: null,
    recoveryOldPublicIPv4: null,
    serverType,
    location: "ash",
    registrationTokenHash: null,
    registrationTokenExpiresAt: null,
    provisionedAt: "2026-08-31T12:00:00.000Z",
    lastSeenAt: null,
    deletedAt: null,
    failureCode: null,
    failureAt: null,
    resizeStartedAt: null,
    resizeTargetServerType: null,
    attempt: 1,
    activationState: "authorized",
    prebillingIntentId: null,
    activationAuthorizedAt: "2026-08-31T12:00:00.000Z",
    displayVersion: "v2026.08.31-1122",
  };
}

describe("runtime picker customer privacy", () => {
  it.each(["cpx31", "cpx42", "future-provider-shape"]) (
    "does not expose the provider machine type %s",
    (serverType) => {
      const html = getRuntimePickerPage({
        machines: [machine(serverType)],
        selectedHandle: "panda",
      });

      expect(html).not.toContain(serverType);
      expect(html).not.toMatch(/hetzner/i);
      expect(html).toContain("Main Computer");
      expect(html).toContain("v2026.08.31-1122");
    },
  );
});
