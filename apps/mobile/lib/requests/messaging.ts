import {
  WhatsAppSettingsSchema,
  WHATSAPP_SETTINGS_PATH,
} from "@matrix-os/contracts";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import { fetchAuthenticatedJson } from "./http";
export function fetchWhatsAppSettings(token: string) {
  return fetchAuthenticatedJson({
    url: HOSTED_GATEWAY_URL + WHATSAPP_SETTINGS_PATH,
    token,
    schema: WhatsAppSettingsSchema,
    errorMessage: "Could not check your connection. Try again.",
  });
}
