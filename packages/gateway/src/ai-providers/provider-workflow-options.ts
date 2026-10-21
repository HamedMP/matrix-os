import { ProviderWorkflowCapabilityV2Schema, type ProviderWorkflowConnectionOption } from '@matrix-os/contracts';
import type { ProviderWorkflowAdapter } from './provider-workflows.js';

/** Descriptor qualification is registration data, never inferred from a provider name. */
export function qualifiedConnectionOptions(adapter: ProviderWorkflowAdapter): ProviderWorkflowConnectionOption[] {
  const { start: _start, verifyKey: _verify, ...capability } = adapter;
  const row = ProviderWorkflowCapabilityV2Schema.parse({ ...capability, connectionOptions: adapter.connectionOptions ?? [], logs: true });
  for (const option of row.connectionOptions) {
    if (option.availability !== 'available') continue;
    const supported = option.authKind === 'api_key'
      ? adapter.verifyKey && adapter.apiKeyProviders.includes(option.providerId)
      : option.method && adapter.loginMethods.includes(option.method);
    if (!supported || adapter.installState !== 'installed') throw new Error('Invalid workflow registration');
  }
  return row.connectionOptions;
}
