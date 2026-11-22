import type {
  MailAccount,
  MailFolder,
  MailMessage,
  MailThread,
  ThreadSummary,
} from "../../../../home/apps/_shared/office-accounts/types/mail";
import { untrustedHtml } from "../../../../home/apps/_shared/office-accounts/types/mail";

export const GMAIL: MailAccount = { id: "gmail:me@example.com", provider: "gmail", address: "me@example.com", displayName: "Me" };
export const OUTLOOK: MailAccount = { id: "outlook:me@work.example", provider: "outlook", address: "me@work.example", displayName: "Work" };

export const GMAIL_FOLDERS: MailFolder[] = [
  { id: "INBOX", name: "Inbox", role: "inbox", unreadCount: 2 },
  { id: "SENT", name: "Sent", role: "sent" },
  { id: "DRAFT", name: "Drafts", role: "drafts" },
  { id: "ARCHIVE", name: "All mail", role: "archive", virtual: true },
  { id: "TRASH", name: "Trash", role: "trash" },
  { id: "SPAM", name: "Spam", role: "spam" },
  { id: "STARRED", name: "Starred", role: "starred", virtual: true },
  { id: "Label_1", name: "Projects", role: "custom" },
  { id: "Label_2", name: "Alpha", role: "custom", parentId: "Label_1" },
];

export const OUTLOOK_FOLDERS: MailFolder[] = [
  { id: "inbox-id", name: "Inbox", role: "inbox" },
  { id: "sent-id", name: "Sent Items", role: "sent" },
  { id: "archive-id", name: "Archive", role: "archive" },
  { id: "trash-id", name: "Deleted Items", role: "trash" },
  { id: "flagged", name: "Flagged", role: "starred", virtual: true },
  { id: "proj-id", name: "Projects", role: "custom" },
];

export function summary(id: string, overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id,
    accountId: GMAIL.id,
    subject: `Subject ${id}`,
    snippet: `Snippet ${id}`,
    participants: [{ name: "Alice", address: "alice@example.com" }],
    lastMessageAt: "2026-11-10T09:00:00Z",
    unread: false,
    flagged: false,
    hasAttachments: false,
    folderIds: ["INBOX"],
    messageCount: 1,
    ...overrides,
  };
}

export function message(id: string, overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id,
    threadId: "t1",
    from: { name: "Alice", address: "alice@example.com" },
    to: [{ name: "Me", address: "me@example.com" }],
    cc: [],
    bcc: [],
    sentAt: "2026-11-10T09:00:00Z",
    subject: "Plans",
    bodyText: "Hello\nSee you <soon> & bye",
    bodyHtml: untrustedHtml("<p>Hello</p><script>x()</script>"),
    attachments: [],
    messageIdHeader: `<${id}@mail.example.com>`,
    references: [],
    ...overrides,
  };
}

export function thread(id: string, messages: MailMessage[], overrides: Partial<MailThread> = {}): MailThread {
  return { id, accountId: GMAIL.id, subject: messages[0]?.subject ?? "", folderIds: ["INBOX"], messages, ...overrides };
}

/** Summaries t1..tn, newest first, one minute apart. */
export function page(prefix: string, count: number, start = 0, overrides: Partial<ThreadSummary> = {}): ThreadSummary[] {
  return Array.from({ length: count }, (_, i) => {
    const n = start + i;
    const minute = String(59 - (n % 60)).padStart(2, "0");
    const hour = String(20 - Math.floor(n / 60)).padStart(2, "0");
    return summary(`${prefix}${n}`, { lastMessageAt: `2026-11-10T${hour}:${minute}:00Z`, ...overrides });
  });
}
