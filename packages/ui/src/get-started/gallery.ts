import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod/v4";

/** App Gallery on the owner's computer; the host adds auth and timeouts. */
export interface GetStartedGalleryPort {
  list(signal: AbortSignal): Promise<unknown>;
  install(id: string): Promise<unknown>;
  /** The app's gallery icon (`/icons/gallery-<id>.png` on the computer). */
  iconUrl(id: string): string;
}

const SLUG = /^[a-z][a-z0-9-]{0,47}$/;
// Only the fields the wizard shows; the gallery route validates the full listing.
const GalleryListingSchema = z.looseObject({
  apps: z.array(z.looseObject({
    id: z.string().regex(SLUG),
    name: z.string().min(1).max(80),
    tagline: z.string().max(100),
    services: z.array(z.looseObject({
      id: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
      name: z.string().min(1).max(60),
      optional: z.boolean().optional(),
    })).max(4),
    installed: z.boolean().optional(),
  })).max(40),
});

export interface GetStartedGalleryApp {
  id: string;
  name: string;
  tagline: string;
  services: { id: string; name: string; optional?: boolean }[];
  installed: boolean;
}

export interface GetStartedGallery {
  apps: readonly GetStartedGalleryApp[];
  installing: string | null;
  failed: string | null;
  install(id: string): void;
  iconUrl(id: string): string;
}

/** "Gmail", "Gmail and Calendar", "Gmail, Slack and Calendar". */
export function joinNames(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Loads App Gallery once while the wizard is open; null when there is no gallery to show. */
export function useGetStartedGallery(port: GetStartedGalleryPort | undefined, active: boolean): GetStartedGallery | null {
  const [apps, setApps] = useState<GetStartedGalleryApp[] | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!port || !active) return;
    const controller = new AbortController();
    port.list(controller.signal).then((raw) => {
      if (controller.signal.aborted) return;
      const parsed = GalleryListingSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn("[get-started] unexpected gallery response");
        return;
      }
      setApps(parsed.data.apps.map((app) => ({
        id: app.id, name: app.name, tagline: app.tagline, installed: app.installed === true,
        services: app.services.map((service) => ({ id: service.id, name: service.name, ...(service.optional ? { optional: true } : {}) })),
      })));
    }, (error: unknown) => {
      if (!controller.signal.aborted) console.warn("[get-started] gallery unavailable:", errorName(error));
    });
    return () => controller.abort();
  }, [port, active]);

  const install = useCallback((id: string) => {
    if (!port || installing || !SLUG.test(id)) return;
    setInstalling(id);
    setFailed(null);
    port.install(id).then(() => {
      setApps((previous) => previous?.map((app) => (app.id === id ? { ...app, installed: true } : app)) ?? previous);
    }, (error: unknown) => {
      console.warn("[get-started] gallery install failed:", errorName(error));
      setFailed(id);
    }).finally(() => setInstalling(null));
  }, [port, installing]);

  return useMemo(() => (port && apps ? { apps, installing, failed, install, iconUrl: port.iconUrl } : null), [port, apps, installing, failed, install]);
}
