import type { MessagingBridgeAccountProvider } from "./repository.js";
import type { MessagingNetwork, MessagingNetworkSlug } from "./schemas.js";
import { createSetupExpiresAt } from "./setup-sessions.js";

export const MESSAGING_NETWORKS: MessagingNetwork[] = [
  {
    slug: "telegram",
    displayName: "Telegram",
    setupKind: "api_credentials",
    enabled: true,
    requiresExternalCredentials: true,
  },
  {
    slug: "whatsapp",
    displayName: "WhatsApp",
    setupKind: "qr",
    enabled: true,
    requiresExternalCredentials: false,
  },
];

const defaultProvider: MessagingBridgeAccountProvider = {
  async beginSetup(input) {
    const expiresAt = createSetupExpiresAt();
    if (input.networkSlug === "whatsapp") {
      return {
        qrCode: `matrixos-whatsapp:${input.setupId}`,
        expiresAt,
      };
    }
    return {
      setupUrl: `matrixos://messages/setup/telegram/${input.setupId}`,
      expiresAt,
    };
  },
  async disconnect() {},
};

export function getMessagingBridgeAccountProvider(
  providers: Partial<Record<MessagingNetworkSlug, MessagingBridgeAccountProvider>>,
  networkSlug: MessagingNetworkSlug,
): MessagingBridgeAccountProvider {
  return providers[networkSlug] ?? defaultProvider;
}
