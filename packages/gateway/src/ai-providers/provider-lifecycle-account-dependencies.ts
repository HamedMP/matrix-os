import { ProviderDependencyCountsSchema, type ProviderDependencyCounts } from "@matrix-os/contracts";
import type { ProviderSettingsConfiguration } from "./provider-settings-persistence.js";
import type { ProviderSettingsDependencyReader } from "./provider-settings-projector.js";

function isOwnerClaudeProfile(profile: ProviderSettingsConfiguration["accountProfiles"][number]): boolean {
  return profile.providerId === "anthropic" && profile.authMethod === "terminal"
    && (profile.id === "owner_claude_profile" && profile.accessSourceId === "owner_claude_profile"
      || profile.id === "owner_anthropic" && profile.accessSourceId === "owner_anthropic_profile");
}

/** Logout addresses the shared credential; removal must guard every registered alias. */
export async function readLifecycleAccountDependencies(input: {
  accountId: string; config: ProviderSettingsConfiguration; reader?: ProviderSettingsDependencyReader;
}): Promise<ProviderDependencyCounts> {
  const profile = input.config.accountProfiles.find(row => row.id === input.accountId);
  const ids = profile && isOwnerClaudeProfile(profile)
    ? input.config.accountProfiles.filter(isOwnerClaudeProfile).map(row => row.id) : [input.accountId];
  const counts = await Promise.all(ids.map(async accountId => {
    const harnessInstanceIds = input.config.harnesses.filter(row => row.selectedAccountId === accountId).map(row => row.id);
    return input.reader ? ProviderDependencyCountsSchema.parse(await input.reader.getAccountDependencies({ accountId, harnessInstanceIds }))
      : { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: harnessInstanceIds.length };
  })); // Exactly two known aliases maximum; arbitrary profiles are never grouped.
  return ProviderDependencyCountsSchema.parse(counts.reduce((total, count) => ({
    activeChatCount: total.activeChatCount + count.activeChatCount,
    resumableChatCount: total.resumableChatCount + count.resumableChatCount,
    harnessInstanceCount: total.harnessInstanceCount + count.harnessInstanceCount,
  }), { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 0 }));
}
