import { expect, it } from "vitest";
import { issueHermesIntegrationCapability, resolveHermesJevScope, type HermesJevScope } from "../../packages/gateway/src/chat/hermes-integration-capability.js";
const scope: HermesJevScope = { kind: "jev_inbox_preview", runId: "run_fixture", agentId: "bot_jevone01", revision: 1,
  account: { service: "gmail", accountLabel: "My Gmail", connectionId: "conn_fixture", expectedEmail: "me@example.test" } };
it("resolves only active server-issued recipe authority and invalidates revocation", () => {
  const capability = issueHermesIntegrationCapability("owner_fixture", scope);
  try { expect(resolveHermesJevScope(capability.token)).toEqual({ ownerId: "owner_fixture", scope }); }
  finally { capability.revoke(); }
  expect(resolveHermesJevScope(capability.token)).toBeNull();
});
it("never promotes a generic integration bearer to recipe authority", () => {
  const capability = issueHermesIntegrationCapability("owner_fixture");
  try { expect(resolveHermesJevScope(capability.token)).toBeNull(); }
  finally { capability.revoke(); }
  expect(resolveHermesJevScope("forged")).toBeNull();
});
