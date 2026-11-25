import { describe, expect, it } from "vitest";
import {
  applyChangeToSummary,
  belongsToView,
  inverseChange,
  triageChangeFor,
} from "../../../../home/apps/mail/src/model/thread-ops";
import { GMAIL_FOLDERS, OUTLOOK, OUTLOOK_FOLDERS, summary } from "./fixtures";

describe("applyChangeToSummary", () => {
  it("applies label changes on Gmail", () => {
    const next = applyChangeToSummary(summary("t1", { folderIds: ["INBOX", "Label_1"] }), { removeFolders: ["INBOX"], addFolders: ["Label_2"] }, "gmail");
    expect(next.folderIds).toEqual(["Label_1", "Label_2"]);
  });

  it("moves to exactly one folder on Outlook", () => {
    const next = applyChangeToSummary(summary("t1", { accountId: OUTLOOK.id, folderIds: ["inbox-id"] }), { removeFolders: ["inbox-id"], addFolders: ["archive-id"] }, "outlook");
    expect(next.folderIds).toEqual(["archive-id"]);
  });

  it("sets read and flagged without touching the input", () => {
    const before = summary("t1", { unread: true });
    const next = applyChangeToSummary(before, { read: true, flagged: true }, "gmail");
    expect(next).toMatchObject({ unread: false, flagged: true });
    expect(before.unread).toBe(true);
  });
});

describe("inverseChange", () => {
  it("restores exactly the labels a Gmail change touched", () => {
    const before = summary("t1", { folderIds: ["INBOX", "Label_1"], unread: true });
    const change = { removeFolders: ["INBOX", "SPAM"], addFolders: ["Label_1", "Label_2"], read: true };
    expect(inverseChange(before, change, "gmail")).toEqual({ addFolders: ["INBOX"], removeFolders: ["Label_2"], read: false });
  });

  it("moves an Outlook thread's messages back to their previous folders", () => {
    const before = summary("t1", { accountId: OUTLOOK.id, folderIds: ["proj-id"] });
    expect(inverseChange(before, { addFolders: ["trash-id"] }, "outlook")).toEqual({ addFolders: ["proj-id"], removeFolders: ["trash-id"], restore: true });
  });

  it("restores the flag state", () => {
    expect(inverseChange(summary("t1", { flagged: false }), { flagged: true }, "gmail")).toEqual({ flagged: false });
  });
});

describe("triageChangeFor", () => {
  const inbox = summary("t1", { folderIds: ["INBOX"] });

  it("archives through the shared helper", () => {
    expect(triageChangeFor("archive", inbox, { folders: GMAIL_FOLDERS, provider: "gmail" })).toEqual({ removeFolders: ["INBOX"] });
    const outlook = summary("t2", { accountId: OUTLOOK.id, folderIds: ["inbox-id"] });
    expect(triageChangeFor("archive", outlook, { folders: OUTLOOK_FOLDERS, provider: "outlook" })).toEqual({ removeFolders: ["inbox-id"], addFolders: ["archive-id"] });
  });

  it("trashes from the folder being viewed, or the inbox", () => {
    expect(triageChangeFor("trash", inbox, { folders: GMAIL_FOLDERS, provider: "gmail" })).toEqual({ addFolders: ["TRASH"], removeFolders: ["INBOX"] });
    const labelled = summary("t3", { folderIds: ["Label_1"] });
    expect(triageChangeFor("trash", labelled, { folders: GMAIL_FOLDERS, provider: "gmail", fromFolderId: "Label_1" })).toEqual({ addFolders: ["TRASH"], removeFolders: ["Label_1"] });
  });

  it("moves from the viewed folder and refuses virtual targets", () => {
    expect(triageChangeFor("move", inbox, { folders: GMAIL_FOLDERS, provider: "gmail", fromFolderId: "INBOX", toFolderId: "Label_1" }))
      .toEqual({ addFolders: ["Label_1"], removeFolders: ["INBOX"] });
    expect(() => triageChangeFor("move", inbox, { folders: GMAIL_FOLDERS, provider: "gmail", toFolderId: "STARRED" })).toThrow();
    expect(() => triageChangeFor("move", inbox, { folders: GMAIL_FOLDERS, provider: "gmail", toFolderId: "nope" })).toThrow();
  });

  it("moves a whole Outlook thread when no real folder is viewed, without guessing a source", () => {
    const outlook = summary("t2", { accountId: OUTLOOK.id, folderIds: ["proj-id"] });
    expect(triageChangeFor("move", outlook, { folders: OUTLOOK_FOLDERS, provider: "outlook", toFolderId: "inbox-id" }))
      .toEqual({ addFolders: ["inbox-id"] });
    expect(triageChangeFor("move", outlook, { folders: OUTLOOK_FOLDERS, provider: "outlook", fromFolderId: "proj-id", toFolderId: "inbox-id" }))
      .toEqual({ addFolders: ["inbox-id"], removeFolders: ["proj-id"] });
  });

  it("maps read and flag kinds", () => {
    const ctx = { folders: GMAIL_FOLDERS, provider: "gmail" as const };
    expect(triageChangeFor("markRead", inbox, ctx)).toEqual({ read: true });
    expect(triageChangeFor("markUnread", inbox, ctx)).toEqual({ read: false });
    expect(triageChangeFor("flag", inbox, ctx)).toEqual({ flagged: true });
    expect(triageChangeFor("unflag", inbox, ctx)).toEqual({ flagged: false });
  });
});

describe("belongsToView", () => {
  it("uses folder membership for real folders", () => {
    expect(belongsToView({ kind: "folder", accountId: "gmail:me@example.com", folderId: "INBOX" }, summary("t1"), GMAIL_FOLDERS)).toBe(true);
    expect(belongsToView({ kind: "folder", accountId: "gmail:me@example.com", folderId: "Label_1" }, summary("t1"), GMAIL_FOLDERS)).toBe(false);
  });

  it("computes virtual archive and starred views", () => {
    const archived = summary("t1", { folderIds: ["Label_1"] });
    const archiveView = { kind: "folder" as const, accountId: "gmail:me@example.com", folderId: "ARCHIVE" };
    expect(belongsToView(archiveView, archived, GMAIL_FOLDERS)).toBe(true);
    expect(belongsToView(archiveView, summary("t2"), GMAIL_FOLDERS)).toBe(false);
    expect(belongsToView(archiveView, summary("t3", { folderIds: ["TRASH"] }), GMAIL_FOLDERS)).toBe(false);
    const starred = { kind: "folder" as const, accountId: "gmail:me@example.com", folderId: "STARRED" };
    expect(belongsToView(starred, summary("t4", { flagged: true }), GMAIL_FOLDERS)).toBe(true);
  });

  it("matches unified views by role in the thread's account and keeps search results", () => {
    expect(belongsToView({ kind: "unified", role: "inbox" }, summary("t1"), GMAIL_FOLDERS)).toBe(true);
    expect(belongsToView({ kind: "unified", role: "inbox" }, summary("t1", { folderIds: [] }), GMAIL_FOLDERS)).toBe(false);
    expect(belongsToView({ kind: "unified", role: "inbox" }, summary("t1"), undefined)).toBe(false);
    expect(belongsToView({ kind: "search", query: "x" }, summary("t1", { folderIds: [] }), GMAIL_FOLDERS)).toBe(true);
  });

  it("never lists another account's thread in a folder view", () => {
    expect(belongsToView({ kind: "folder", accountId: OUTLOOK.id, folderId: "INBOX" }, summary("t1"), GMAIL_FOLDERS)).toBe(false);
  });
});
