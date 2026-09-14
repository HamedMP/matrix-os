import { describe, expect, it } from "vitest";
import { evaluateRuntimeCompatibility, RuntimeCompatibilitySchema, RUNNING_RUNTIME_COMPATIBILITY, DESKTOP_PROTOCOL_VERSION } from "@matrix-os/contracts";

describe("runtime compatibility negotiation", () => {
  it("keeps the running gateway compatible with its bundled client", () => {
    expect(evaluateRuntimeCompatibility({ version: "v2026.09.09-1195", runtimeCompatibility: RUNNING_RUNTIME_COMPATIBILITY }, DESKTOP_PROTOCOL_VERSION)).toBe("compatible");
  });
  it.each([
    [1, "desktop-update-required"], [2, "compatible"], [3, "compatible"], [4, "runtime-update-required"],
  ] as const)("compares protocol %s against both ends of the supported window", (protocol, expected) => {
    expect(evaluateRuntimeCompatibility({ version: "0.0.0", runtimeCompatibility: { schemaVersion: 1, minDesktopProtocol: 2, maxDesktopProtocol: 3 } }, protocol)).toBe(expected);
  });
  it("recognizes a legacy gateway without declaring it compatible", () => {
    expect(evaluateRuntimeCompatibility({ version: "v2026.09.08-1195" })).toBe("legacy");
  });
  it.each([null, {}, { version: "x", runtimeCompatibility: null }, { version: "x", runtimeCompatibility: { schemaVersion: 1, minDesktopProtocol: 4, maxDesktopProtocol: 2 } }])("handles absent or invalid responses safely", (info) => {
    expect(evaluateRuntimeCompatibility(info)).toBe("unavailable");
  });
  it("accepts additive metadata but bounds protocol values", () => {
    expect(RuntimeCompatibilitySchema.safeParse({ ...RUNNING_RUNTIME_COMPATIBILITY, nextField: true }).success).toBe(true);
    expect(RuntimeCompatibilitySchema.safeParse({ ...RUNNING_RUNTIME_COMPATIBILITY, maxDesktopProtocol: 10001 }).success).toBe(false);
  });
});
