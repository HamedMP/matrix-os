import { describe, expect, it } from "vitest";
import {
  MAX_DRAFT_ATTACHMENTS,
  MAX_DRAFT_REQUEST_BYTES,
  MAIL_SERVICE_IDS,
  ProviderError,
  archiveChange,
  base64DecodedBytes,
  clampPageLimit,
  draftIssues,
  emptyDraft,
  findFolder,
  formatMailAddress,
  isEmptyThreadChange,
  isValidMailAddress,
  mailAccountId,
  moveChange,
  replyHeaders,
  sameMailAddress,
  trashChange,
  untrustedHtml,
  type Draft,
  type MailFolder,
  type MailMessage,
  type MailProvider,
  type Page,
  type ThreadSummary,
} from "../../home/apps/_shared/office-accounts/types/mail";
import {
  CALENDAR_SERVICE_IDS,
  allDayDate,
  allDayInstant,
  composeEventId,
  describeRecurrence,
  eventDraftIssues,
  instantsOverlap,
  recurrenceToRRule,
  splitEventId,
  type CalendarProvider,
  type EventDraft,
} from "../../home/apps/_shared/office-accounts/types/calendar";
import {
  compareInstants,
  instantFromMs,
  instantFromWallTime,
  instantInZone,
  instantToMs,
  isIsoInstant,
  localDateOf,
  offsetMinutesOf,
  toUtcInstant,
  wallTimeOf,
  zoneOffsetMinutes,
} from "../../home/apps/_shared/office-accounts/types/time";
import {
  PROVIDER_ERROR_CODES,
  isProviderError,
  isRetryableProviderError,
  providerErrorCodeForStatus,
  toProviderError,
} from "../../home/apps/_shared/office-accounts/types/errors";
import * as barrel from "../../home/apps/_shared/office-accounts/types/index";

const folders: MailFolder[] = [
  { id: "INBOX", name: "Inbox", role: "inbox", unreadCount: 3 },
  { id: "archive", name: "Archive", role: "archive", virtual: true },
  { id: "TRASH", name: "Trash", role: "trash" },
  { id: "Label_7", name: "Clients", role: "custom" },
];

describe("instants: ISO strings that always carry an offset", () => {
  it("accepts an explicit offset or Z and rejects anything a provider could misread", () => {
    expect(isIsoInstant("2026-11-23T09:00:00+01:00")).toBe(true);
    expect(isIsoInstant("2026-11-23T08:00:00Z")).toBe(true);
    expect(isIsoInstant("2026-11-23T08:00:00.250-05:30")).toBe(true);
    for (const bad of [
      "2026-11-23T09:00:00", // no offset: ambiguous
      "2026-11-23", // date only
      "2026-11-23T09:00+01:00", // no seconds
      "2026-02-30T09:00:00Z", // not a real day
      "2026-13-01T09:00:00Z",
      "2026-11-23T24:00:00Z",
      "2026-11-23T09:00:00+15:00",
      "2026-11-23 09:00:00Z",
      "",
      20261123,
      null,
    ]) expect(isIsoInstant(bad), String(bad)).toBe(false);
  });

  it("converts between an instant, epoch milliseconds and UTC without losing the moment", () => {
    const ms = Date.UTC(2026, 10, 23, 8, 0, 0);
    expect(instantToMs("2026-11-23T09:00:00+01:00")).toBe(ms);
    expect(toUtcInstant("2026-11-23T09:00:00+01:00")).toBe("2026-11-23T08:00:00Z");
    expect(instantFromMs(ms)).toBe("2026-11-23T08:00:00Z");
    expect(instantFromMs(ms, 60)).toBe("2026-11-23T09:00:00+01:00");
    expect(instantFromMs(ms, -330)).toBe("2026-11-23T02:30:00-05:30");
    expect(instantFromMs(ms + 250)).toBe("2026-11-23T08:00:00.250Z");
    expect(offsetMinutesOf("2026-11-23T02:30:00-05:30")).toBe(-330);
    expect(offsetMinutesOf("2026-11-23T08:00:00Z")).toBe(0);
    expect(() => instantToMs("2026-11-23T09:00:00")).toThrow(RangeError);
    expect(() => instantFromMs(Number.NaN)).toThrow(RangeError);
  });

  it("orders instants by the moment, not by their text", () => {
    const sorted = ["2026-11-23T10:00:00+01:00", "2026-11-23T08:30:00Z", "2026-11-23T03:00:00-05:00"]
      .sort(compareInstants);
    expect(sorted).toEqual(["2026-11-23T03:00:00-05:00", "2026-11-23T08:30:00Z", "2026-11-23T10:00:00+01:00"]);
  });

  it("reads wall-clock time and local date straight from the text", () => {
    expect(wallTimeOf("2026-11-23T09:00:00.500+01:00")).toBe("2026-11-23T09:00:00");
    expect(localDateOf("2026-11-23T00:30:00+01:00")).toBe("2026-11-23");
    expect(() => wallTimeOf("yesterday")).toThrow(RangeError);
  });

  it("expresses a moment in a named time zone, across a daylight-saving change", () => {
    const winter = Date.UTC(2026, 10, 23, 8, 0, 0);
    const summer = Date.UTC(2026, 6, 1, 8, 0, 0);
    expect(zoneOffsetMinutes(winter, "Europe/Berlin")).toBe(60);
    expect(zoneOffsetMinutes(summer, "Europe/Berlin")).toBe(120);
    expect(instantInZone(winter, "Europe/Berlin")).toBe("2026-11-23T09:00:00+01:00");
    expect(instantInZone(summer, "America/New_York")).toBe("2026-07-01T04:00:00-04:00");
    expect(instantInZone(winter, "UTC")).toBe("2026-11-23T08:00:00Z");
    // A zone name the runtime does not know falls back to UTC instead of throwing.
    expect(instantInZone(winter, "Pacific Standard Time")).toBe("2026-11-23T08:00:00Z");
  });

  it("turns the wall-clock time an owner picked into the right instant", () => {
    expect(instantFromWallTime("2026-11-23T09:00:00", "Europe/Berlin")).toBe("2026-11-23T09:00:00+01:00");
    expect(instantFromWallTime("2026-07-01T09:00:00", "Europe/Berlin")).toBe("2026-07-01T09:00:00+02:00");
    expect(instantFromWallTime("2026-03-08T12:00:00", "America/Los_Angeles")).toBe("2026-03-08T12:00:00-07:00");
    expect(() => instantFromWallTime("2026-11-23T09:00:00Z", "UTC")).toThrow(RangeError);
  });
});

describe("provider errors: one typed failure for every adapter", () => {
  it("carries a code and a safe message, and survives a structured clone", () => {
    const error = new ProviderError("rate_limited");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("rate_limited");
    expect(error.message.length).toBeGreaterThan(0);
    expect(isProviderError(error)).toBe(true);
    expect(isProviderError(JSON.parse(JSON.stringify({ code: error.code, message: error.message })))).toBe(true);
    expect(isProviderError({ code: "exploded", message: "x" })).toBe(false);
    expect(isProviderError(new Error("boom"))).toBe(false);
    expect([...PROVIDER_ERROR_CODES].sort()).toEqual(["failed", "multiple_accounts", "not_connected", "not_supported", "rate_limited"]);
  });

  it("never copies an unknown error's text into what the owner sees", () => {
    const leaked = toProviderError(new Error("ECONNRESET 10.0.0.4 /home/matrix/secret token=abc"));
    expect(leaked.code).toBe("failed");
    expect(leaked.message).not.toMatch(/ECONNRESET|10\.0\.0\.4|secret|token/);
    const kept = new ProviderError("not_supported");
    expect(toProviderError(kept)).toBe(kept);
    expect(toProviderError({ code: "multiple_accounts", message: "raw upstream text" }).code).toBe("multiple_accounts");
    expect(toProviderError({ code: "multiple_accounts", message: "raw upstream text" }).message).not.toContain("raw upstream");
  });

  it("caps and flattens a custom message", () => {
    const error = new ProviderError("failed", `line one\nline two ${"x".repeat(500)}`);
    expect(error.message).not.toContain("\n");
    expect(error.message.length).toBeLessThanOrEqual(160);
  });

  it("maps the app bridge statuses to codes and knows which are worth a retry", () => {
    expect(providerErrorCodeForStatus(404)).toBe("not_connected");
    expect(providerErrorCodeForStatus(409)).toBe("multiple_accounts");
    expect(providerErrorCodeForStatus(429)).toBe("rate_limited");
    expect(providerErrorCodeForStatus(503)).toBe("failed");
    expect(providerErrorCodeForStatus(400)).toBe("failed");
    expect(isRetryableProviderError(new ProviderError("rate_limited"))).toBe(true);
    expect(isRetryableProviderError(new ProviderError("failed"))).toBe(true);
    expect(isRetryableProviderError(new ProviderError("not_connected"))).toBe(false);
    expect(isRetryableProviderError(new ProviderError("not_supported"))).toBe(false);
    expect(isRetryableProviderError(new Error("x"))).toBe(false);
  });
});

describe("mail contract helpers", () => {
  it("names the integration service behind each provider", () => {
    expect(MAIL_SERVICE_IDS).toEqual({ gmail: "gmail", outlook: "microsoft_outlook" });
    expect(CALENDAR_SERVICE_IDS).toEqual({ google: "google_calendar", outlook: "microsoft_outlook_calendar" });
  });

  it("builds stable account ids and compares addresses without case", () => {
    expect(mailAccountId("gmail", " Ada@Example.COM ")).toBe("gmail:ada@example.com");
    expect(sameMailAddress("Ada@Example.com", "ada@example.COM ")).toBe(true);
    expect(sameMailAddress("ada@example.com", "ada@example.org")).toBe(false);
    expect(isValidMailAddress("ada@example.com")).toBe(true);
    for (const bad of ["ada", "ada@", "ada@host", "a b@example.com", "ada@example.com\nBcc: x@y.z", `${"a".repeat(250)}@example.com`]) {
      expect(isValidMailAddress(bad), bad).toBe(false);
    }
  });

  it("formats an address for display and quotes names that need it", () => {
    expect(formatMailAddress({ address: "ada@example.com" })).toBe("ada@example.com");
    expect(formatMailAddress({ name: "Ada Lovelace", address: "ada@example.com" })).toBe("Ada Lovelace <ada@example.com>");
    expect(formatMailAddress({ name: 'Lovelace, "Ada"', address: "ada@example.com" })).toBe('"Lovelace, \\"Ada\\"" <ada@example.com>');
    expect(formatMailAddress({ name: "Ada\r\nBcc: evil@example.com", address: "ada@example.com" })).not.toMatch(/[\r\n]/);
  });

  it("marks provider HTML as untrusted without changing it", () => {
    const html = untrustedHtml("<img src=x onerror=alert(1)>");
    expect(html).toBe("<img src=x onerror=alert(1)>");
    // @ts-expect-error a plain string is not accepted where untrusted HTML is required
    const message: Pick<MailMessage, "bodyHtml"> = { bodyHtml: "<p>plain</p>" };
    expect(message.bodyHtml).toBe("<p>plain</p>");
  });

  it("expresses archive, trash and move as one uniform thread change", () => {
    expect(findFolder(folders, "inbox")?.id).toBe("INBOX");
    expect(findFolder(folders, "sent")).toBeUndefined();
    // A virtual archive (a view, not a container) is reached by leaving the inbox.
    expect(archiveChange(folders)).toEqual({ removeFolders: ["INBOX"] });
    const real = folders.map((folder) => folder.role === "archive" ? { ...folder, id: "arch-1", virtual: false } : folder);
    expect(archiveChange(real)).toEqual({ removeFolders: ["INBOX"], addFolders: ["arch-1"] });
    expect(trashChange(folders, "INBOX")).toEqual({ addFolders: ["TRASH"], removeFolders: ["INBOX"] });
    expect(trashChange(folders)).toEqual({ addFolders: ["TRASH"] });
    expect(moveChange("INBOX", "Label_7")).toEqual({ addFolders: ["Label_7"], removeFolders: ["INBOX"] });
    expect(() => archiveChange([{ id: "x", name: "X", role: "custom" }])).toThrow(ProviderError);
    expect(() => trashChange([{ id: "x", name: "X", role: "custom" }])).toThrow(ProviderError);
    expect(() => moveChange("INBOX", "INBOX")).toThrow(RangeError);
  });

  it("recognises a change that would do nothing", () => {
    expect(isEmptyThreadChange({})).toBe(true);
    expect(isEmptyThreadChange({ addFolders: [], removeFolders: [] })).toBe(true);
    expect(isEmptyThreadChange({ read: false })).toBe(false);
    expect(isEmptyThreadChange({ flagged: true })).toBe(false);
    expect(isEmptyThreadChange({ addFolders: ["TRASH"] })).toBe(false);
  });

  it("derives reply headers from the message being answered", () => {
    const message = { messageIdHeader: "<c@mail.example>", references: ["<a@mail.example>", "<b@mail.example>"] };
    expect(replyHeaders(message)).toEqual({ inReplyTo: "<c@mail.example>", references: ["<a@mail.example>", "<b@mail.example>", "<c@mail.example>"] });
    expect(replyHeaders({ messageIdHeader: "<b@mail.example>", references: ["<a@mail.example>", "<b@mail.example>"] }).references)
      .toEqual(["<a@mail.example>", "<b@mail.example>"]);
    expect(replyHeaders({ messageIdHeader: null, references: [] })).toEqual({ inReplyTo: null, references: [] });
    const long = { messageIdHeader: "<z@mail.example>", references: Array.from({ length: 60 }, (_, i) => `<${i}@mail.example>`) };
    const capped = replyHeaders(long).references;
    expect(capped).toHaveLength(20);
    expect(capped[0]).toBe("<0@mail.example>"); // the thread root is kept
    expect(capped.at(-1)).toBe("<z@mail.example>");
  });

  it("bounds page sizes", () => {
    expect(clampPageLimit(undefined)).toBe(25);
    expect(clampPageLimit(0)).toBe(1);
    expect(clampPageLimit(500)).toBe(50);
    expect(clampPageLimit(12.9)).toBe(12);
    expect(clampPageLimit(Number.NaN)).toBe(25);
  });

  it("measures attachment size from base64 without decoding it", () => {
    expect(base64DecodedBytes("")).toBe(0);
    expect(base64DecodedBytes(btoa("a"))).toBe(1);
    expect(base64DecodedBytes(btoa("ab"))).toBe(2);
    expect(base64DecodedBytes(btoa("abc"))).toBe(3);
    expect(base64DecodedBytes(btoa("x".repeat(1000)))).toBe(1000);
  });

  it("reports why a draft cannot be saved or sent before any provider call", () => {
    const draft: Draft = { ...emptyDraft(), to: [{ address: "ada@example.com" }], subject: "Hello", bodyText: "Hi", bodyHtml: "<p>Hi</p>" };
    expect(emptyDraft()).toEqual({ to: [], cc: [], bcc: [], subject: "", bodyHtml: "", bodyText: "", attachments: [] });
    expect(draftIssues(draft, { forSend: true })).toEqual([]);
    expect(draftIssues(emptyDraft())).toEqual([]); // an empty draft can be saved
    expect(draftIssues(emptyDraft(), { forSend: true })).toEqual(["no_recipients"]);
    expect(draftIssues({ ...draft, cc: [{ address: "not-an-address" }] })).toEqual(["invalid_address"]);
    expect(draftIssues({ ...draft, bcc: Array.from({ length: 101 }, (_, i) => ({ address: `p${i}@example.com` })) }))
      .toContain("too_many_recipients");
    expect(draftIssues({ ...draft, subject: "s".repeat(256) })).toEqual(["subject_too_long"]);
    const attachment = { name: "a.txt", mimeType: "text/plain", size: 3, contentBase64: btoa("abc") };
    expect(draftIssues({ ...draft, attachments: [attachment] })).toEqual([]);
    expect(draftIssues({ ...draft, attachments: Array.from({ length: MAX_DRAFT_ATTACHMENTS + 1 }, () => attachment) }))
      .toContain("too_many_attachments");
    expect(draftIssues({ ...draft, bodyHtml: "x".repeat(MAX_DRAFT_REQUEST_BYTES) })).toEqual(["too_large"]);
    expect(draftIssues({ ...draft, attachments: [{ ...attachment, contentBase64: "A".repeat(MAX_DRAFT_REQUEST_BYTES) }] }))
      .toEqual(["too_large"]);
    // Multi-byte text counts in bytes, the unit the gateway limits.
    expect(draftIssues({ ...draft, bodyText: "é".repeat(MAX_DRAFT_REQUEST_BYTES / 2) })).toEqual(["too_large"]);
  });

  it("lets an adapter satisfy the provider interface with the documented shapes", async () => {
    const summary: ThreadSummary = {
      id: "t1", accountId: "gmail:ada@example.com", subject: "Hello", snippet: "Hi", participants: [{ address: "ada@example.com" }],
      lastMessageAt: "2026-11-23T08:00:00Z", unread: true, flagged: false, hasAttachments: false, folderIds: ["INBOX"], messageCount: 1,
    };
    const page: Page<ThreadSummary> = { items: [summary], nextCursor: null };
    const provider: MailProvider = {
      listFolders: async () => folders,
      listThreads: async () => page,
      getThread: async (id) => ({ id, accountId: summary.accountId, subject: summary.subject, folderIds: summary.folderIds, messages: [] }),
      search: async () => page,
      modifyThreads: async () => undefined,
      saveDraft: async (draft) => ({ ...draft, id: "d1" }),
      sendDraft: async () => undefined,
      getAttachment: async () => ({ name: "a.txt", mimeType: "text/plain", size: 3, contentBase64: btoa("abc") }),
      listSentTo: async () => [],
    };
    expect(provider.deleteDraft).toBeUndefined(); // optional by contract
    expect((await provider.listThreads({ folderId: "INBOX", limit: 25 })).items[0].id).toBe("t1");
    expect((await provider.saveDraft(emptyDraft())).id).toBe("d1");
  });
});

describe("calendar contract helpers", () => {
  const draft: EventDraft = {
    calendarId: "primary", title: "Review", start: "2026-11-23T09:00:00+01:00", end: "2026-11-23T10:00:00+01:00",
    allDay: false, timeZone: "Europe/Berlin", location: "", descriptionText: "", attendees: [], addOnlineMeeting: false,
  };

  it("keeps an all-day event on its calendar date in every time zone", () => {
    expect(allDayInstant("2026-11-23")).toBe("2026-11-23T00:00:00Z");
    expect(allDayDate("2026-11-23T00:00:00Z")).toBe("2026-11-23");
    expect(() => allDayInstant("2026-02-30")).toThrow(RangeError);
    expect(() => allDayInstant("23/11/2026")).toThrow(RangeError);
  });

  it("packs a calendar id and a provider event id into one opaque event id", () => {
    const id = composeEventId("team@group.calendar.example.com", "abc_123-xyz");
    expect(splitEventId(id)).toEqual({ calendarId: "team@group.calendar.example.com", providerEventId: "abc_123-xyz" });
    expect(splitEventId(composeEventId("AAMk=", "AQMk-_="))).toEqual({ calendarId: "AAMk=", providerEventId: "AQMk-_=" });
    expect(() => composeEventId("a/b", "c")).toThrow(RangeError);
    expect(() => composeEventId("", "c")).toThrow(RangeError);
    expect(() => splitEventId("no-separator")).toThrow(RangeError);
  });

  it("detects overlap with exclusive ends, which is what a free-busy overlay needs", () => {
    expect(instantsOverlap("2026-11-23T09:00:00+01:00", "2026-11-23T10:00:00+01:00", "2026-11-23T08:30:00Z", "2026-11-23T09:30:00Z")).toBe(true);
    // Back-to-back meetings do not overlap.
    expect(instantsOverlap("2026-11-23T09:00:00+01:00", "2026-11-23T10:00:00+01:00", "2026-11-23T09:00:00Z", "2026-11-23T10:00:00Z")).toBe(false);
  });

  it("writes a recurrence as an RFC 5545 rule", () => {
    expect(recurrenceToRRule({ freq: "daily", interval: 1 })).toBe("RRULE:FREQ=DAILY");
    expect(recurrenceToRRule({ freq: "weekly", interval: 2, byDay: ["MO", "WE"], count: 10 }))
      .toBe("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10");
    expect(recurrenceToRRule({ freq: "monthly", interval: 1, until: "2026-12-31T23:59:59+01:00" }))
      .toBe("RRULE:FREQ=MONTHLY;UNTIL=20261231T225959Z");
    expect(() => recurrenceToRRule({ freq: "weekly", interval: 0 })).toThrow(RangeError);
    expect(() => recurrenceToRRule({ freq: "weekly", interval: 1, count: 0 })).toThrow(RangeError);
  });

  it("describes a recurrence in words", () => {
    expect(describeRecurrence({ freq: "daily", interval: 1 })).toBe("Every day");
    expect(describeRecurrence({ freq: "weekly", interval: 2, byDay: ["MO", "WE"] })).toBe("Every 2 weeks on Monday, Wednesday");
    expect(describeRecurrence({ freq: "monthly", interval: 1, count: 6 })).toBe("Every month, 6 times");
    expect(describeRecurrence({ freq: "yearly", interval: 1, until: "2030-01-01T00:00:00Z" })).toBe("Every year until 2030-01-01");
  });

  it("reports why an event draft cannot be created before any provider call", () => {
    expect(eventDraftIssues(draft)).toEqual([]);
    expect(eventDraftIssues({ ...draft, start: "2026-11-23T09:00:00" })).toEqual(["invalid_time"]);
    expect(eventDraftIssues({ ...draft, end: draft.start })).toEqual(["end_not_after_start"]);
    expect(eventDraftIssues({ ...draft, allDay: true })).toEqual(["all_day_not_midnight_utc"]);
    expect(eventDraftIssues({ ...draft, allDay: true, start: "2026-11-23T00:00:00Z", end: "2026-11-24T00:00:00Z" })).toEqual([]);
    expect(eventDraftIssues({ ...draft, attendees: [{ address: "nobody" }] })).toEqual(["invalid_attendee"]);
    expect(eventDraftIssues({ ...draft, attendees: Array.from({ length: 101 }, (_, i) => ({ address: `p${i}@example.com` })) }))
      .toEqual(["too_many_attendees"]);
    expect(eventDraftIssues({ ...draft, recurrence: { freq: "weekly", interval: 0 } })).toEqual(["invalid_recurrence"]);
    expect(eventDraftIssues({ ...draft, reminders: [{ minutesBefore: -5, method: "popup" }] })).toEqual(["invalid_reminder"]);
  });

  it("lets an adapter satisfy the provider interface with the documented shapes", async () => {
    const provider: CalendarProvider = {
      listCalendars: async () => [{ id: "primary", accountId: "google:ada@example.com", name: "Ada", color: "#3366cc", primary: true, writable: true, visible: true }],
      listEvents: async () => [],
      createEvent: async (input) => ({
        id: composeEventId(input.calendarId, "e1"), calendarId: input.calendarId, title: input.title, start: input.start, end: input.end,
        allDay: input.allDay, timeZone: input.timeZone, location: input.location, descriptionText: input.descriptionText,
        attendees: [], myResponse: null,
      }),
      updateEvent: async () => { throw new ProviderError("not_supported"); },
      deleteEvent: async () => undefined,
      respond: async () => undefined,
      getFreeBusy: async (addresses, start, end) => addresses.map((address) => ({ address, start, end, status: "unknown" as const })),
    };
    const created = await provider.createEvent(draft, { sendInvites: false });
    expect(splitEventId(created.id).providerEventId).toBe("e1");
    await expect(provider.updateEvent(created.id, { title: "x" }, { sendInvites: false })).rejects.toMatchObject({ code: "not_supported" });
    expect(await provider.getFreeBusy(["ada@example.com"], draft.start, draft.end)).toHaveLength(1);
  });
});

describe("barrel", () => {
  it("re-exports the mail, calendar, time and error contracts from one place", () => {
    expect(barrel.ProviderError).toBe(ProviderError);
    expect(barrel.isIsoInstant).toBe(isIsoInstant);
    expect(barrel.recurrenceToRRule).toBe(recurrenceToRRule);
    expect(barrel.draftIssues).toBe(draftIssues);
  });
});
