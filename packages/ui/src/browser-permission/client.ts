import { z } from "zod/v4";
import { BrowserGrantViewSchema, BrowserGrantRevokeRequestSchema, CanonicalChatIdSchema, type BrowserGrantView } from "@matrix-os/contracts";
export interface BrowserPermissionClient {
  getGrant(chatId: string): Promise<BrowserGrantView | null>;
  revokeGrant(grant: BrowserGrantView, clientRequestId: string): Promise<BrowserGrantView>;
}
/** The host supplies its bounded authenticated transport; bearer values stay there. */
export function createBrowserPermissionClient(request: (path: string, method: "GET" | "DELETE", body?: unknown) => Promise<unknown>): BrowserPermissionClient {
  return {
    async getGrant(chatId) {
      const path = `/api/chats/${encodeURIComponent(CanonicalChatIdSchema.parse(chatId))}/browser-grants`;
      return z.strictObject({ grant: BrowserGrantViewSchema.nullable() }).parse(await request(path, "GET")).grant;
    },
    async revokeGrant(grant, clientRequestId) {
      const current = BrowserGrantViewSchema.parse(grant);
      const body = BrowserGrantRevokeRequestSchema.parse({ clientRequestId, baseRevision: current.revision });
      const path = `/api/chats/${encodeURIComponent(current.chatId)}/browser-grants/${encodeURIComponent(current.id)}`;
      return z.strictObject({ grant: BrowserGrantViewSchema }).parse(await request(path, "DELETE", body)).grant;
    },
  };
}
