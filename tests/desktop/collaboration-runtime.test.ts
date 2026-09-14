import { describe, expect, it } from "vitest";
import { collaborationRuntimeIdFromSystemInfo } from "../../desktop/src/renderer/src/lib/collaboration";

describe("desktop collaboration runtime", () => {
  it("uses only a validated server-owned machine ID", () => {
    expect(collaborationRuntimeIdFromSystemInfo({ runtime: {
      machineId: "11111111-1111-4111-8111-111111111111",
    } })).toBe("vps:11111111-1111-4111-8111-111111111111");
    expect(collaborationRuntimeIdFromSystemInfo({ runtime: { machineId: "../../owner" } })).toBeNull();
  });
});
