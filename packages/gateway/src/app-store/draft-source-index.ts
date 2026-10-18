import { APP_BUNDLE_LIMITS } from "@matrix-os/contracts/app-store-bundle";
import type { AppStoreDraftDetail } from "@matrix-os/contracts/app-store-gateway";
import { StoreError } from "./platform-client.js";

/** Index both bounded source snapshots; source contents stay behind the single-file diff read. */
export function draftSourceIndex(
  before: ReadonlyMap<string, Buffer>,
  after: ReadonlyMap<string, Buffer>,
): NonNullable<AppStoreDraftDetail["sourceFiles"]> {
  if (
    before.size > APP_BUNDLE_LIMITS.maxFiles ||
    after.size > APP_BUNDLE_LIMITS.maxFiles
  )
    throw new StoreError("limit");
  // Each snapshot has at most 512 files; their union has at most 1024 entries.
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .map((path) => {
      const original = before.get(path),
        prepared = after.get(path);
      return {
        path,
        change: original
          ? prepared
            ? original.equals(prepared)
              ? "unchanged"
              : "modified"
            : "removed"
          : "added",
      };
    });
}
