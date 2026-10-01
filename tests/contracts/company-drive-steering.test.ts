import { expect, it } from "vitest";
import { CanonicalSteerChatRunRequestSchema } from "../../packages/contracts/src/index";
it("requires company drive references to be admitted as a fresh turn instead of injecting an active run", () => {
    expect(CanonicalSteerChatRunRequestSchema.safeParse({ clientRequestId: "req_steer", expectedTurnId: "cturn_test", parts: [{ type: "resource_reference", resource: { kind: "organization_drive", id: "00000000-0000-4000-8000-000000000001", label: "Authority", drive: { kind: "drive", scopeId: "00000000-0000-4000-8000-000000000001", organizationId: "org_example" } } }] }).success).toBe(false);
});
