import { z } from "zod/v4";

export interface WhatsAppConfig {
  appSecret: string;
  verifyToken: string;
  accessToken: string;
  phoneNumberId: string;
  graphVersion: string;
  encryptionKey: string;
  publicUrl: string;
  allowedSenders: string[];
}

const envNames = [
  "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_GRAPH_API_VERSION", "WHATSAPP_ENCRYPTION_KEY",
  "WHATSAPP_PUBLIC_URL", "WHATSAPP_ALLOWED_SENDERS",
] as const;

export const WhatsAppPhoneSchema = z.string().regex(/^[1-9]\d{6,14}$/);
export const WhatsAppBsuidSchema = z.string().regex(/^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/);
export const WhatsAppSenderSchema = z.union([WhatsAppPhoneSchema, WhatsAppBsuidSchema]);
const secret = z.string().min(8).max(4096).refine((value) => !/[\r\n]/.test(value));
const configSchema = z.object({
  appSecret: secret,
  verifyToken: secret,
  accessToken: secret,
  phoneNumberId: z.string().regex(/^\d{5,30}$/),
  graphVersion: z.string().regex(/^v[1-9]\d?\.\d{1,2}$/),
  encryptionKey: z.string().regex(/^[a-fA-F0-9]{64}$/),
  publicUrl: z.string().max(2048).url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && url.pathname === "/" && !url.search && !url.hash;
  }),
  allowedSenders: z.array(WhatsAppSenderSchema).min(1).max(100),
});

// This pilot requires an explicit allowlist and an EEA calling or BSUID country code.
// Shared codes with known non-EEA territories are conservatively excluded below.
const eeaCodes = ["30", "31", "32", "33", "34", "36", "39", "40", "43", "45", "46", "47", "48", "49",
  "351", "352", "353", "354", "356", "357", "358", "359", "370", "371", "372", "385", "386", "420", "421", "423"];
const eeaCountries = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT",
  "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO"];
function hasEeaCallingCode(sender: string): boolean {
  return eeaCodes.some((code) => sender.startsWith(code))
    && !sender.startsWith("3906698") && !sender.startsWith("4779");
}

export function isWhatsAppSenderEligible(sender: string): boolean {
  if (WhatsAppBsuidSchema.safeParse(sender).success) return eeaCountries.includes(sender.slice(0, 2));
  return WhatsAppPhoneSchema.safeParse(sender).success && hasEeaCallingCode(sender);
}

export function readWhatsAppConfig(env: NodeJS.ProcessEnv): WhatsAppConfig | undefined {
  if (!envNames.some((name) => env[name] !== undefined)) return undefined;
  const rawSenders = env.WHATSAPP_ALLOWED_SENDERS?.split(",") ?? [];
  if (rawSenders.length > 100) throw new Error("WhatsApp configuration is invalid");
  const allowedSenders = [...new Set(rawSenders.map((value) => value.trim().replace(/^\+/, "")))];
  const parsed = configSchema.safeParse({
    appSecret: env.WHATSAPP_APP_SECRET,
    verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    accessToken: env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    graphVersion: env.WHATSAPP_GRAPH_API_VERSION,
    encryptionKey: env.WHATSAPP_ENCRYPTION_KEY,
    publicUrl: env.WHATSAPP_PUBLIC_URL,
    allowedSenders,
  });
  if (!parsed.success || allowedSenders.some((sender) => !isWhatsAppSenderEligible(sender))) {
    throw new Error("WhatsApp configuration is invalid");
  }
  return { ...parsed.data, publicUrl: new URL(parsed.data.publicUrl).origin };
}

export function isWhatsAppSenderAllowed(config: Pick<WhatsAppConfig, "allowedSenders">, sender: string): boolean {
  return isWhatsAppSenderEligible(sender) && config.allowedSenders.includes(sender);
}
