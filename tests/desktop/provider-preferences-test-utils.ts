import type { ProviderPreferences } from "@desktop/shared/provider-preferences";
import { useProviderPreferences } from "@desktop/renderer/src/features/settings/provider-preferences";

export function resetProviderPreferences(
  overrides: Partial<ProviderPreferences> & { hydrated?: boolean } = {},
): void {
  useProviderPreferences.setState({
    defaultProviderId: null,
    lastComposerInstanceId: null,
    composerSelections: {},
    hydrated: false,
    ...overrides,
  });
}
