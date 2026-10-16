import { z } from "zod/v4";
import { CanonicalChatIdSchema } from "#canonical-chat";
import { resolveMessagingPlatformOrigin } from "#messaging-origin";

export const WhatsAppSettingsSchema = z
  .object({
    connected: z.boolean(),
    maskedSender: z
      .union([
        z.string().regex(/^••••[0-9]{4}$/),
        z.literal("your WhatsApp account"),
      ])
      .optional(),
    chatId: CanonicalChatIdSchema.optional(),
    admission: z.enum(["unavailable", "pilot", "public"]),
    startUrl: z
      .string()
      .max(80)
      .regex(/^https:\/\/wa\.me\/[1-9][0-9]{6,14}$/)
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      (!value.connected || Boolean(value.maskedSender)) &&
      (value.admission !== "unavailable" ||
        (!value.startUrl && !value.connected)) &&
      (!value.chatId || value.connected),
  );
export type WhatsAppSettings = z.infer<typeof WhatsAppSettingsSchema>;
export const WHATSAPP_SETTINGS_PATH = "/api/whatsapp/settings";
export const WHATSAPP_CONNECT_URL =
  "https://app.matrix-os.com/whatsapp/connect";
export const WHATSAPP_GUIDE_URL = "https://matrix-os.com/docs/whatsapp";
export const WHATSAPP_AI_GUIDANCE =
  "Your Matrix computer and AI connection must be ready. Check Agents & providers if a reply needs attention.";
export const WHATSAPP_AGENT_GUIDANCE =
  "New conversations use Matrix Agent. Existing conversations keep their selected agent; open the Chat in Matrix to change it.";
export function whatsAppChatUrl(chatId: string, origin = "https://app.matrix-os.com", allowDevelopmentOrigin = false): string {
  return matrixChatHandoffUrl(origin, chatId, allowDevelopmentOrigin);
}

/** Navigation references grant no access; normal owner authorization still applies. */
export function parseMatrixHandoff(
  params: URLSearchParams,
): { chatId: string } | null {
  if (
    params.toString().length > 512 ||
    [...params.keys()].some((key) => key !== "chat") ||
    params.getAll("chat").length !== 1
  )
    return null;
  const parsed = CanonicalChatIdSchema.safeParse(params.get("chat"));
  return parsed.success ? { chatId: parsed.data } : null;
}
export function matrixChatHandoffUrl(origin: string, chatId: string, allowDevelopmentOrigin = false): string {
  const resolved = resolveMessagingPlatformOrigin(origin, allowDevelopmentOrigin);
  if (!resolved) throw new Error("Invalid Matrix origin");
  const url = new URL("/open", resolved);
  url.searchParams.set("chat", CanonicalChatIdSchema.parse(chatId));
  return url.href;
}

/** All renderers hide stale actions while connection truth is being checked. */
export function whatsAppSettingsView(
  snapshot: WhatsAppSettings | null | undefined,
  checking: boolean,
  error: boolean,
) {
  if (error) return { label: "Unavailable", snapshot: null };
  if (checking || !snapshot)
    return { label: "Checking connection…", snapshot: null };
  return {
    label: snapshot.connected
      ? "Connected"
      : snapshot.admission === "unavailable"
        ? "Not available yet"
        : "Not connected",
    snapshot,
  };
}
