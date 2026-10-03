import { expect, it } from "vitest";
import { AgentThreadEventSchema } from "@matrix-os/contracts";
import { parseCodexAppServerRequestLine } from "../../packages/gateway/src/coding-agents/codex-app-server-events.js";

const context = () => ({ threadId: "thread_review", now: () => new Date("2026-10-01T00:00:00Z"),
  nextEventId: () => "evt_review", writableRoots: ["/workspace/project"] });
function request(params: Record<string, unknown>, method = "item/commandExecution/requestApproval") {
  return JSON.stringify({ id: "native-private-id", method, params: {
    threadId: "native-private-thread", turnId: "native-private-turn", itemId: "native-private-item", ...params } });
}

it("shows the requested command and project directory while masking credential values before persistence", () => {
  const result = parseCodexAppServerRequestLine(request({ command: "API_TOKEN='fixture-secret-value' pnpm run build --filter shell",
    cwd: "/workspace/project/apps/demo", reason: "Build the selected app", availableDecisions: ["accept", "decline"] }), context());
  expect(result.events[0]).toMatchObject({ type: "approval.requested", approval: {
    preview: { body: "Command:\nAPI_TOKEN=[redacted] pnpm run build --filter shell\nWorking directory: apps/demo\nReason: Build the selected app", truncated: false },
    allowedDecisions: ["approve", "decline"],
  } });
  expect(() => AgentThreadEventSchema.parse(result.events[0])).not.toThrow();
  expect(JSON.stringify(result.events)).not.toContain("fixture-secret-value");
  expect(JSON.stringify(result.events)).not.toContain("native-private");
});


it.each([
  "cat C:\\Users\\owner\\.env",
  "cat C:\\Users\\owner\\.ssh\\id_rsa",
  "echo x+/home/fixture/private",
  "curl -H 'Authorization:\tBearer fixture-sensitive-value' https://example.com",
  `printf '{"api_key":"fixture-sensitive-value"}'`,
  "AWS_SECRET_ACCESS_KEY=fixture-sensitive-value pnpm build",
  "psql postgres://owner:fixture-sensitive-value@database.example/db",
  "curl --cookie 'sid=fixture-sensitive-value' https://example.com",
])("keeps private or credential-bearing command fields safe and never blocks the approval: %s", command => {
  const result = parseCodexAppServerRequestLine(request({ command }), context());
  expect(result.events).toHaveLength(1);
  expect(JSON.stringify(result.events)).not.toContain("fixture-sensitive-value");
  expect(JSON.stringify(result.events)).not.toContain("Users");
  expect(JSON.stringify(result.events)).not.toContain("/home/fixture/private");
});

it("sanitizes the entire command before truncation and marks partial evidence", () => {
  const result = parseCodexAppServerRequestLine(request({ command: "echo " + "x".repeat(5000) + " API_TOKEN=fixture-sensitive-value" }), context());
  expect(result.events[0]).toMatchObject({ type: "approval.requested", approval: { preview: { truncated: true } } });
  expect(JSON.stringify(result.events)).not.toContain("fixture-sensitive-value");
  if (result.events[0]?.type !== "approval.requested") throw new Error("Expected approval");
  expect(result.events[0].approval.preview!.body!.length).toBeLessThanOrEqual(2000);
});

it("retains safe public URL arguments while masking connection URI credentials", () => {
  const publicRequest = parseCodexAppServerRequestLine(request({ command: "curl https://example.com/docs" }), context());
  expect(publicRequest.events[0]).toMatchObject({ type: "approval.requested", approval: { preview: {
    body: expect.stringContaining("curl https://example.com/docs"),
  } } });
  const privateRequest = parseCodexAppServerRequestLine(request({ command: "psql postgres://owner:fixture-sensitive-value@database.example/db" }), context());
  expect(privateRequest.events[0]).toMatchObject({ type: "approval.requested", approval: { preview: {
    body: expect.stringContaining("psql [redacted URL]"),
  } } });
});

it.each([
  "echo token",
  "echo cookie",
  "echo " + "x".repeat(1970) + " API_TOKEN=fixture-boundary-secret",
])("keeps native approval usable when optional display validation rejects composed or truncated evidence", command => {
  const result = parseCodexAppServerRequestLine(request({ command, availableDecisions: ["accept", "decline"] }), context());
  expect(result.events).toHaveLength(1);
  expect(result.events[0]).toMatchObject({ type: "approval.requested", approval: {
    title: "Run command", allowedDecisions: ["approve", "decline"],
  } });
  expect(result.pending?.nativeDecisionByMatrixDecision).toEqual({ approve: "accept", decline: "decline" });
  if (result.events[0]?.type !== "approval.requested") throw new Error("Expected approval");
  expect(result.events[0].approval.preview).toBeUndefined();
  expect(JSON.stringify(result.events)).not.toContain("fixture-boundary-secret");
});
