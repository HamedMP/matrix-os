/**
 * Hand-written raw Microsoft Graph replies, shaped like the `data` the gateway returns.
 */
export const IDS = {
  inbox: "AAMkAGInbox=",
  sent: "AAMkAGSent=",
  drafts: "AAMkAGDrafts=",
  deleted: "AAMkAGDeleted=",
  junk: "AAMkAGJunk=",
  projects: "AAMkAGProjects=",
  alpha: "AAMkAGAlpha=",
  root: "AAMkAGRoot=",
} as const;

const folder = (id: string, displayName: string, unreadItemCount = 0, parentFolderId: string = IDS.root) => ({
  id, displayName, parentFolderId, unreadItemCount, totalItemCount: 10, childFolderCount: 0,
});

/** Display names are localised to prove roles never come from names. */
export const OUTLOOK_FOLDER_LIST = {
  value: [
    folder(IDS.inbox, "Posteingang", 4),
    folder(IDS.sent, "Gesendete Elemente"),
    folder(IDS.drafts, "Entwürfe", 1),
    folder(IDS.deleted, "Gelöschte Elemente"),
    folder(IDS.junk, "Junk-E-Mail"),
    folder(IDS.projects, "Projects", 2),
  ],
};

export const OUTLOOK_WELL_KNOWN_REPLIES: Record<string, unknown> = {
  inbox: folder(IDS.inbox, "Posteingang", 4),
  sentitems: folder(IDS.sent, "Gesendete Elemente"),
  drafts: folder(IDS.drafts, "Entwürfe", 1),
  junkemail: folder(IDS.junk, "Junk-E-Mail"),
  deleteditems: folder(IDS.deleted, "Gelöschte Elemente"),
};

export const OUTLOOK_ALPHA_FOLDER = folder(IDS.alpha, "Alpha", 0, IDS.projects);

const who = (address: string, name?: string) => ({ emailAddress: name ? { name, address } : { address } });

export function graphMessage(overrides: Record<string, unknown>) {
  return {
    id: "msg-x",
    conversationId: "conv-x",
    internetMessageId: "<x@outlook.example>",
    subject: "Subject",
    bodyPreview: "Preview",
    from: who("someone@example.com", "Someone"),
    toRecipients: [who("owner@contoso.com", "Owner")],
    ccRecipients: [],
    sentDateTime: "2025-11-20T09:00:00Z",
    receivedDateTime: "2025-11-20T09:00:05Z",
    isRead: true,
    isDraft: false,
    flag: { flagStatus: "notFlagged" },
    hasAttachments: false,
    parentFolderId: IDS.inbox,
    ...overrides,
  };
}

/** One inbox page: conversation A (two messages, one unread and flagged), conversation B (one message). */
export const OUTLOOK_INBOX_PAGE = {
  value: [
    graphMessage({
      id: "msg-a2", conversationId: "conv-A", subject: "RE: Budget", bodyPreview: "Numbers attached &amp; ready",
      from: who("Grace@Contoso.com", "Grace Hopper"), toRecipients: [who("owner@contoso.com", "Owner")], ccRecipients: [who("ken@contoso.com")],
      sentDateTime: "2025-11-21T15:00:00Z", receivedDateTime: "2025-11-21T15:00:02Z", isRead: false, flag: { flagStatus: "flagged" }, hasAttachments: true,
    }),
    graphMessage({
      id: "msg-b1", conversationId: "conv-B", subject: "Lunch?", bodyPreview: "Free at noon?",
      from: who("linus@example.org", "linus@example.org"), sentDateTime: "2025-11-21T12:00:00Z", receivedDateTime: "2025-11-21T12:00:01Z",
    }),
    graphMessage({
      id: "msg-a1", conversationId: "conv-A", subject: "Budget", bodyPreview: "Can you send the numbers?",
      from: who("owner@contoso.com", "Owner"), toRecipients: [who("grace@contoso.com", "Grace Hopper")],
      sentDateTime: "2025-11-21T10:00:00Z", receivedDateTime: "2025-11-21T10:00:01Z",
    }),
  ],
  "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=3",
};

/** The next inbox page repeats conversation A with an older message. */
export const OUTLOOK_INBOX_PAGE_2 = {
  value: [
    graphMessage({ id: "msg-a0", conversationId: "conv-A", subject: "Budget", receivedDateTime: "2025-11-19T08:00:00Z" }),
    graphMessage({ id: "msg-c1", conversationId: "conv-C", subject: "Newsletter", receivedDateTime: "2025-11-18T08:00:00Z" }),
  ],
};

/** Conversation A in full, out of order, as `list_conversation` returns it. */
export const OUTLOOK_CONVERSATION_A = {
  value: [
    {
      ...OUTLOOK_INBOX_PAGE.value[0],
      bccRecipients: [],
      replyTo: [],
      body: { contentType: "html", content: "<html><body><p>Numbers attached &amp; ready.</p><img src=\"https://tracker.example/p.gif\"></body></html>" },
    },
    {
      ...OUTLOOK_INBOX_PAGE.value[2],
      parentFolderId: IDS.sent,
      bccRecipients: [who("audit@contoso.com")],
      replyTo: [],
      body: { contentType: "text", content: "Can you send the numbers?" },
    },
  ],
};

export const OUTLOOK_ATTACHMENTS_A2 = {
  value: [
    { id: "att-1", name: "budget.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 18000, isInline: false },
    { id: "att-2", name: "image001.png", contentType: "image/png", size: 3000, isInline: true },
  ],
};

export const OUTLOOK_ATTACHMENT_CONTENT = {
  "@odata.type": "#microsoft.graph.fileAttachment",
  id: "att-1", name: "budget.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  size: 11, contentBytes: "aGVsbG8gd29ybGQ=",
};

export const OUTLOOK_SEARCH_PAGE = {
  value: [
    graphMessage({ id: "msg-s1", conversationId: "conv-S", subject: "Invoice 42", receivedDateTime: "2025-11-10T10:00:00Z" }),
  ],
  "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$search=%22invoice%22&$top=25&$skiptoken=MSZZVlhZ",
};

export const OUTLOOK_SENT_SEARCH = {
  value: [
    graphMessage({ id: "sent-1", conversationId: "c1", from: who("owner@contoso.com"), parentFolderId: IDS.sent, sentDateTime: "2025-11-01T10:00:00Z" }),
    graphMessage({ id: "sent-2", conversationId: "c2", from: who("delegate@contoso.com"), parentFolderId: IDS.sent }),
    graphMessage({ id: "sent-3", conversationId: "c3", from: who("OWNER@contoso.com"), parentFolderId: IDS.sent, sentDateTime: "2025-11-05T10:00:00Z" }),
  ],
};

export function fullSent(id: string, sentDateTime: string, html: string) {
  return graphMessage({ id, sentDateTime, from: who("owner@contoso.com"), parentFolderId: IDS.sent, body: { contentType: "html", content: html }, bccRecipients: [] });
}

/** The reduced echo of a write (`$select=id,conversationId,parentFolderId,isRead,isDraft,flag`). */
export function writeEcho(id: string, overrides: Record<string, unknown> = {}) {
  return { id, conversationId: "conv-D", parentFolderId: IDS.drafts, isRead: true, isDraft: true, flag: { flagStatus: "notFlagged" }, ...overrides };
}
