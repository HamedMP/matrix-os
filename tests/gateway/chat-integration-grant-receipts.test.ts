import { describe, expect, it } from "vitest";
import { createIntegrationToolAuthority } from "../../packages/gateway/src/chat/integration-tool-authority.js";

const tool = "mcp__matrix-integrations__call_service";
const action = { service: "google_drive", action: "create_folder", label: "work", params: { name: "approved" } };
describe("integration grant execution receipts", () => {
  it("rejects a cancelled identical request without consuming the other request's grant", () => {
    const authority = createIntegrationToolAuthority({ live: () => true, now: () => 0 });
    const first = authority.grantIntegrationTool(tool, action)!;
    const second = authority.grantIntegrationTool(tool, action)!;
    expect(first).toMatchObject({ receipt: expect.stringMatching(/^[a-f0-9]{64}$/), revoke: expect.any(Function) });
    expect(first.receipt).not.toBe(second.receipt);
    first.revoke();
    expect(authority.consumeIntegrationRequest("POST", "/api/integrations/call", action, first.receipt)).toBe(false);
    expect(authority.consumeIntegrationRequest("POST", "/api/integrations/call", action)).toBe(false);
    expect(authority.consumeIntegrationRequest("POST", "/api/integrations/call", action, second.receipt)).toBe(true);
    expect(authority.consumeIntegrationRequest("POST", "/api/integrations/call", action, second.receipt)).toBe(false);
  });
  it("binds receipts to exact action arguments and the issuing run", () => {
    const authority = createIntegrationToolAuthority({ live: () => true, now: () => 0 });
    const other = createIntegrationToolAuthority({ live: () => true, now: () => 0 });
    const grant = authority.grantIntegrationTool(tool, action)!;
    expect(authority.consumeIntegrationRequest("POST", "/api/integrations/call", { ...action, label: "personal" }, grant.receipt)).toBe(false);
    expect(other.consumeIntegrationRequest("POST", "/api/integrations/call", action, grant.receipt)).toBe(false);
    expect(authority.consumeIntegrationRequest("POST", "/api/integrations/call", action, "0".repeat(64))).toBe(false);
    expect(authority.consumeIntegrationRequest("POST", "/api/integrations/call", action, grant.receipt)).toBe(true);
  });
});
