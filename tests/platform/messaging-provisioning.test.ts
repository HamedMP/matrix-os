import { describe, expect, it } from "vitest";
import { meetsMessagingResourceFloor } from "../../packages/platform/src/customer-vps-routes.js";

describe("messaging provisioning resource floor", () => {
  it("requires the Synapse messaging floor before enabling full bridge support", () => {
    expect(meetsMessagingResourceFloor({ vcpu: 2, memoryGiB: 6, diskGiB: 60 }, "synapse")).toBe(true);
    expect(meetsMessagingResourceFloor({ vcpu: 2, memoryGiB: 4, diskGiB: 60 }, "synapse")).toBe(false);
  });

  it("allows the lower default floor for non-Synapse messaging checks", () => {
    expect(meetsMessagingResourceFloor({ vcpu: 2, memoryGiB: 4, diskGiB: 40 }, "default")).toBe(true);
    expect(meetsMessagingResourceFloor({ vcpu: 1, memoryGiB: 4, diskGiB: 40 }, "default")).toBe(false);
  });
});
