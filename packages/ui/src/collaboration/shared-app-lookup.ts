import { CollaborativeAppDirectoryItemSchema, type CollaborativeAppDirectoryItem } from "@matrix-os/contracts";
import { CollaborationDirectError } from "./direct-client.js";

type LookupApi = { get(path: string): Promise<unknown> };

/**
 * One shared app by scope, from the member's current directory (metadata only), with the owner's
 * app name and icon (`fields=display`, ENG-490) so a link-opened window matches the launcher.
 * Resolves `null` when the platform says the scope is not shared with this
 * member; every other failure rejects so callers can offer a retry instead of
 * claiming "not shared". Opening still re-checks membership at launch.
 */
export async function lookupSharedApp(api: LookupApi, scopeId: string): Promise<CollaborativeAppDirectoryItem | null> {
  try {
    return CollaborativeAppDirectoryItemSchema.parse(await api.get(`/api/collaboration/shared-apps/${encodeURIComponent(scopeId)}?fields=display`));
  } catch (error: unknown) {
    if (error instanceof CollaborationDirectError && error.code === "not_found") return null;
    throw error;
  }
}
