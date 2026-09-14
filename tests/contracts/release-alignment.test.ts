import { describe, expect, it } from "vitest";
import { evaluateReleaseAlignment, evaluateDesktopReleaseState, BuildSourceSchema } from "../../packages/contracts/src/release-alignment";
import hostInfo from "../fixtures/host-release-system-info.json";

const oldCommit = "a".repeat(40);
const newCommit = "b".repeat(40);
const branchCommit = "c".repeat(40);
const source = { commit: newCommit, ancestors: [oldCommit] };
const info = (sha: string) => ({ version: "v2026.09.09-1199", build: { sha },
  runtimeCompatibility: { schemaVersion: 1, minDesktopProtocol: 1, maxDesktopProtocol: 1 } });

describe("released source comparison", () => {
  it("compares the captured VPS-native response with no image build environment", () => {
    expect(evaluateDesktopReleaseState(hostInfo, {
      commit: newCommit, ancestors: [hostInfo.release.gitCommit],
    }).status).toBe("runtime-update-required");
    expect(evaluateReleaseAlignment(hostInfo, {
      commit: hostInfo.release.gitCommit, ancestors: [],
    })).toBe("aligned");
  });
  it.each([
    { runningVersion: undefined },
    { runningVersion: "v2026.09.09-1199" },
    { version: "v2026.09.10-1206" },
    { release: { ...hostInfo.release, version: "v2026.09.10-1206" } },
    { release: { ...hostInfo.release, gitCommit: "unknown" } },
    { release: { ...hostInfo.release, kind: "container" } },
    { release: { ...hostInfo.release, schemaVersion: 2 } },
  ])("does not infer running provenance from an unverified installed bundle: %j", (override) => {
    expect(evaluateReleaseAlignment({ ...hostInfo, ...override }, source)).toBe("unavailable");
  });
  it("prefers explicit running build identity over installed host metadata", () => {
    expect(evaluateReleaseAlignment({ ...hostInfo, build: { sha: oldCommit },
      release: { ...hostInfo.release, gitCommit: newCommit } }, source)).toBe("runtime-update-required");
  });
  it("recognizes a shared source even when product versions and channels differ", () => {
    expect(evaluateReleaseAlignment(info(newCommit), source)).toBe("aligned");
  });
  it("detects missing cloud changes without a manually bumped protocol", () => {
    expect(evaluateReleaseAlignment(info(oldCommit), source)).toBe("runtime-update-required");
  });
  it("never declares different branches or truncated ancestry aligned", () => {
    expect(evaluateReleaseAlignment(info(branchCommit), source)).toBe("different-releases");
    expect(evaluateReleaseAlignment(info(newCommit), { commit: oldCommit, ancestors: [] })).toBe("different-releases");
  });
  it.each([null, {}, { version: "x" }, info("unknown"), info("ab"), { ...info(newCommit), build: null }])(
    "does not treat missing or malformed running provenance as proof of alignment", (value) => {
      expect(evaluateReleaseAlignment(value, source)).toBe("unavailable");
    },
  );
  it.each([null, {}, { ...source, commit: "unknown" }, { ...source, ancestors: [newCommit] },
    { ...source, ancestors: [oldCommit, oldCommit] }, { ...source, ancestors: Array(257).fill(oldCommit) }])(
    "rejects missing, circular, duplicate, or oversized Desktop history", (value) => {
      expect(BuildSourceSchema.safeParse(value).success).toBe(false);
      expect(evaluateReleaseAlignment(info(newCommit), value)).toBe("unavailable");
    },
  );
  it("uses the running build rather than installed version metadata", () => {
    expect(evaluateReleaseAlignment({ ...info(oldCommit), installedVersion: "v2026.09.10-1205",
      runningVersion: "v2026.09.09-1199", gitCommit: newCommit }, source)).toBe("runtime-update-required");
  });
});


describe("source alignment and explicit protocol recovery", () => {
  it.each([null, source])("keeps a required Desktop upgrade visible regardless of provenance", (desktop) => {
    const cloud = { ...info(newCommit), runtimeCompatibility: { schemaVersion: 1, minDesktopProtocol: 2, maxDesktopProtocol: 2 } };
    expect(evaluateDesktopReleaseState(cloud, desktop)).toMatchObject({ status: "desktop-update-required", protocol: "desktop-update-required" });
  });
  it("does not let matching sources hide a gateway protocol upgrade", () => {
    expect(evaluateDesktopReleaseState(info(newCommit), source, 2)).toMatchObject({ alignment: "aligned", status: "runtime-update-required" });
  });
  it("still prompts for missing merged changes when the protocol is supported", () => {
    expect(evaluateDesktopReleaseState(info(oldCommit), source)).toEqual({ alignment: "runtime-update-required", status: "runtime-update-required", protocol: "compatible" });
  });
});
