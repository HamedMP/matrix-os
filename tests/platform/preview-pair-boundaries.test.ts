import { describe, expect, it } from "vitest";
import { isPreviewMachine, canClerkUserAccessMachine, assertPreviewProvisioningCapacity } from "../../packages/platform/src/customer-vps-preview.js";
import { CustomerHandleSchema, PreviewProvisionRequestSchema } from "../../packages/platform/src/customer-vps-schema.js";

const pair = { handle: "cp-3022-11111111-1-a", runtimeSlot: "cp-3022-11111111-1-a",
  provisioningClass: "preview" as const, clerkUserId: "user_owner", accessClerkUserIds: ["user_member"] };
describe("pair handles preserve Preview quota and customer authorization boundaries", () => {
  it("counts pair members against the existing owner Preview quota", () => {
    expect(isPreviewMachine(pair)).toBe(true);
    expect(() => assertPreviewProvisioningCapacity([pair], 1)).toThrow("capacity");
  });
  it("never grants blanket machine access to the peer even if an access list is corrupt", () => {
    expect(canClerkUserAccessMachine(pair, "user_owner")).toBe(true);
    expect(canClerkUserAccessMachine(pair, "user_member")).toBe(false);
  });
  it("reserves pair handles from customer account registration and ordinary Preview requests", () => {
    expect(CustomerHandleSchema.safeParse(pair.handle).success).toBe(false);
    expect(PreviewProvisionRequestSchema.safeParse({ ...pair, clerkUserId: "user_owner" }).success).toBe(false);
  });
  it("does not classify customer, wrong-slot or private-preview rows as pair previews", () => {
    expect(isPreviewMachine({ ...pair, provisioningClass: "customer" })).toBe(false);
    expect(isPreviewMachine({ ...pair, runtimeSlot: "primary" })).toBe(false);
    expect(isPreviewMachine({ ...pair, provisioningClass: "private-preview" })).toBe(false);
  });
});
