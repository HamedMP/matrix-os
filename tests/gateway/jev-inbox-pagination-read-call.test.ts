import { describe, expect, it, vi } from "vitest";
import { createIntegrationReadCallRoutes } from "../../packages/gateway/src/integrations/read-call.js";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import { getAction, getService } from "../../packages/gateway/src/integrations/registry.js";
import { validateActionParams } from "../../packages/gateway/src/integrations/parameter-validation.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";

const binding = { service: "gmail", accountLabel: "My Gmail", connectionId: "conn_fixture", expectedEmail: "me@example.test" };
function fixture() {
  const connection = { id: binding.connectionId, user_id: "owner_fixture", service: "gmail", status: "active",
    account_label: binding.accountLabel, account_email: binding.expectedEmail, pipedream_account_id: "apn_fixture" };
  const boundedGmailGet = vi.fn(async (input: { kind: string }) => input.kind === "profile"
    ? { emailAddress: binding.expectedEmail } : { threads: [{ id: "second_page_thread" }] });
  const proxyGet = vi.fn();
  const pipedream = { boundedGmailGet, proxyGet } as unknown as PipedreamConnectClient;
  const db = { listConnectedServices: vi.fn(async () => [connection]),
    getUserById: vi.fn(async () => ({ pipedream_external_id: "pd_owner_fixture" })), touchServiceUsage: vi.fn() };
  const app = createIntegrationReadCallRoutes({ db: db as unknown as PlatformDb, pipedream,
    resolveUserId: async () => "owner_fixture" });
  const call = (params: unknown) => app.request("/read-call", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ service: "gmail", action: "list_threads", label: binding.accountLabel, params, binding }) });
  return { call, boundedGmailGet, proxyGet, db, pipedream, connection };
}

describe("bounded Inbox thread pagination at integration validation", () => {
  it("accepts a second-page cursor and passes it to the same profile-verified account", async () => {
    const f = fixture();
    const token = "opaque+/=&labelIds=TRASH";
    const response = await f.call({ pageToken: token });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { threads: [{ id: "second_page_thread" }] } });
    expect(f.boundedGmailGet).toHaveBeenNthCalledWith(1,
      { kind: "profile", externalUserId: "pd_owner_fixture", accountId: "apn_fixture" }, expect.any(AbortSignal));
    expect(f.boundedGmailGet).toHaveBeenNthCalledWith(2,
      { kind: "threads", externalUserId: "pd_owner_fixture", accountId: "apn_fixture", pageToken: token }, expect.any(AbortSignal));
    expect(f.proxyGet).not.toHaveBeenCalled();
  });

  it("forwards the cursor on the ordinary bounded read execution path", async () => {
    const f = fixture();
    await executeIntegrationAction({ pipedream: f.pipedream, externalUserId: "pd_owner_fixture", connection: f.connection,
      def: getService("gmail")!, actionDef: getAction("gmail", "list_threads")!, serviceId: "gmail", actionId: "list_threads",
      params: { pageToken: "next-page" } });
    expect(f.boundedGmailGet).toHaveBeenCalledExactlyOnceWith({ kind: "threads", externalUserId: "pd_owner_fixture",
      accountId: "apn_fixture", pageToken: "next-page" });
    expect(f.proxyGet).not.toHaveBeenCalled();
  });

  it("keeps the direct mapping fixed to Inbox and 30 results while encoding an opaque cursor", () => {
    const action = getAction("gmail", "list_threads")!;
    const token = "opaque+/=&labelIds=TRASH";
    const url = new URL(typeof action.directApi!.url === "function" ? action.directApi!.url({ pageToken: token }) : action.directApi!.url);
    expect(url.searchParams.get("pageToken")).toBe(token);
    expect(url.searchParams.getAll("labelIds")).toEqual(["INBOX"]);
    expect(url.searchParams.get("maxResults")).toBe("30");
    expect(validateActionParams(action, { pageToken: "x".repeat(4096) }).valid).toBe(true);
    expect(validateActionParams(action, {}).valid).toBe(true);
  });

  it.each([{ pageToken: "" }, { pageToken: "x".repeat(4097) }, { pageToken: 1 }, { pageToken: "bad\nheader" },
    { pageToken: "has space" }, { pageToken: "next", maxResults: 500 }, { pageToken: "next", labelIds: "TRASH" },
    { pageToken: "next", query: "in:anywhere" }])("rejects invalid cursors and scope overrides before account/provider access: %j", async params => {
    const f = fixture();
    expect((await f.call(params)).status).toBe(400);
    expect(f.db.listConnectedServices).not.toHaveBeenCalled();
    expect(f.boundedGmailGet).not.toHaveBeenCalled();
    expect(f.proxyGet).not.toHaveBeenCalled();
  });
});
