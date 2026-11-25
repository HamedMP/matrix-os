/**
 * Hand-written raw Gmail API replies, shaped like the `data` the gateway returns.
 */
import { b64url } from "./fake-bridge";

export const GMAIL_LABELS = {
  labels: [
    { id: "CHAT", name: "CHAT", type: "system" },
    { id: "SENT", name: "SENT", type: "system" },
    { id: "INBOX", name: "INBOX", type: "system" },
    { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
    { id: "TRASH", name: "TRASH", type: "system" },
    { id: "DRAFT", name: "DRAFT", type: "system" },
    { id: "SPAM", name: "SPAM", type: "system" },
    { id: "CATEGORY_PERSONAL", name: "CATEGORY_PERSONAL", type: "system" },
    { id: "STARRED", name: "STARRED", type: "system" },
    { id: "UNREAD", name: "UNREAD", type: "system" },
    { id: "Label_12", name: "Projects/Alpha", type: "user", labelListVisibility: "labelShow" },
    { id: "Label_11", name: "Projects", type: "user", labelListVisibility: "labelShow" },
    { id: "Label_30", name: "Receipts", type: "user", labelListVisibility: "labelShowIfUnread", threadsUnread: 2 },
    { id: "Label_40", name: "Muted", type: "user", labelListVisibility: "labelHide" },
  ],
};

export const GMAIL_INBOX_LABEL = {
  id: "INBOX", name: "INBOX", type: "system", messagesTotal: 812, messagesUnread: 9, threadsTotal: 640, threadsUnread: 7,
};

export const GMAIL_THREAD_LIST_PAGE_1 = {
  threads: [
    { id: "18c1a", snippet: "Older", historyId: "100" },
    { id: "18c2b", snippet: "Newer", historyId: "101" },
  ],
  nextPageToken: "09876543210",
  resultSizeEstimate: 42,
};

export const GMAIL_THREAD_LIST_LAST = { threads: [{ id: "18c3c", snippet: "", historyId: "102" }], resultSizeEstimate: 3 };

const header = (name: string, value: string) => ({ name, value });

/** Thread 18c1a in summary form: two messages, headers and part tree, no body data. */
export const GMAIL_THREAD_A_SUMMARY = {
  id: "18c1a",
  historyId: "100",
  messages: [
    {
      id: "m-a1", threadId: "18c1a", labelIds: ["INBOX", "CATEGORY_PERSONAL", "IMPORTANT"], snippet: "Can we move the review to Thursday?",
      internalDate: "1763892000000", sizeEstimate: 5120,
      payload: {
        mimeType: "multipart/mixed", filename: "",
        headers: [
          header("From", "\"Lovelace, Ada\" <Ada@Example.com>"),
          header("To", "Owner <owner@example.com>, bob@example.com (Bob Stone)"),
          header("Subject", "=?UTF-8?B?UmV2aWV3IOKAkyBRMw==?="),
        ],
        body: { size: 0 },
        parts: [
          { mimeType: "text/plain", filename: "", body: { size: 40 } },
          { mimeType: "application/pdf", filename: "agenda.pdf", body: { size: 20480, attachmentId: "ANGjdJ8" } },
        ],
      },
    },
    {
      id: "m-a2", threadId: "18c1a", labelIds: ["INBOX", "UNREAD", "STARRED", "Label_12"], snippet: "Thursday works &amp; I&#39;ll book a room",
      internalDate: "1763895600000", sizeEstimate: 2048,
      payload: {
        mimeType: "text/plain", filename: "",
        headers: [header("From", "Bob Stone <bob@example.com>"), header("To", "ada@example.com"), header("Cc", "owner@example.com")],
        body: { size: 30 },
      },
    },
  ],
};

/** Thread 18c2b in summary form: one later message with only an inline image. */
export const GMAIL_THREAD_B_SUMMARY = {
  id: "18c2b",
  historyId: "101",
  messages: [
    {
      id: "m-b1", threadId: "18c2b", labelIds: ["INBOX"], snippet: "Logo attached inline",
      internalDate: "1763899200000", sizeEstimate: 9000,
      payload: {
        mimeType: "multipart/related", filename: "",
        headers: [header("From", "news@shop.example"), header("To", "owner@example.com"), header("Subject", "Your order")],
        body: { size: 0 },
        parts: [
          { mimeType: "text/html", filename: "", body: { size: 100 } },
          {
            mimeType: "image/png", filename: "logo.png",
            headers: [header("Content-ID", "<logo@shop>"), header("Content-Disposition", "inline; filename=logo.png")],
            body: { size: 900, attachmentId: "IMG1" },
          },
        ],
      },
    },
  ],
};

export const GMAIL_THREAD_C_SUMMARY = {
  id: "18c3c",
  historyId: "102",
  messages: [{
    id: "m-c1", threadId: "18c3c", labelIds: ["Label_30"], snippet: "Receipt", internalDate: "1763800000000", sizeEstimate: 100,
    payload: { mimeType: "text/plain", filename: "", headers: [header("From", "billing@example.org"), header("Subject", "Receipt")], body: { size: 10 } },
  }],
};

const PLAIN_A1 = "Hi team,\nCan we move the review to Thursday?\n— Ada";
const HTML_A1 = "<html><head><style>p{color:red}</style></head><body><p>Hi team,</p><p>Can we move the review to <b>Thursday</b>?</p><script>alert(1)</script></body></html>";

/** Full message m-a1: mixed(alternative(plain, html), pdf attachment). */
export const GMAIL_MESSAGE_A1_FULL = {
  id: "m-a1", threadId: "18c1a", labelIds: ["INBOX", "CATEGORY_PERSONAL"], snippet: "Can we move the review to Thursday?",
  internalDate: "1763892000000", sizeEstimate: 5120,
  payload: {
    mimeType: "multipart/mixed", filename: "",
    headers: [
      header("From", "\"Lovelace, Ada\" <Ada@Example.com>"),
      header("To", "Owner <owner@example.com>, bob@example.com (Bob Stone)"),
      header("Cc", "Team: carol@example.com, dan@example.com;"),
      header("Subject", "=?UTF-8?B?UmV2aWV3IOKAkyBRMw==?="),
      header("Date", "Sun, 23 Nov 2025 10:00:00 +0000"),
      header("Message-ID", "<CAF-a1@mail.example.com>"),
      header("References", "<root@mail.example.com> <mid@mail.example.com>"),
    ],
    body: { size: 0 },
    parts: [
      {
        mimeType: "multipart/alternative", filename: "", headers: [header("Content-Type", "multipart/alternative; boundary=x")], body: { size: 0 },
        parts: [
          { mimeType: "text/plain", filename: "", headers: [header("Content-Type", "text/plain; charset=\"UTF-8\"")], body: { size: 48, data: b64url(PLAIN_A1) } },
          { mimeType: "text/html", filename: "", headers: [header("Content-Type", "text/html; charset=UTF-8")], body: { size: 140, data: b64url(HTML_A1) } },
        ],
      },
      {
        mimeType: "application/pdf", filename: "agenda.pdf",
        headers: [header("Content-Disposition", "attachment; filename=\"agenda.pdf\"")],
        body: { size: 20480, attachmentId: "ANGjdJ8" },
      },
    ],
  },
};

/** Full message m-a2: html only, Latin-1. */
export const GMAIL_MESSAGE_A2_FULL = {
  id: "m-a2", threadId: "18c1a", labelIds: ["INBOX", "UNREAD", "STARRED", "Label_12"], snippet: "Thursday works",
  internalDate: "1763895600000", sizeEstimate: 2048,
  payload: {
    mimeType: "text/html", filename: "",
    headers: [
      header("From", "Bob Stone <bob@example.com>"),
      header("To", "ada@example.com"),
      header("Subject", "Re: Review – Q3"),
      header("Content-Type", "text/html; charset=ISO-8859-1"),
      header("Message-ID", "<bob-2@mail.example.com>"),
      header("In-Reply-To", "<CAF-a1@mail.example.com>"),
      header("References", "<root@mail.example.com> <mid@mail.example.com> <CAF-a1@mail.example.com>"),
    ],
    body: { size: 40, data: Buffer.from("<div>Thursday works &amp; café is booked</div>", "latin1").toString("base64url") },
  },
};

/** A draft reply in the same thread. */
export const GMAIL_MESSAGE_A3_DRAFT = {
  id: "m-a3", threadId: "18c1a", labelIds: ["DRAFT"], snippet: "Sounds good",
  internalDate: "1763896600000", sizeEstimate: 900,
  payload: {
    mimeType: "text/plain", filename: "",
    headers: [header("To", "bob@example.com"), header("Subject", "Re: Review – Q3")],
    body: { size: 11, data: b64url("Sounds good") },
  },
};

/** Thread 18c1a in full form, delivered newest first to prove the adapter sorts. */
export const GMAIL_THREAD_A_FULL = {
  id: "18c1a", historyId: "100", messages: [GMAIL_MESSAGE_A3_DRAFT, GMAIL_MESSAGE_A2_FULL, GMAIL_MESSAGE_A1_FULL],
};

export const GMAIL_DRAFT_LIST = {
  drafts: [{ id: "r-555", message: { id: "m-a3", threadId: "18c1a" } }, { id: "r-556", message: { id: "m-zz", threadId: "18c9z" } }],
  resultSizeEstimate: 2,
};

export const GMAIL_SENT_SEARCH = {
  messages: [{ id: "m-s1", threadId: "t-s1" }, { id: "m-s2", threadId: "t-s2" }],
  resultSizeEstimate: 2,
};

export function gmailSentMessage(id: string, internalDate: string, text: string) {
  return {
    id, threadId: `t-${id}`, labelIds: ["SENT"], snippet: text, internalDate, sizeEstimate: 300,
    payload: {
      mimeType: "text/plain", filename: "",
      headers: [header("From", "owner@example.com"), header("To", "ada@example.com"), header("Subject", "Notes")],
      body: { size: text.length, data: b64url(text) },
    },
  };
}

export const GMAIL_ATTACHMENT = { size: 13, data: b64url("hello?>>world").replace(/=+$/, "") };
