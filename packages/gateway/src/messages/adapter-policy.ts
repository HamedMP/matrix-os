export type AuthoritativeMessagingPath = "bridged-matrix" | "legacy-direct" | "notification-only" | "none";

export interface AuthoritativeMessagingPathInput {
  hasBridgeMapping: boolean;
  legacyAdapterEnabled: boolean;
}

export function resolveAuthoritativeMessagingPath(input: AuthoritativeMessagingPathInput): AuthoritativeMessagingPath {
  if (input.hasBridgeMapping) {
    return input.legacyAdapterEnabled ? "notification-only" : "bridged-matrix";
  }
  return input.legacyAdapterEnabled ? "legacy-direct" : "none";
}
