import { z } from "zod/v4";

import { buildGatewayRequestUrl, fetchAuthenticatedJson } from "@/lib/requests/http";

const APPS_UNAVAILABLE_ERROR = "Apps unavailable. Try again.";
const APP_SESSION_UNAVAILABLE_ERROR = "App session unavailable. Try again.";
const MAX_APPS = 500;
const APP_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ICON_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const AppEntrySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2_000).optional(),
  icon: z.string().max(64).optional(),
  category: z.string().max(100).optional(),
  author: z.string().max(100).optional(),
  version: z.string().max(64).optional(),
  slug: z.string().regex(APP_SLUG).optional(),
  runtime: z.enum(["static", "vite", "node"]).optional(),
  runtimeState: z.object({ status: z.string().max(64).optional() }).loose().optional(),
  launchUrl: z.string().max(4_096).optional(),
  file: z.string().min(1).max(4_096),
  path: z.string().min(1).max(4_096),
}).loose();

const InstalledAppsSchema = z.array(AppEntrySchema).max(MAX_APPS);
const AppSessionSchema = z.object({
  launchUrl: z.string().min(1).max(4_096).refine((value) => value.startsWith("/apps/")),
  expiresAt: z.number().int().positive(),
});

export type InstalledApp = z.infer<typeof AppEntrySchema>;
export type AppSession = z.infer<typeof AppSessionSchema>;

export function fetchInstalledApps(
  clerkToken: string,
  computerGatewayUrl: string,
): Promise<InstalledApp[]> {
  return fetchAuthenticatedJson({
    url: appUrl(computerGatewayUrl, "/api/apps", APPS_UNAVAILABLE_ERROR),
    token: clerkToken,
    schema: InstalledAppsSchema,
    errorMessage: APPS_UNAVAILABLE_ERROR,
  });
}

export async function createAppSession(
  clerkToken: string,
  computerGatewayUrl: string,
  slug: string,
): Promise<AppSession> {
  if (!APP_SLUG.test(slug)) throw new Error(APP_SESSION_UNAVAILABLE_ERROR);
  const session = await fetchAuthenticatedJson({
    url: appUrl(
      computerGatewayUrl,
      `/api/apps/${encodeURIComponent(slug)}/session-token`,
      APP_SESSION_UNAVAILABLE_ERROR,
    ),
    token: clerkToken,
    schema: AppSessionSchema,
    errorMessage: APP_SESSION_UNAVAILABLE_ERROR,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!session.launchUrl.startsWith(`/apps/${encodeURIComponent(slug)}/`)) {
    throw new Error(APP_SESSION_UNAVAILABLE_ERROR);
  }
  return session;
}

export function buildAppIconUrl(
  computerGatewayUrl: string,
  icon: string | undefined,
): string | null {
  if (!icon || !ICON_SLUG.test(icon)) return null;
  try {
    return buildGatewayRequestUrl(
      computerGatewayUrl,
      `/icons/${encodeURIComponent(icon)}.png`,
    );
  } catch {
    return null;
  }
}

function appUrl(computerGatewayUrl: string, path: string, errorMessage: string): string {
  try {
    return buildGatewayRequestUrl(computerGatewayUrl, path);
  } catch {
    throw new Error(errorMessage);
  }
}
