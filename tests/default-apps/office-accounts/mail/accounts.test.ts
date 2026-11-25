import { afterEach, describe, expect, it } from "vitest";
import { listConnected, listMailAccounts } from "../../../../home/apps/_shared/office-accounts/accounts";
import { createMailProvider } from "../../../../home/apps/_shared/office-accounts/mail/index";
import { FakeBridge, statusError } from "./fake-bridge";

function inventory() {
  const bridge = new FakeBridge();
  bridge.connected = [
    { service: "gmail", account_label: "Personal", status: "active" },
    { service: "google_calendar", account_label: "ada@example.com", status: "active" },
    { service: "microsoft_outlook", account_label: "Work", account_email: "Ada.L@Contoso.com", status: "active" },
    { service: "gmail", account_label: "Personal", status: "active" },
    { service: "gmail", account_label: "old@example.com", status: "expired" },
    { service: "slack", account_label: "team", status: "active" },
    { service: "microsoft_outlook", account_label: "ops@contoso.com", status: "active" },
  ];
  return bridge;
}

describe("listConnected", () => {
  it("keeps active accounts of the requested services once each, with any known address", async () => {
    const bridge = inventory();
    expect(await listConnected(["gmail", "google_calendar"], bridge)).toEqual([
      { service: "gmail", label: "Personal", email: null },
      { service: "google_calendar", label: "ada@example.com", email: "ada@example.com" },
    ]);
    expect(await listConnected(["microsoft_outlook"], bridge)).toEqual([
      { service: "microsoft_outlook", label: "Work", email: "ada.l@contoso.com" },
      { service: "microsoft_outlook", label: "ops@contoso.com", email: "ops@contoso.com" },
    ]);
    expect(bridge.calls).toHaveLength(0);
  });

  it("rejects with not_supported when the host offers no integrations, without reading the inventory", async () => {
    const bridge = inventory();
    bridge.caps = { version: 1, integrations: false, ai: true };
    await expect(listConnected(["gmail"], bridge)).rejects.toMatchObject({ code: "not_supported" });
    expect(bridge.integrationsCalls).toBe(0);
  });

  it("maps an inventory failure to a generic error", async () => {
    const bridge = inventory();
    bridge.integrations = async () => { throw statusError(503); };
    const error = (await listConnected(["gmail"], bridge).catch((caught: unknown) => caught)) as Error;
    expect(error).toMatchObject({ code: "failed" });
    expect(error.message).not.toMatch(/tenant/);
  });
});

describe("listMailAccounts", () => {
  it("learns missing addresses from the provider and builds one account per mailbox", async () => {
    const bridge = inventory();
    bridge.reply("gmail", "get_profile", { emailAddress: "Ada@Example.com", messagesTotal: 10, threadsTotal: 5, historyId: "1" });
    const accounts = await listMailAccounts(bridge);
    expect(bridge.calls).toEqual([{ service: "gmail", action: "get_profile", params: {}, label: "Personal" }]);
    expect(accounts).toEqual([
      { id: "gmail:ada@example.com", provider: "gmail", address: "ada@example.com", displayName: "Personal", label: "Personal" },
      { id: "outlook:ada.l@contoso.com", provider: "outlook", address: "ada.l@contoso.com", displayName: "Work", label: "Work" },
      { id: "outlook:ops@contoso.com", provider: "outlook", address: "ops@contoso.com", displayName: "ops@contoso.com", label: "ops@contoso.com" },
    ]);
  });

  it("reads an Outlook address from the newest sent message, falls back to the label and skips a vanished account", async () => {
    const bridge = new FakeBridge();
    bridge.connected = [
      { service: "microsoft_outlook", account_label: "Team", status: "active" },
      { service: "gmail", account_label: "Side", status: "active" },
      { service: "gmail", account_label: "Gone", status: "active" },
    ];
    bridge.reply("microsoft_outlook", "list_folder_messages", { value: [{ id: "m", from: { emailAddress: { name: "Team", address: "Team@Contoso.com" } } }] });
    bridge.handle("gmail", "get_profile", () => { throw statusError(502); });
    const accounts = await listMailAccounts(bridge);
    expect(bridge.callsTo("list_folder_messages")[0]).toMatchObject({ params: { folderId: "sentitems", top: 1 }, label: "Team" });
    expect(accounts.map((account) => account.id)).toEqual(["outlook:team@contoso.com", "gmail:side", "gmail:gone"]);

    const vanishing = new FakeBridge();
    vanishing.connected = [{ service: "gmail", account_label: "Gone", status: "active" }];
    vanishing.fail("gmail", "get_profile", statusError(404));
    expect(await listMailAccounts(vanishing)).toEqual([]);
  });
});

describe("createMailProvider and the default bridge", () => {
  const scope = globalThis as { window?: unknown };
  afterEach(() => { delete scope.window; });

  it("routes each account to its provider with the account label", async () => {
    const bridge = new FakeBridge();
    bridge.reply("microsoft_outlook", "send_draft", undefined).reply("gmail", "send_draft", {});
    await createMailProvider({ id: "outlook:a@b.co", provider: "outlook", address: "a@b.co", displayName: "A", label: "Work" }, bridge).sendDraft("d1");
    await createMailProvider({ id: "gmail:a@b.co", provider: "gmail", address: "a@b.co", displayName: "A", label: "Home" }, bridge).sendDraft("d2");
    expect(bridge.calls.map(({ service, params, label }) => [service, params, label])).toEqual([
      ["microsoft_outlook", { messageId: "d1" }, "Work"],
      ["gmail", { draftId: "d2" }, "Home"],
    ]);
  });

  it("uses window.MatrixOS when no bridge is given, and is not_supported without one", async () => {
    await expect(listMailAccounts()).rejects.toMatchObject({ code: "not_supported" });
    const bridge = inventory();
    bridge.reply("gmail", "get_profile", { emailAddress: "ada@example.com" });
    scope.window = { MatrixOS: bridge };
    expect(await listMailAccounts()).toHaveLength(3);
  });
});
