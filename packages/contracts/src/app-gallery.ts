import { z } from "zod/v4";

const slug = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
export const GalleryFieldSchema = z.strictObject({
  key: slug, label: text(60), kind: z.enum(["text", "longtext", "date", "number", "money", "url", "select"]),
  required: z.boolean().optional(), options: z.array(text(60)).max(12).optional(),
});
export const GalleryAppSchema = z.strictObject({
  id: slug, name: text(80), collection: z.enum(["personal", "business"]), category: text(50),
  description: text(240), tagline: text(100), icon: slug, accent: z.enum(["forest", "blue", "amber", "rose", "violet", "teal"]),
  view: z.enum(["finance", "travel", "agenda", "board", "library", "notes", "habits", "focus"]),
  entity: text(50), fields: z.array(GalleryFieldSchema).min(1).max(16),
  services: z.array(z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/), name: text(60), actions: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).min(1).max(8), optional: z.boolean().optional() })).max(4),
  importGoal: text(1200), highlights: z.array(text(100)).min(1).max(4),
}).superRefine((app, ctx) => {
  if (new Set(app.fields.map(f => f.key)).size !== app.fields.length) ctx.addIssue({ code: "custom", message: "Duplicate field" });
  if (new Set(app.services.map(s => s.id)).size !== app.services.length) ctx.addIssue({ code: "custom", message: "Duplicate service" });
  for (const field of app.fields) if (field.kind === "select" && !field.options?.length) ctx.addIssue({ code: "custom", message: "Selection needs options" });
});
export const AppGalleryCatalogSchema = z.strictObject({ version: z.literal(1), apps: z.array(GalleryAppSchema).min(1).max(40) }).superRefine((value, ctx) => {
  if (new Set(value.apps.map(a => a.id)).size !== value.apps.length) ctx.addIssue({ code: "custom", message: "Duplicate app" });
});
export type GalleryApp = z.infer<typeof GalleryAppSchema>;
export type GalleryField = z.infer<typeof GalleryFieldSchema>;
export interface GalleryConnection { service: string; account_label: string; account_email?: string | null; status: string }
export interface GalleryAppListing extends GalleryApp { installed: boolean; launchPath?: string; installedName?: string }
export interface GalleryInstallResult { status: "installed" | "already_installed"; slug: string; name: string; path: string }
export type GalleryReadinessStatus = "ready" | "choose_accounts" | "needs_connection" | "unknown";
export interface GalleryReadiness {
  status: GalleryReadinessStatus;
  services: { id: string; name: string; accounts: GalleryConnection[] }[];
}

/** Null inventory represents a failed/unavailable read, never an empty account list. */
/** The service fields readiness reads; a full catalog app or a listing both fit. */
export interface GalleryServiceRef { id: string; name: string; optional?: boolean }

export function deriveGalleryReadiness(app: { services: readonly GalleryServiceRef[] }, connections: readonly GalleryConnection[] | null): GalleryReadiness {
  const services = app.services.map(service => ({ id: service.id, name: service.name, accounts: (connections ?? []).filter(account => account.service === service.id && account.status === "active") }));
  if (services.length === 0) return { status: "ready", services };
  if (connections === null) return { status: "unknown", services };
  if (services.some((service, index) => !app.services[index]?.optional && service.accounts.length === 0)
    || services.every(service => service.accounts.length === 0)) return { status: "needs_connection", services };
  return { status: services.some(service => service.accounts.length > 1) ? "choose_accounts" : "ready", services };
}

export function filterGalleryApps<T extends GalleryApp>(apps: readonly T[], filter: { collection?: "personal" | "business"; query?: string; category?: string }): T[] {
  const query = (filter.query ?? "").trim().toLocaleLowerCase();
  return apps.filter(app => (!filter.collection || app.collection === filter.collection)
    && (!filter.category || app.category === filter.category)
    && (!query || [app.name, app.description, app.category, ...app.services.map(s => s.name)].join(" ").toLocaleLowerCase().includes(query)));
}

export const APP_GALLERY_BUILD_MAX_CHARS = 2000;

/** The one build request App Gallery and the onboarding widget send; null when empty or too long. */
export function appGalleryBuildPrompt(input: string): string | null {
  const request = input.trim();
  if (!request || request.length > APP_GALLERY_BUILD_MAX_CHARS) return null;
  return `[BUILD] Build an app for my Matrix computer: ${request}. Use my connected tools only after I choose the accounts and approve imports. Make it work in Web Desktop, Web Canvas, Electron Desktop, Web Mobile and Native Mobile.`;
}

export const GALLERY_READY_APPS_MAX = 6;

/**
 * Apps App Gallery would call ready (every required service connected, at least one connection)
 * for these connected services, most connections used first, then catalog order.
 */
export function galleryAppsReadyWith<T extends { services: readonly GalleryServiceRef[] }>(
  apps: readonly T[],
  connected: ReadonlySet<string>,
  max = GALLERY_READY_APPS_MAX,
): { app: T; using: T["services"][number][] }[] {
  const connections: GalleryConnection[] = [...connected].map((service) => ({ service, account_label: service, status: "active" }));
  return apps
    .filter((app) => app.services.length > 0 && deriveGalleryReadiness(app, connections).status === "ready")
    .map((app) => ({ app, using: app.services.filter((service) => connected.has(service.id)) }))
    .sort((left, right) => right.using.length - left.using.length)
    .slice(0, max);
}
