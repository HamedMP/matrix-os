import { expect, it, vi } from "vitest";
import { createBoundedPipedreamLabels } from "../../packages/gateway/src/integrations/pipedream-bounded-labels.js";

it("adds only user label IDs to the exact message through the existing OAuth proxy", async () => {
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: "message_1", labelIds: ["INBOX", "Label_123"] }));
  const call = createBoundedPipedreamLabels({ projectId: "proj_fixture", environment: "production", getAccessToken: async () => "synthetic", fetcher });
  await call({ externalUserId: "owner_fixture", accountId: "apn_fixture", kind: "add-labels", messageId: "message_1", labelIds: ["Label_123"] });
  const [url, init] = fetcher.mock.calls[0]!;
  expect(new URL(Buffer.from(new URL(url).pathname.split("/").at(-1)!, "base64url").toString()).pathname).toBe("/gmail/v1/users/me/messages/message_1/modify");
  expect(JSON.parse(String(init.body))).toEqual({ addLabelIds: ["Label_123"] });
  expect(init.method).toBe("POST");
  expect(init.redirect).toBe("error");
  expect(init.signal).toBeInstanceOf(AbortSignal);
});
it.each(["system", "remove", "arbitrary-name", "url"])("rejects %s mutation authority before requesting OAuth", async mode => {
  const getAccessToken = vi.fn(async () => "synthetic");
  const fetcher = vi.fn(); const call = createBoundedPipedreamLabels({ projectId: "proj_fixture", environment: "production", getAccessToken, fetcher });
  const identity = { externalUserId: "owner_fixture", accountId: "apn_fixture" };
  const input = mode === "arbitrary-name" ? { ...identity, kind: "create-label", name: "arbitrary" }
    : { ...identity, kind: "add-labels", messageId: "message_1", labelIds: mode === "system" ? ["INBOX"] : ["Label_123"],
      ...(mode === "remove" ? { removeLabelIds: ["INBOX"] } : mode === "url" ? { url: "https://attacker.test" } : {}) };
  await expect(call(input)).rejects.toThrow(); expect(getAccessToken).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});
