import type { AiProviderSnapshotV3, ProviderAccount, ProviderAccessSource } from '@matrix-os/contracts';
import type { ClaudeNativeAccountMetadata } from './claude-native-account-metadata.js';

/** Identity proof applies only to the exact native subscription profile account. */
export function projectClaudeNativeAccount(input: {
  canonical: AiProviderSnapshotV3; accounts: ProviderAccount[]; sources: ProviderAccessSource[];
  metadata?: ClaudeNativeAccountMetadata | null; now: Date;
}): string | undefined {
  const metadata = input.metadata;
  if (!metadata || metadata.authMethod !== 'terminal' || Date.parse(metadata.checkedAt) > +input.now
    || !Number.isFinite(Date.parse(metadata.checkedAt)) || Date.parse(metadata.staleAfter) <= +input.now
    || !Number.isFinite(Date.parse(metadata.staleAfter))) return;
  const installed = input.canonical.drivers.some(driver => driver.id === 'claude_code' && driver.installState === 'installed');
  const source = input.sources.find(source => source.id === 'owner_claude_profile' && source.kind === 'provider_account'
    && source.providerId === 'anthropic' && source.fundingKind === 'owner_account');
  const account = input.accounts.find(account => account.id === source?.accountId && account.providerId === 'anthropic'
    && account.authMethod === 'terminal' && account.accessSourceId === source?.id);
  const exact = account && input.canonical.instances.some(instance => instance.accessSourceId === source?.id
    && instance.accountId === account.id && instance.vendor === 'anthropic'
    && instance.driverId === 'claude_code');
  if (!installed || !source || !account || !exact) return;
  if (metadata.usage && Date.parse(metadata.usage.asOf) <= +input.now
    && (!metadata.usage.resetsAt || Date.parse(metadata.usage.resetsAt) > +input.now)) source.usage = metadata.usage;
  account.displayName = metadata.accountLabel;
  account.connectionDetails = metadata.connectionDetails;
  account.authState = 'authenticated';
  account.lastCheckedAt = metadata.checkedAt;
  return account.id;
}
