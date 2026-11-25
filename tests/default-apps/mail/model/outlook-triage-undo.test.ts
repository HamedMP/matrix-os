/**
 * Triage of an Outlook conversation outside a real folder view (search
 * results). The conversation's messages sit in several folders, so no single
 * folder may be guessed: trash and move act on the whole conversation, and undo
 * puts each message back where it was.
 */
import { describe, expect, it } from "vitest";
import { createOutlookProvider } from "../../../../home/apps/_shared/office-accounts/mail/outlook-provider";
import { outlookFolders, summarizeGraphMessages, type GraphFolder } from "../../../../home/apps/_shared/office-accounts/mail/outlook-normalize";
import type { MailAccount, MailFolderRole } from "../../../../home/apps/_shared/office-accounts/types/mail";
import { applyChangeToSummary, inverseChange, triageChangeFor } from "../../../../home/apps/mail/src/model/thread-ops";
import { FakeBridge } from "../../office-accounts/mail/fake-bridge";

const SERVICE = "microsoft_outlook";
const ACCOUNT: MailAccount = { id: "outlook:me@contoso.com", provider: "outlook", address: "me@contoso.com", displayName: "me" };

function graph(id: string, folder: string, at: string, fromMe: boolean) {
  return {
    id, conversationId: "CONV1", parentFolderId: folder, receivedDateTime: at, sentDateTime: at, isRead: true,
    subject: "Hello", bodyPreview: "x", from: { emailAddress: { address: fromMe ? "me@contoso.com" : "bob@fabrikam.com" } },
    toRecipients: [], ccRecipients: [], flag: { flagStatus: "notFlagged" }, hasAttachments: false, isDraft: false,
  };
}

const wellKnown = new Map<MailFolderRole, GraphFolder>([
  ["inbox", { id: "INBOX", displayName: "Inbox" }], ["sent", { id: "SENT", displayName: "Sent Items" }],
  ["trash", { id: "TRASH", displayName: "Deleted Items" }], ["archive", { id: "ARCH", displayName: "Archive" }],
] as Array<[MailFolderRole, GraphFolder]>);
const FOLDERS = outlookFolders([{ id: "PROJ", displayName: "Projects" } as GraphFolder], wellKnown);

/** The owner's reply M2 in Sent Items, Bob's message M1 in the Inbox. */
function setup() {
  const messages = [graph("M2", "SENT", "2026-11-20T10:00:00Z", true), graph("M1", "INBOX", "2026-11-19T10:00:00Z", false)];
  const [summary] = summarizeGraphMessages(messages, ACCOUNT.id);
  const bridge = new FakeBridge();
  bridge.handle(SERVICE, "list_conversation", () => ({ value: messages }));
  bridge.handle(SERVICE, "move_message", (params) => {
    const message = messages.find((m) => m.id === params.messageId)!;
    message.parentFolderId = params.destinationFolderId as string;
    return { ...message };
  });
  const provider = createOutlookProvider({ account: ACCOUNT, bridge });
  const folderOf = () => Object.fromEntries(messages.map((m) => [m.id, m.parentFolderId]));
  return { summary, bridge, provider, folderOf };
}

describe("outlook triage from search results", () => {
  it("does not guess the newest message's folder as the source", () => {
    const { summary } = setup();
    expect(summary.folderIds).toEqual(["SENT", "INBOX"]);
    expect(triageChangeFor("trash", summary, { folders: FOLDERS, provider: "outlook" })).toEqual({ addFolders: ["TRASH"] });
    expect(triageChangeFor("move", summary, { folders: FOLDERS, provider: "outlook", toFolderId: "PROJ" })).toEqual({ addFolders: ["PROJ"] });
  });

  it("trashes every message of the conversation, and undo puts each back in its own folder", async () => {
    const { summary, provider, folderOf } = setup();
    const trash = triageChangeFor("trash", summary, { folders: FOLDERS, provider: "outlook" });
    await provider.modifyThreads(["CONV1"], trash);
    expect(folderOf()).toEqual({ M1: "TRASH", M2: "TRASH" });

    const undo = inverseChange(summary, trash, "outlook");
    expect(applyChangeToSummary(applyChangeToSummary(summary, trash, "outlook"), undo, "outlook").folderIds.sort()).toEqual(["INBOX", "SENT"]);
    await provider.modifyThreads(["CONV1"], undo);
    expect(folderOf()).toEqual({ M1: "INBOX", M2: "SENT" });
  });

  it("undoes an archive by returning the archived inbox mail to the Inbox, never into Sent Items", async () => {
    const { summary, provider, folderOf, bridge } = setup();
    const archive = triageChangeFor("archive", summary, { folders: FOLDERS, provider: "outlook" });
    await provider.modifyThreads(["CONV1"], archive);
    expect(folderOf()).toEqual({ M1: "ARCH", M2: "SENT" });

    const undo = inverseChange(summary, archive, "outlook");
    expect(undo.addFolders).not.toEqual(["SENT"]);
    bridge.calls.length = 0;
    await provider.modifyThreads(["CONV1"], undo);
    expect(folderOf()).toEqual({ M1: "INBOX", M2: "SENT" });
    expect(bridge.callsTo("move_message").map((call) => call.params)).toEqual([{ messageId: "M1", destinationFolderId: "INBOX" }]);
  });
});
