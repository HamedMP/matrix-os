import { describe, expect, it } from "vitest";
import { collaborationRuntimeFromSystemInfo } from "../../shell/src/lib/collaboration";

describe("shell collaboration runtime", () => {
  it("derives the authority runtime from server-owned machine identity", () => {
    expect(collaborationRuntimeFromSystemInfo({ runtime: {
      handle: "owner", runtimeSlot: "primary", machineId: "11111111-1111-4111-8111-111111111111",
    } })).toEqual({
      handle: "owner", runtimeSlot: "primary", runtimeId: "vps:11111111-1111-4111-8111-111111111111",
    });
    expect(collaborationRuntimeFromSystemInfo({ runtime: {
      handle: "owner", runtimeSlot: "primary", machineId: "not-a-machine",
    } })).toEqual({ handle: "owner", runtimeSlot: "primary", runtimeId: null });
  });
});
