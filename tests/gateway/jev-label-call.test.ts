import { expect, it, vi } from "vitest";
import { createJevLabelCallRoutes } from "../../packages/gateway/src/integrations/jev-label-call.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
it("denies a read-only integration run before account lookup or Gmail calls", async () => {
  const list = vi.fn();
  const app = createJevLabelCallRoutes({ db: { listConnectedServices: list } as unknown as PlatformDb,
    pipedream: {} as PipedreamConnectClient, resolveUserId: async () => "owner_fixture" });
  const response = await app.request("/jev-label-call", { method: "POST", headers: { "content-type": "application/json", "x-matrix-integration-read-scope": "read" }, body: "{}" });
  expect(response.status).toBe(403); expect(list).not.toHaveBeenCalled();
});
