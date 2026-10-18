import {
  FundedHostActivationIdentitySchema,
  FundedHostActivationRequestSchema,
  FundedHostActivationResponseSchema,
} from "@matrix-os/contracts";

it("loads managed-feature contracts through the shared Native Mobile package entrypoint", () => {
  const identity = {
    handle: "test-computer",
    machineId: "test_machine",
    ownerId: "test_owner",
    runtimeSlot: "primary",
    runtimeTokenEpoch: 2,
  };

  expect(FundedHostActivationIdentitySchema.parse(identity)).toEqual(identity);
  expect(typeof FundedHostActivationRequestSchema.safeParse).toBe("function");
  expect(typeof FundedHostActivationResponseSchema.safeParse).toBe("function");
});
