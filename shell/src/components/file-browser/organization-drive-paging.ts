import {
  CollaborationDiscoveryResponseSchema,
  OrganizationDriveSnapshotSchema,
} from "@matrix-os/contracts";
import type { z } from "zod/v4";

type DiscoveryItem = z.infer<typeof CollaborationDiscoveryResponseSchema>["items"][number];
type DriveSnapshot = z.infer<typeof OrganizationDriveSnapshotSchema>;
type Get = (path: string) => Promise<unknown>;

export const MAX_DISCOVERY_PAGES = 100;
// Bounds the requests a refresh makes to keep pages the member already loaded.
export const MAX_RETAINED_DRIVE_PAGES = 20;

export function driveBasePath(scopeId: string) { return `/api/collaboration/scopes/${scopeId}/drive`; }

export async function loadDiscoveryItems(get: Get, kind: "inbox" | "shared",
  maxPages = MAX_DISCOVERY_PAGES): Promise<DiscoveryItem[]> {
  const items: DiscoveryItem[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const page = CollaborationDiscoveryResponseSchema.parse(await get(`/api/collaboration/${kind}?limit=100${suffix}`));
    items.push(...page.items);
    if (!page.nextCursor) return items;
    if (seen.has(page.nextCursor)) throw new Error("CollaborationDiscoveryCursorLoop");
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  // Keep the drives already found usable instead of failing the whole view.
  console.warn("[organization-drive] discovery page limit reached", kind);
  return items;
}

export async function loadDriveSnapshotPages(request: Get, scopeId: string,
  pages: number): Promise<{ snapshot: DriveSnapshot; pages: number }> {
  const target = Math.min(Math.max(1, Math.floor(pages)), MAX_RETAINED_DRIVE_PAGES);
  let snapshot = OrganizationDriveSnapshotSchema.parse(await request(driveBasePath(scopeId)));
  let loaded = 1;
  while (loaded < target && snapshot.nextCursor) {
    const page = OrganizationDriveSnapshotSchema.parse(await request(
      `${driveBasePath(scopeId)}?after=${encodeURIComponent(snapshot.nextCursor)}`));
    snapshot = { ...page, files: [...snapshot.files, ...page.files] };
    loaded += 1;
  }
  return { snapshot, pages: loaded };
}
