import type { MessagingNetwork } from "./schemas.js";

export const MESSAGING_NETWORKS: MessagingNetwork[] = [
  {
    slug: "telegram",
    displayName: "Telegram",
    setupKind: "code",
    enabled: true,
    requiresExternalCredentials: false,
  },
  {
    slug: "whatsapp",
    displayName: "WhatsApp",
    setupKind: "qr",
    enabled: true,
    requiresExternalCredentials: false,
  },
  {
    slug: "linkedin",
    displayName: "LinkedIn",
    setupKind: "api_credentials",
    enabled: true,
    requiresExternalCredentials: true,
  },
];
