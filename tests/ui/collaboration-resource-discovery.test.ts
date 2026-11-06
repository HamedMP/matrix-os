import { describe, expect, it } from "vitest";
import { CollaborationDiscoveryResponseSchema } from "@matrix-os/contracts";
import { createCollaborationDirectApi } from "../../packages/ui/src/collaboration/direct-api.js";
import { CLIENT_ORIGIN, PLATFORM, fakeDirectWorld, runtimeId, scopeId } from "../helpers/collaboration-direct-world.js";

describe("standalone resource discovery", () => {
  it.each(["folder", "file", "app"])("keeps accepted %s metadata for its resource-specific reader", async kind => {
    const world = fakeDirectWorld();
    const item = { scopeId, runtimeId, ownerId: "user_owner", kind, authorityGeneration: 3,
      status: "accepted", organizationId: "org_direct_1" };
    world.platform.shared = [item];
    const api = createCollaborationDirectApi({ platformBaseUrl: PLATFORM, fetchImpl: world.fetchImpl,
      clientOrigin: CLIENT_ORIGIN, now: world.now });
    try {
      const result = await api.get("/api/collaboration/shared");
      // Folder/file/app readers authorize and hydrate their own content. Discovery must not
      // call the Chat adapter, which reports an unavailable Chat for a healthy folder.
      expect(world.home.requests).toEqual([]);
      expect(CollaborationDiscoveryResponseSchema.parse(result)).toEqual({ items: [item] });
    } finally {
      api.direct.close();
    }
  });
});
