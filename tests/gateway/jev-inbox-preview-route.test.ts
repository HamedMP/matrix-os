import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createJevRoutes } from "../../packages/gateway/src/jev/routes.js";
import type { HermesJevScope } from "../../packages/gateway/src/chat/hermes-integration-capability.js";
const scope: HermesJevScope = { kind: "jev_inbox_preview", runId: "run_fixture", agentId: "bot_jevone01", revision: 1,
  account: { service: "gmail", accountLabel: "My Gmail", connectionId: "conn_fixture", expectedEmail: "me@example.test" } };
function fixture(kind = "recipe") {
  const execute = vi.fn(async () => ({ kind: "discovery" as const, receipt: "a".repeat(64), readonly: true as const, threads: [] }));
  const resolveRecipeScope = vi.fn(() => kind === "recipe" ? { ownerId: "owner_fixture", scope } : null);
  const options = { service: null, resolveOwnerId: () => "owner_fixture", inboxBroker: { execute, clearRun: vi.fn() }, resolveRecipeScope };
  const app = new Hono(); app.route("/api/jev", createJevRoutes(options));
  const request = (body: unknown = { operation: "discover" }, contentType = "application/json") => app.request("/api/jev/inbox/preview", {
    method: "POST", headers: { Authorization: "Bearer fixture", "content-type": contentType }, body: JSON.stringify(body) });
  return { execute, resolveRecipeScope, request };
}
describe("Jev preview requires server-resolved recipe scope", () => {
  it("passes exact active owner/account scope, never request-supplied authority", async () => {
    const f = fixture(); const response = await f.request();
    expect(response.status).toBe(200); expect(f.execute).toHaveBeenCalledWith("owner_fixture", scope,
      { operation: "discover" }, expect.any(AbortSignal));
  });
  it.each(["generic", "machine", "browser", "expired", "cancelled"])("denies %s bearer even for authenticated owner", async (kind) => {
    const f = fixture(kind); expect((await f.request()).status).toBe(403); expect(f.execute).not.toHaveBeenCalled();
  });
  it.each(["ownerId", "accountId", "state", "verified", "url", "pageToken"])("rejects forged %s before broker", async (field) => {
    const f = fixture(); expect((await f.request({ operation: "discover", [field]: "forged" })).status).toBe(400);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("rejects wrong content type and bounds request bytes", async () => {
    const f = fixture(); expect((await f.request(undefined, "text/plain")).status).toBe(415);
    expect((await f.request({ operation: "discover", state: "x".repeat(42 * 1024) })).status).toBe(413);
    expect(f.execute).not.toHaveBeenCalled();
  });
});
