import { expect, it, vi } from "vitest";
import { EMAIL_TRIAGE_LABELS } from "@matrix-os/contracts";
import { executeJevBoundLabels } from "../../packages/gateway/src/integrations/jev-bound-labels.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";

function fixture() {
  const assigned = new Set(["INBOX", "UNREAD", "Label_Existing"]);
  const boundedGmailGet = vi.fn(async () => ({ emailAddress: "me@example.test" }));
  const boundedGmailLabels = vi.fn(async (raw: unknown) => {
    const i = raw as { kind: string; labelIds: string[] };
    if (i.kind === "labels") return { labels: [{ id: "Label_News", name: EMAIL_TRIAGE_LABELS.newsletter, type: "user" }] };
    if (i.kind === "message-labels") return { id: "message_1", threadId: "thread_1", labelIds: [...assigned] };
    if (i.kind === "add-labels") { i.labelIds.forEach(id => assigned.add(id)); return {}; }
    throw new Error("Unexpected external operation");
  });
  const opts = { ownerId: "owner_fixture", externalUserId: "owner_fixture", connection: { id: "conn_1", user_id: "owner_fixture",
    service: "gmail", status: "active", account_label: "My Gmail", account_email: "me@example.test", pipedream_account_id: "apn_1" },
    binding: { service: "gmail" as const, accountLabel: "My Gmail", expectedEmail: "me@example.test", connectionId: "conn_1", labelingEnabled: true },
    input: { threadId: "thread_1", messageIds: ["message_1"], labels: [EMAIL_TRIAGE_LABELS.newsletter] },
    pipedream: { boundedGmailGet, boundedGmailLabels } as unknown as PipedreamConnectClient, signal: new AbortController().signal };
  return { opts, assigned, boundedGmailLabels, boundedGmailGet };
}
it("reuses a category label and confirms Gmail readback while preserving Inbox, Unread and owner labels", async () => {
  const f = fixture();
  expect(await executeJevBoundLabels(f.opts)).toEqual({ confirmed: true, messageIds: ["message_1"], labelIds: ["Label_News"] });
  expect([...f.assigned]).toEqual(["INBOX", "UNREAD", "Label_Existing", "Label_News"]);
  await executeJevBoundLabels(f.opts);
  expect([...f.assigned]).toHaveLength(4);
});
it.each(["grant", "owner", "connection", "profile"])("denies %s mismatch before label inventory or writes", async mode => {
  const f = fixture();
  if (mode === "grant") f.opts.binding.labelingEnabled = false;
  if (mode === "owner") f.opts.connection.user_id = "foreign_owner";
  if (mode === "connection") f.opts.connection.id = "foreign_connection";
  if (mode === "profile") f.boundedGmailGet.mockResolvedValue({ emailAddress: "foreign@example.test" });
  await expect(executeJevBoundLabels(f.opts)).rejects.toThrow(); expect(f.boundedGmailLabels).not.toHaveBeenCalled();
});
it("requires independent label readback, not the provider's write reply", async () => {
  const f = fixture(); const original = f.boundedGmailLabels.getMockImplementation()!;
  f.boundedGmailLabels.mockImplementation(async raw => (raw as { kind: string }).kind === "add-labels" ? { success: true } : original(raw));
  await expect(executeJevBoundLabels(f.opts)).rejects.toThrow();
  expect([...f.assigned]).toEqual(["INBOX", "UNREAD", "Label_Existing"]);
});
it("creates only a missing fixed category label and uses its returned user label ID", async () => {
  const f = fixture(); const original = f.boundedGmailLabels.getMockImplementation()!;
  f.boundedGmailLabels.mockImplementation(async raw => {
    const i = raw as { kind: string; name?: string };
    if (i.kind === "labels") return { labels: [] };
    if (i.kind === "create-label") return { id: "Label_News", name: i.name, type: "user" };
    return original(raw);
  });
  await expect(executeJevBoundLabels(f.opts)).resolves.toMatchObject({ confirmed: true, labelIds: ["Label_News"] });
});
