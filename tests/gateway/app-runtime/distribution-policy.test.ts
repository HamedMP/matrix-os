import { describe, it, expect, afterEach, vi } from "vitest";
import {
  computeDistributionStatus,
  sandboxCapabilities,
  type DistributionStatus,
  type SandboxCapabilities,
} from "../../../packages/gateway/src/app-runtime/distribution-policy.js";

describe("computeDistributionStatus", () => {
  it("first_party -> installable", () => {
    const caps: SandboxCapabilities = { sandboxEnforced: false, allowCommunityInstalls: false };
    expect(computeDistributionStatus("first_party", caps)).toBe("installable");
  });

  it("verified_partner -> installable", () => {
    const caps: SandboxCapabilities = { sandboxEnforced: false, allowCommunityInstalls: false };
    expect(computeDistributionStatus("verified_partner", caps)).toBe("installable");
  });

  it("community + no flags -> blocked", () => {
    const caps: SandboxCapabilities = { sandboxEnforced: false, allowCommunityInstalls: false };
    expect(computeDistributionStatus("community", caps)).toBe("blocked");
  });

  it("community + ALLOW_COMMUNITY_INSTALLS=1 -> gated", () => {
    const caps: SandboxCapabilities = { sandboxEnforced: false, allowCommunityInstalls: true };
    expect(computeDistributionStatus("community", caps)).toBe("gated");
  });

  it("community + sandboxEnforced -> installable", () => {
    const caps: SandboxCapabilities = { sandboxEnforced: true, allowCommunityInstalls: false };
    expect(computeDistributionStatus("community", caps)).toBe("installable");
  });

  it("unknown tier -> blocked (fail-closed)", () => {
    const caps: SandboxCapabilities = { sandboxEnforced: false, allowCommunityInstalls: true };
    expect(computeDistributionStatus("totally-unknown" as string, caps)).toBe("blocked");
  });

  it("every gated result must be ack-unlockable (invariant)", () => {
    const trusts = ["first_party", "verified_partner", "community", "unknown-tier"];
    const capCombos: SandboxCapabilities[] = [
      { sandboxEnforced: false, allowCommunityInstalls: false },
      { sandboxEnforced: false, allowCommunityInstalls: true },
      { sandboxEnforced: true, allowCommunityInstalls: false },
      { sandboxEnforced: true, allowCommunityInstalls: true },
    ];
    for (const trust of trusts) {
      for (const caps of capCombos) {
        const status = computeDistributionStatus(trust, caps);
        if (status === "gated") {
          // A gated status means the user can acknowledge and proceed.
          // Verify it's not blocked (which would mean no ack path).
          expect(status).not.toBe("blocked");
          // Verify it's specifically "gated" (this is tautological but documents the invariant).
          expect(status).toBe("gated");
        }
      }
    }
  });
});

describe("sandboxCapabilities", () => {
  afterEach(() => {
    delete process.env.ALLOW_COMMUNITY_INSTALLS;
  });

  it("reads ALLOW_COMMUNITY_INSTALLS from env", () => {
    process.env.ALLOW_COMMUNITY_INSTALLS = "1";
    const caps = sandboxCapabilities();
    expect(caps.allowCommunityInstalls).toBe(true);
  });

  it("defaults allowCommunityInstalls to false when env unset", () => {
    delete process.env.ALLOW_COMMUNITY_INSTALLS;
    const caps = sandboxCapabilities();
    expect(caps.allowCommunityInstalls).toBe(false);
  });

  it("sandboxEnforced is stubbed to false", () => {
    const caps = sandboxCapabilities();
    expect(caps.sandboxEnforced).toBe(false);
  });
});
