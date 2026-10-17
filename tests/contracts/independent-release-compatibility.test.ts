import { describe, expect, it } from "vitest";
import { evaluateDesktopReleaseState } from "../../packages/contracts/src/release-alignment";

const source = { commit: "b".repeat(40), ancestors: ["a".repeat(40)] };
const compatible = { version: "main-support-1277", runtimeCompatibility: {
  schemaVersion: 1, minDesktopProtocol: 1, maxDesktopProtocol: 1,
} };

describe("independently published Desktop and VPS releases", () => {
  it.each(["a".repeat(40), "c".repeat(40), "unknown"])("accepts supported protocols regardless of source %s", (sha) => {
    expect(evaluateDesktopReleaseState({ ...compatible, build: { sha } }, source).status).toBe("compatible");
  });
  it("does not infer compatibility from an identical commit without a handshake", () => {
    expect(evaluateDesktopReleaseState({ version: "v1", build: { sha: source.commit } }, source).status).toBe("legacy");
  });
  it("does not infer an update requirement from malformed protocol metadata", () => {
    expect(evaluateDesktopReleaseState({ ...compatible, runtimeCompatibility: { schemaVersion: 2 } }, source).status).toBe("unavailable");
  });
  it("preserves directional recovery independent of the release channel", () => {
    expect(evaluateDesktopReleaseState(compatible, source, 2).status).toBe("runtime-update-required");
    expect(evaluateDesktopReleaseState({ ...compatible, runtimeCompatibility: {
      schemaVersion: 1, minDesktopProtocol: 2, maxDesktopProtocol: 3,
    } }, null).status).toBe("desktop-update-required");
  });
});
