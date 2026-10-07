import { CollaborationDiscoveryItemSchema } from "@matrix-os/contracts";
import type { z } from "zod/v4";

type DiscoveryItem = z.infer<typeof CollaborationDiscoveryItemSchema>;

/** True when the Projects rail has the metadata it needs to own this item. */
export function isAcceptedProjectOwnedByRail(item: DiscoveryItem): boolean {
  return item.status === "accepted"
    && item.kind === "project"
    && Boolean(item.resource && "project" in item.resource && item.resource.overview);
}
