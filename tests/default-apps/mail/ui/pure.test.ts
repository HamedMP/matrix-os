import { describe, expect, it } from "vitest";
import { createMailStore, threadKey } from "../../../../home/apps/mail/src/model";
import { attachmentSavePath, officeAppFor, safeFileName } from "../../../../home/apps/mail/src/ui/attachments";
import { decodeThreadDrag, dropActionFor, encodeThreadDrag } from "../../../../home/apps/mail/src/ui/drag";
import { formatBytes, formatListTime, senderLabel } from "../../../../home/apps/mail/src/ui/format";
import { clampLayout, DEFAULT_LAYOUT, parseLayout } from "../../../../home/apps/mail/src/ui/layout-prefs";
import { FILTER_CHIPS, isChipActive, queryTermChips, removeQueryTerm, toggleChip } from "../../../../home/apps/mail/src/ui/search-chips";
import { FakeProvider } from "../model/fake-provider";
import { GMAIL, GMAIL_FOLDERS, OUTLOOK, OUTLOOK_FOLDERS, summary } from "../model/fixtures";

describe("format", () => {
  const now = Date.parse("2026-11-23T15:00:00Z");
  it("shows the time today, the weekday this week, the date this year and the full date before", () => {
    expect(formatListTime("2026-11-23T09:05:00Z", now, "UTC")).toBe("09:05");
    expect(formatListTime("2026-11-20T09:05:00Z", now, "UTC")).toBe("Fri");
    expect(formatListTime("2026-03-02T09:05:00Z", now, "UTC")).toBe("Mar 2");
    expect(formatListTime("2025-03-02T09:05:00Z", now, "UTC")).toBe("2025-03-02");
  });

  it("returns an empty label for an unreadable instant", () => {
    expect(formatListTime("not a date", now, "UTC")).toBe("");
  });

  it("names senders, calling the owner me, without repeats", () => {
    const people = [
      { name: "Alice Smith", address: "alice@example.com" },
      { address: "ME@example.com" },
      { name: "Bob", address: "bob@example.com" },
    ];
    expect(senderLabel(people, ["me@example.com"])).toBe("Alice, me, Bob");
    expect(senderLabel([{ name: "Alice Smith", address: "a@x.io" }], [])).toBe("Alice Smith");
    expect(senderLabel([], [])).toBe("(no sender)");
  });

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("search chips", () => {
  it("toggles a filter term in the query text", () => {
    const unread = FILTER_CHIPS.find((chip) => chip.id === "unread")!;
    expect(isChipActive("from:alice", unread)).toBe(false);
    const on = toggleChip("from:alice", unread);
    expect(on).toBe("from:alice is:unread");
    expect(isChipActive(on, unread)).toBe(true);
    expect(toggleChip(on, unread)).toBe("from:alice");
  });

  it("lists the structured terms of a query as removable chips", () => {
    const chips = queryTermChips('from:alice subject:"q3 report" budget');
    expect(chips.map((chip) => chip.label)).toEqual(["From: alice", "Subject: q3 report"]);
    expect(removeQueryTerm('from:alice subject:"q3 report" budget', chips[1].token)).toBe("from:alice budget");
  });
});

describe("drag and drop", () => {
  it("round-trips thread keys and rejects anything else", () => {
    const keys = [threadKey(GMAIL.id, "t1"), threadKey(GMAIL.id, "t2")];
    expect(decodeThreadDrag(encodeThreadDrag(keys))).toEqual(keys);
    expect(decodeThreadDrag("not json")).toEqual([]);
    expect(decodeThreadDrag(JSON.stringify({ keys: [1, 2] }))).toEqual([]);
    expect(decodeThreadDrag(JSON.stringify({ keys: Array.from({ length: 600 }, (_, i) => `k${i}`) }))).toHaveLength(500);
  });

  it("maps a drop target to the triage the owner means", () => {
    const store = createMailStore({ accounts: [
      { account: GMAIL, provider: new FakeProvider(GMAIL_FOLDERS) },
      { account: OUTLOOK, provider: new FakeProvider(OUTLOOK_FOLDERS) },
    ] });
    const state = {
      ...store.getSnapshot(),
      folders: { [GMAIL.id]: GMAIL_FOLDERS, [OUTLOOK.id]: OUTLOOK_FOLDERS },
      threads: {
        [threadKey(GMAIL.id, "t1")]: summary("t1"),
        [threadKey(OUTLOOK.id, "o1")]: summary("o1", { accountId: OUTLOOK.id, folderIds: ["inbox-id"] }),
      },
    };
    const gmailKey = [threadKey(GMAIL.id, "t1")];
    const folder = (id: string) => GMAIL_FOLDERS.find((f) => f.id === id)!;
    expect(dropActionFor(state, GMAIL.id, folder("Label_1"), gmailKey)).toEqual({ kind: "move", folderId: "Label_1" });
    expect(dropActionFor(state, GMAIL.id, folder("ARCHIVE"), gmailKey)).toEqual({ kind: "archive" });
    expect(dropActionFor(state, GMAIL.id, folder("TRASH"), gmailKey)).toEqual({ kind: "trash" });
    expect(dropActionFor(state, GMAIL.id, folder("STARRED"), gmailKey)).toEqual({ kind: "flag" });
    expect(dropActionFor(state, GMAIL.id, folder("DRAFT"), gmailKey)).toEqual({ kind: "none" });
    expect(dropActionFor(state, GMAIL.id, folder("INBOX"), gmailKey)).toEqual({ kind: "none" });
    expect(dropActionFor(state, GMAIL.id, folder("Label_1"), [threadKey(OUTLOOK.id, "o1")])).toEqual({ kind: "none" });
    expect(dropActionFor(state, GMAIL.id, folder("Label_1"), [])).toEqual({ kind: "none" });
  });
});

describe("attachments", () => {
  it("routes documents and spreadsheets to their apps", () => {
    expect(officeAppFor("Contract v2.DOCX")).toBe("docs");
    expect(officeAppFor("budget.xlsx")).toBe("sheets");
    expect(officeAppFor("export.csv")).toBe("sheets");
    expect(officeAppFor("photo.png")).toBeNull();
    expect(officeAppFor(".docx")).toBeNull();
    expect(officeAppFor("~$lock.docx")).toBeNull();
  });

  it("makes a safe home path for a hostile file name", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("a\\b\u0000c.docx")).toBe("b_c.docx");
    expect(safeFileName("  ..  ")).toBe("attachment");
    expect(safeFileName("x".repeat(300) + ".docx").length).toBeLessThanOrEqual(120);
    expect(safeFileName("x".repeat(300) + ".docx").endsWith(".docx")).toBe(true);
    expect(attachmentSavePath("Report.docx", 0)).toBe("Documents/Mail attachments/Report.docx");
    expect(attachmentSavePath("Report.docx", 2)).toBe("Documents/Mail attachments/Report (2).docx");
  });
});

describe("layout preferences", () => {
  it("parses stored sizes and falls back for junk", () => {
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout({ rail: "x", list: 400 })).toEqual({ ...DEFAULT_LAYOUT, list: 400 });
    expect(parseLayout({ rail: 10_000, list: -5 })).toEqual(clampLayout({ rail: 10_000, list: -5 }));
    expect(clampLayout({ rail: 10_000, list: -5 }).rail).toBeLessThanOrEqual(480);
  });
});
