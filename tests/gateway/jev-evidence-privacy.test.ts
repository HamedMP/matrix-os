import { expect, it } from "vitest";
import { assembleInboxEvidence } from "../../packages/gateway/src/jev/inbox-evidence.js";
import type { HermesJevScope } from "../../packages/gateway/src/chat/hermes-integration-capability.js";
const scope: HermesJevScope = { kind: "jev_inbox_preview", runId: "run_fixture", agentId: "agent_fixture", revision: 1,
  account: { service: "gmail", accountLabel: "Work", connectionId: "conn_fixture", expectedEmail: "me@example.test" } };
const message = { id: "message_fixture", threadId: "thread_fixture", internalDate: "1",
  payload: { mimeType: "text/plain", body: { data: Buffer.from("Synthetic message.").toString("base64url") } } };
const evidence = (owner: string, candidate = scope) => assembleInboxEvidence(owner, candidate, "thread_fixture", [message.id], [message], 1);
it.each(["owner", "run", "agent", "revision", "account"])("keeps %s authority in server hash but out of relay-visible internal IDs", mode => {
  const first = evidence("owner_fixture");
  const candidate = { ...scope, ...(mode === "run" ? { runId: "other_run" } : {}),
    ...(mode === "agent" ? { agentId: "other_agent" } : {}), ...(mode === "revision" ? { revision: 2 } : {}),
    ...(mode === "account" ? { account: { ...scope.account, connectionId: "other_conn" } } : {}) };
  const other = evidence(mode === "owner" ? "other_owner" : "owner_fixture", candidate);
  expect(first.state).toBe(other.state); expect(first.hash).not.toBe(other.hash);
  expect(first.state).not.toContain("owner_fixture"); expect(first.state).not.toContain("conn_fixture");
});
