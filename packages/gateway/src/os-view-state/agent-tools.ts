import { randomUUID } from "node:crypto";
import {
  canonicalOsViewCatalogPath,
  findOpenOsViewDesktopSlot,
  normalizeOsViewDesktopIcons,
  OS_VIEW_PLACEABLE_BUILTIN_APPS,
  type OsViewDesktopAddResult,
  type OsViewStateResponse,
} from "@matrix-os/contracts";
import { listApps, type AppEntry } from "../apps.js";
import { OsViewStateConflictError } from "./repository.js";

const AGENT_DESKTOP_BOUNDS = { width: 1280, height: 640 } as const;
const MAX_CONFLICT_ATTEMPTS = 3;
const SAFE_CATALOG_APP_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;

export interface PlaceableApp {
  appId: string;
  name: string;
  path: string;
}

export interface OsViewAgentRepository {
  getOrCreate(ownerId: string): Promise<OsViewStateResponse>;
  patch(ownerId: string, input: {
    baseRevision: number;
    mutationId: string;
    patch: { desktop: { icons: OsViewStateResponse["document"]["desktop"]["icons"] } };
  }): Promise<OsViewStateResponse>;
}

export interface OsViewAgentTools {
  listPlaceableApps(): Promise<PlaceableApp[]>;
  addAppToDesktop(appId: string): Promise<{ status: OsViewDesktopAddResult }>;
}

export function createOsViewAgentTools(deps: {
  repository: OsViewAgentRepository;
  ownerId: string;
  homePath: string;
  listCatalog?: () => Promise<AppEntry[]>;
  onChanged?: (state: OsViewStateResponse) => void;
}): OsViewAgentTools {
  const readCatalog = deps.listCatalog ?? (() => listApps(deps.homePath));

  async function placeableApps(): Promise<PlaceableApp[]> {
    const result: PlaceableApp[] = OS_VIEW_PLACEABLE_BUILTIN_APPS.map((app) => ({ ...app }));
    const seen = new Set(result.map((app) => app.appId));
    for (const app of await readCatalog()) {
      const appId = typeof app.slug === "string" ? app.slug : "";
      const path = canonicalOsViewCatalogPath(app);
      if (!SAFE_CATALOG_APP_ID.test(appId) || !path || seen.has(appId)) continue;
      seen.add(appId);
      result.push({ appId, name: app.name.slice(0, 256), path });
    }
    return result;
  }

  return {
    listPlaceableApps: placeableApps,
    addAppToDesktop: async (appId) => {
      if (!SAFE_CATALOG_APP_ID.test(appId)) return { status: "failed" };
      try {
        const app = (await placeableApps()).find((entry) => entry.appId === appId);
        if (!app) return { status: "failed" };
        const mutationId = `osvm_${randomUUID().replaceAll("-", "")}`;
        for (let attempt = 0; attempt <= MAX_CONFLICT_ATTEMPTS; attempt += 1) {
          const current = await deps.repository.getOrCreate(deps.ownerId);
          const icons = normalizeOsViewDesktopIcons(current.document.desktop.icons);
          if (icons.some((icon) => icon.path === app.path)) return { status: "already-present" };
          const slot = findOpenOsViewDesktopSlot(icons, AGENT_DESKTOP_BOUNDS);
          if (!slot) return { status: "desktop-full" };
          try {
            const updated = await deps.repository.patch(deps.ownerId, {
              baseRevision: current.revision,
              mutationId,
              patch: { desktop: { icons: [...icons, { path: app.path, ...slot }] } },
            });
            try {
              deps.onChanged?.(updated);
            } catch (error: unknown) {
              console.warn("[os-view-agent] Change notification failed:", error instanceof Error ? error.name : "UnknownError");
            }
            return { status: "added" };
          } catch (error: unknown) {
            if (!(error instanceof OsViewStateConflictError) || attempt === MAX_CONFLICT_ATTEMPTS) {
              console.error("[os-view-agent] Desktop placement failed:", error instanceof Error ? error.name : "UnknownError");
              return { status: "failed" };
            }
          }
        }
        return { status: "failed" };
      } catch (error: unknown) {
        console.error("[os-view-agent] Desktop placement failed:", error instanceof Error ? error.name : "UnknownError");
        return { status: "failed" };
      }
    },
  };
}
