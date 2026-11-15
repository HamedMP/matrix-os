import { z } from "zod/v4";
import { CollaborationIdSchema, CollaborationRevisionSchema } from "#collaboration";

/**
 * Org link for an organization-shared app (spec 2693 phase 4).
 *
 * The copied link is a web URL, `https://<app host>/open/shared-app/<scopeId>?…`.
 * That page hands off to the desktop app with `matrixos://shared-app/<scopeId>?…`,
 * which opens the same target as `sharedAppDeepLink` (`/shared/app/<scopeId>`).
 * Copied links carry `expectedShareRevision` (so a stopped and restarted share
 * invalidates them) but not the build ID, so app updates do not break links.
 * The link is only an address: the platform still requires current membership
 * in the sharing organization before anything opens. `app` and `org` are
 * display hints for the hand-off page, never used for authorization.
 */
export const SHARED_APP_OPEN_PATH_PREFIX = "/open/shared-app/";
export const SHARED_APP_DEEP_LINK_HOST = "shared-app";
const DisplayHintSchema = z.string().trim().min(1).max(80).regex(/^[^<>\u0000-\u001f]+$/);

export const SharedAppLinkSchema = z.strictObject({
  scopeId: CollaborationIdSchema,
  expectedBuildId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  expectedShareRevision: CollaborationRevisionSchema.optional(),
  app: DisplayHintSchema.optional(),
  org: DisplayHintSchema.optional(),
});
export type SharedAppLink = z.infer<typeof SharedAppLinkSchema>;

/** Normalizes a display name into a valid hint, or `undefined` when nothing usable remains. */
export function sharedAppDisplayHint(value: string): string | undefined {
  const cleaned = value.replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, 80).trim();
  return cleaned ? cleaned : undefined;
}

function query(link: SharedAppLink, includeHints: boolean): string {
  const params = new URLSearchParams();
  if (link.expectedBuildId) params.set("expectedBuildId", link.expectedBuildId);
  if (link.expectedShareRevision) params.set("expectedShareRevision", link.expectedShareRevision);
  if (includeHints && link.app) params.set("app", link.app);
  if (includeHints && link.org) params.set("org", link.org);
  const value = params.toString();
  return value ? `?${value}` : "";
}

/** Path of the web hand-off page members open from a copied org link. */
export function sharedAppOpenPath(link: SharedAppLink): string {
  const parsed = SharedAppLinkSchema.parse(link);
  return `${SHARED_APP_OPEN_PATH_PREFIX}${encodeURIComponent(parsed.scopeId)}${query(parsed, true)}`;
}

/** Desktop deep link the hand-off page opens. Display hints stay on the web page. */
export function sharedAppDesktopUrl(scheme: string, link: SharedAppLink): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(scheme)) throw new Error("Invalid deep link scheme");
  const parsed = SharedAppLinkSchema.parse(link);
  return `${scheme}://${SHARED_APP_DEEP_LINK_HOST}/${encodeURIComponent(parsed.scopeId)}${query(parsed, false)}`;
}

/** Strict parse of `matrixos://shared-app/<scopeId>?…`; anything else is `null`. */
export function parseSharedAppDesktopUrl(value: string, schemes: readonly string[]): SharedAppLink | null {
  let url: URL;
  try { url = new URL(value); }
  catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  if (!schemes.some((scheme) => url.protocol === `${scheme}:`) || url.host !== SHARED_APP_DEEP_LINK_HOST) return null;
  if (url.username || url.password || url.hash || url.port) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) return null;
  const entries = [...url.searchParams.entries()];
  const allowed = new Set(["expectedBuildId", "expectedShareRevision"]);
  if (entries.length > 2 || entries.some(([key]) => !allowed.has(key)) || new Set(entries.map(([key]) => key)).size !== entries.length) return null;
  let scopeId: string;
  try { scopeId = decodeURIComponent(segments[0]!); }
  catch (error: unknown) {
    // `new URL` accepts stray `%` escapes; a malformed link is ignored, never thrown.
    if (error instanceof URIError) return null;
    throw error;
  }
  const parsed = SharedAppLinkSchema.safeParse({ scopeId, ...Object.fromEntries(entries) });
  return parsed.success ? parsed.data : null;
}

/** Query parsing for the web hand-off page (Next.js search params). */
export function parseSharedAppOpenParams(scopeId: string, search: Record<string, string | string[] | undefined>): SharedAppLink | null {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(search)) {
    if (typeof value !== "string") return null;
    flat[key] = value;
  }
  const parsed = SharedAppLinkSchema.safeParse({ scopeId, ...flat });
  return parsed.success ? parsed.data : null;
}
