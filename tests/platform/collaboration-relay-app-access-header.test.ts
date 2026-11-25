import { describe, expect, it } from "vitest";
import { CollaborationRelay, type RelayHome } from "../../packages/platform/src/collaboration/relay.js";

// Outcome (ENG-579): the owner's view-only marker on a shared app's entry document reaches the
// platform launcher, while other home headers stay filtered.
// Fault detected: the relay dropping the marker, so teammates get no read bridge and see an empty app.
const HOME: RelayHome = { runtimeId: "vps-11111111-1111-4111-8111-111111111111", origin: "https://203.0.113.10:443" };
const SCOPE = "10000000-0000-4000-8000-00000000e001";

describe("relay response headers for shared app assets", () => {
  it("forwards the view-only marker and still drops arbitrary home headers", async () => {
    const relay = new CollaborationRelay({
      resolveScopeHome: async (id) => (id === SCOPE ? HOME : null),
      resolveInvitationHome: async () => null,
      resolveRuntimeHome: async () => null,
      resolveSessionHome: async () => null,
      fetchImpl: (async () => new Response("<main></main>", { headers: {
        "content-type": "text/html; charset=utf-8", "x-matrix-app-access": "read_only", "x-home-internal": "secret",
      } })) as typeof fetch,
    });
    try {
      const response = await relay.forward({
        actorId: "user_member", method: "GET", path: `/api/collaboration/scopes/${SCOPE}/apps/notes/assets/index.html`,
        query: "", headers: new Headers({ "x-matrix-collaboration-session": "30000000-0000-4000-8000-00000000e001" }), body: null,
      });
      expect(response.headers.get("x-matrix-app-access")).toBe("read_only");
      expect(response.headers.get("x-home-internal")).toBeNull();
      await response.body?.cancel();
    } finally {
      relay.close();
    }
  });
});
