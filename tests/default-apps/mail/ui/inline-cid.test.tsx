// @vitest-environment jsdom
/**
 * Inline `cid:` images are matched by the attachment's Content-ID, not only by
 * its file name: Gmail web and most clients use ids unrelated to the name.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React, { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeGmailMessage } from "../../../../home/apps/_shared/office-accounts/mail/gmail-normalize";
import { readGraphAttachments } from "../../../../home/apps/_shared/office-accounts/mail/outlook-normalize";
import { createOutlookProvider } from "../../../../home/apps/_shared/office-accounts/mail/outlook-provider";
import { untrustedHtml, type MailMessage, type MailProvider } from "../../../../home/apps/_shared/office-accounts/types/mail";
import { MailUiContext, type MailUi } from "../../../../home/apps/mail/src/ui/context";
import { MessageCard } from "../../../../home/apps/mail/src/ui/MessageCard";
import { FakeBridge, b64url } from "../../office-accounts/mail/fake-bridge";
import { PNG_BASE64, PNG_DATA_URL } from "../html/helpers";

afterEach(cleanup);

function gmailRaw(imageHeaders: Array<{ name: string; value: string }>) {
  return {
    id: "m1", threadId: "t1", internalDate: "1763000000000", labelIds: [],
    payload: {
      mimeType: "multipart/related", headers: [{ name: "From", value: "Ada <ada@example.com>" }, { name: "Subject", value: "Logo" }],
      parts: [
        { mimeType: "text/html", headers: [], body: { data: b64url('<p>Hi</p><img src="cid:ii_m1abc2de0">') } },
        { mimeType: "image/png", filename: "image.png", headers: imageHeaders, body: { attachmentId: "ATT1", size: 68 } },
      ],
    },
  };
}

describe("attachment Content-IDs", () => {
  it("reads the Gmail part's Content-ID without angle brackets", () => {
    const message = normalizeGmailMessage(gmailRaw([{ name: "Content-ID", value: "<ii_m1abc2de0>" }, { name: "Content-Disposition", value: "inline" }]));
    expect(message.attachments[0]).toMatchObject({ id: "ATT1", name: "image.png", inline: true, contentId: "ii_m1abc2de0" });
  });

  it("falls back to X-Attachment-Id and ignores a malformed id", () => {
    expect(normalizeGmailMessage(gmailRaw([{ name: "X-Attachment-Id", value: "ii_m1abc2de0" }])).attachments[0].contentId).toBe("ii_m1abc2de0");
    expect(normalizeGmailMessage(gmailRaw([{ name: "Content-ID", value: "<a b\"c>" }])).attachments[0].contentId).toBeUndefined();
  });

  it("reads Graph's contentId from the attachment list and from the attachment itself", async () => {
    expect(readGraphAttachments({ value: [{ id: "A1", name: "image.png", contentType: "image/png", size: 68, isInline: true, contentId: "f_abc@01DA" }] })[0])
      .toMatchObject({ contentId: "f_abc@01DA", inline: true });
    const bridge = new FakeBridge();
    bridge.reply("microsoft_outlook", "list_attachments", { value: [{ id: "A1", name: "image.png", contentType: "image/png", size: 68, isInline: true }] })
      .reply("microsoft_outlook", "get_attachment", { id: "A1", name: "image.png", contentType: "image/png", size: 68, contentBytes: PNG_BASE64, contentId: "<9F2C-UUID@host>" });
    const provider = createOutlookProvider({ account: { id: "outlook:me@contoso.com", provider: "outlook", address: "me@contoso.com", displayName: "me" }, bridge });
    expect(await provider.getAttachment("MSG1", "A1")).toMatchObject({ contentId: "9F2C-UUID@host" });
  });
});

function Card({ message, provider }: { message: MailMessage; provider: MailProvider }) {
  const dragKeys = useRef([]);
  const ui = { timeZone: "UTC", now: () => Date.parse("2026-11-20T00:00:00Z"), ownAddresses: [], dragKeys, notify: () => undefined } as unknown as MailUi;
  return (
    <MailUiContext.Provider value={ui}>
      <MessageCard message={message} provider={provider} expanded onToggle={() => undefined} />
    </MailUiContext.Provider>
  );
}

function frameImage(): string | null {
  const doc = new DOMParser().parseFromString(screen.getByTitle(/Message from/).getAttribute("srcdoc") ?? "", "text/html");
  return doc.querySelector("img")?.getAttribute("src") ?? null;
}

describe("MessageCard inline images", () => {
  const base: Omit<MailMessage, "attachments" | "bodyHtml"> = {
    id: "m1", threadId: "t1", from: { address: "ada@example.com" }, to: [], cc: [], bcc: [], sentAt: "2026-11-19T10:00:00Z",
    subject: "Logo", bodyText: "Hi", messageIdHeader: null, references: [],
  };
  const provider = { getAttachment: async () => ({ name: "image.png", mimeType: "image/png", size: 68, contentBase64: PNG_BASE64 }) } as unknown as MailProvider;

  it("shows an image whose Content-ID differs from its file name", async () => {
    const message: MailMessage = {
      ...base, bodyHtml: untrustedHtml('<p>Hi</p><img src="cid:ii_m1abc2de0" alt="Logo">'),
      attachments: [{ id: "ATT1", name: "image.png", mimeType: "image/png", size: 68, inline: true, contentId: "ii_m1abc2de0" }],
    };
    render(<Card message={message} provider={provider} />);
    await waitFor(() => expect(frameImage()).toBe(PNG_DATA_URL));
  });

  it("uses the Content-ID the provider returns with the content when the list had none", async () => {
    const withId = { getAttachment: async () => ({ name: "image.png", mimeType: "image/png", size: 68, contentBase64: PNG_BASE64, contentId: "9F2C-UUID@host" }) } as unknown as MailProvider;
    const message: MailMessage = {
      ...base, bodyHtml: untrustedHtml('<img src="cid:9F2C-UUID@host" alt="Logo">'),
      attachments: [{ id: "ATT1", name: "image.png", mimeType: "image/png", size: 68, inline: true }],
    };
    render(<Card message={message} provider={withId} />);
    await waitFor(() => expect(frameImage()).toBe(PNG_DATA_URL));
  });
});
