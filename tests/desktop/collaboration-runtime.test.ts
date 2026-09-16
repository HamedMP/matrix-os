import { describe, expect, it } from "vitest";
import { collaborationRuntimeIdFromSystemInfo } from "../../desktop/src/renderer/src/lib/collaboration";

describe("desktop collaboration runtime", () => {
  it("uses only a validated server-owned machine ID", () => {
    expect(collaborationRuntimeIdFromSystemInfo({ runtime: {
      machineId: "11111111-1111-4111-8111-111111111111",
    }, capabilities: { collaboration: true } })).toBe("vps:11111111-1111-4111-8111-111111111111");
    expect(collaborationRuntimeIdFromSystemInfo({ runtime: { machineId: "../../owner" }, capabilities: { collaboration: true } })).toBeNull();
  });

  it("fails closed when collaboration is disabled or not advertised", () => {
    const runtime = { machineId: "11111111-1111-4111-8111-111111111111" };
    expect(collaborationRuntimeIdFromSystemInfo({ runtime })).toBeNull();
    expect(collaborationRuntimeIdFromSystemInfo({ runtime, capabilities: { collaboration: false } })).toBeNull();
  });
});
