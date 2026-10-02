/** Opt in to additive funding states only in clients with the matching contracts. */
export function canonicalChatProviderCatalogPath(refresh = false, settingsSetup = false): string {
  return `/api/chat-providers?${refresh ? "refresh=true&" : ""}includeConnectionLabels=true&includeConnectionState=true&includeFundingState=true${settingsSetup ? "&includeSettingsSetupActions=true" : ""}`;
}

export function providerSettingsSnapshotPath(refresh = false): string {
  return `/api/ai/provider-settings?includeCapabilities=true&includeFundingState=true&includeModelCapabilities=true&includeMatrixModelInventory=true&includeAccountDetails=true${refresh ? "&refresh=true" : ""}`;
}

export const providerSettingsActionsPath = "/api/ai/provider-settings/actions?includeCapabilities=true&includeFundingState=true&includeModelCapabilities=true&includeMatrixModelInventory=true";
