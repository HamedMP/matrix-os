export type DistributionStatus = "installable" | "gated" | "blocked";

export interface SandboxCapabilities {
  sandboxEnforced: boolean;
  allowCommunityInstalls: boolean;
}

const TRUSTED_TIERS = new Set(["first_party", "verified_partner"]);

export function computeDistributionStatus(
  listingTrust: string | undefined,
  caps: SandboxCapabilities,
): DistributionStatus {
  if (listingTrust !== undefined && TRUSTED_TIERS.has(listingTrust)) {
    return "installable";
  }

  if (listingTrust === "community") {
    if (caps.sandboxEnforced) {
      return "installable";
    }
    if (caps.allowCommunityInstalls) {
      return "gated";
    }
    return "blocked";
  }

  // Unknown tier: fail-closed
  return "blocked";
}

export function sandboxCapabilities(): SandboxCapabilities {
  return {
    sandboxEnforced: false, // stub until spec 025 lands
    allowCommunityInstalls: process.env.ALLOW_COMMUNITY_INSTALLS === "1",
  };
}
