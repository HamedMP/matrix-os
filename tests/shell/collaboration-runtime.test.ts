import { describe, expect, it } from "vitest";
import { collaborationRuntimeFromSystemInfo } from "../../shell/src/lib/collaboration";

describe("shell collaboration runtime", () => {
  it("derives the authority runtime from server-owned machine identity", () => {
    expect(collaborationRuntimeFromSystemInfo({ runtime: {
      handle: "owner", runtimeSlot: "primary", machineId: "11111111-1111-4111-8111-111111111111",
    }, capabilities: { collaboration: true } })).toEqual({
      handle: "owner", runtimeSlot: "primary", runtimeId: "vps:11111111-1111-4111-8111-111111111111", collaborationEnabled: true,
    });
    expect(collaborationRuntimeFromSystemInfo({ runtime: {
      handle: "owner", runtimeSlot: "primary", machineId: "not-a-machine",
    }, capabilities: { collaboration: true } })).toEqual({ handle: "owner", runtimeSlot: "primary", runtimeId: null, collaborationEnabled: true });
  });

  it("fails closed when the collaboration capability is absent or disabled", () => {
    const runtime = {
      handle: "owner", runtimeSlot: "primary", machineId: "11111111-1111-4111-8111-111111111111",
    };
    expect(collaborationRuntimeFromSystemInfo({ runtime })).toEqual({
      handle: "owner", runtimeSlot: "primary", runtimeId: null, collaborationEnabled: false,
    });
    expect(collaborationRuntimeFromSystemInfo({ runtime, capabilities: { collaboration: false } })).toEqual({
      handle: "owner", runtimeSlot: "primary", runtimeId: null, collaborationEnabled: false,
    });
  });
});
