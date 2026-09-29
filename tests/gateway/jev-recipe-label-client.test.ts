import { expect, it, vi } from "vitest";
import { createJevRecipeLabelClient } from "../../packages/gateway/src/jev/recipe-label-client.js";
it("forwards only the saved granted account and server-provided additive label plan with signed owner delegation", async () => {
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ confirmed: true, messageIds: ["message_1"], labelIds: ["Label_News"] }));
  const label = createJevRecipeLabelClient({ internalBaseUrl: "https://platform.internal/integrations", machineToken: "synthetic", fetcher });
  const scope = { kind: "jev_inbox_preview" as const, runId: "run_1", agentId: "agent_1", revision: 1,
    account: { service: "gmail" as const, accountLabel: "My Gmail", connectionId: "conn_1", expectedEmail: "me@example.test", labelingEnabled: true } };
  await label("owner_fixture", scope, { threadId: "thread_1", messageIds: ["message_1"], labels: ["00 • Jev/8 Newsletter"] });
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe("https://platform.internal/integrations/jev-label-call");
  expect(new Headers(init.headers).get("x-platform-user-id")).toBe("owner_fixture");
  expect(new Headers(init.headers).get("x-platform-verified")).toBeTruthy();
  expect(JSON.parse(String(init.body))).toEqual({ binding: scope.account, input: { threadId: "thread_1", messageIds: ["message_1"], labels: ["00 • Jev/8 Newsletter"] } });
});
