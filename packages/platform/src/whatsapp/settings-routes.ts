import { WHATSAPP_AGENT_CONSENT_VERSION } from "./repository-types.js";
import { Hono, type Context } from "hono";
import {
  WhatsAppSettingsSchema,
  WHATSAPP_SETTINGS_PATH,
} from "@matrix-os/contracts";

/** Read-only owner settings. Linking mutations retain their separate Clerk+Origin policy. */
export function createWhatsAppSettingsRoutes(deps: {
  resolveOwner: (context: Context) => Promise<string | null>;
  getConnection?: (
    owner: string,
  ) => Promise<{ sender: string; consentVersion: string; chatId?: string | null } | null | undefined>;
  phoneNumber?: string;
  admissionMode?: "allowlist" | "eea_selfserve";
}) {
  const app = new Hono();
  app.get(WHATSAPP_SETTINGS_PATH, async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const owner = await deps.resolveOwner(c);
      if (!owner) return c.json({ error: "Sign in to continue" }, 401);
      if (!deps.getConnection)
        return c.json({ connected: false, admission: "unavailable" });
      const record = await deps.getConnection(owner);
      const connected = record?.consentVersion === WHATSAPP_AGENT_CONSENT_VERSION;
      const number = /^[1-9][0-9]{6,14}$/.test(deps.phoneNumber ?? "")
        ? deps.phoneNumber
        : undefined;
      return c.json(
        WhatsAppSettingsSchema.parse({
          connected,
          ...(connected
            ? {
                maskedSender: /^[0-9]+$/.test(record!.sender)
                  ? `••••${record!.sender.slice(-4)}`
                  : "your WhatsApp account",
              }
            : {}),
          admission:
            deps.admissionMode === "eea_selfserve" ? "public" : "pilot",
          ...(number ? { startUrl: `https://wa.me/${number}` } : {}),
          ...(connected && record?.chatId ? { chatId: record.chatId } : {}),
        }),
      );
    } catch (error) {
      console.error("[whatsapp/settings] Read failed", error);
      return c.json({ error: "Connection unavailable. Try again." }, 503);
    }
  });
  return app;
}
