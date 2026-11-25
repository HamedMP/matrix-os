import { describe, expect, it } from "vitest";
import {
  MAX_BUSY_INTERVALS,
  createCalendarProvider,
  descriptionToText,
  htmlToText,
  ianaZone,
  listCalendarAccounts,
  mergeBusyIntervals,
} from "../../../../home/apps/_shared/office-accounts/calendar/index";
import { calendarAccountId } from "../../../../home/apps/_shared/office-accounts/types/calendar";
import { FakeBridge, statusError } from "./fake-bridge";

const ms = (instant: string) => Date.parse(instant);

describe("free-busy merging", () => {
  it("clips to the range, joins touching blocks and lets the stronger status win where they overlap", () => {
    const blocks = mergeBusyIntervals("ana@example.com", [
      { startMs: ms("2026-11-23T06:00:00Z"), endMs: ms("2026-11-23T09:00:00Z"), status: "busy" },
      { startMs: ms("2026-11-23T09:00:00Z"), endMs: ms("2026-11-23T10:00:00Z"), status: "busy" },
      { startMs: ms("2026-11-23T09:30:00Z"), endMs: ms("2026-11-23T12:00:00Z"), status: "tentative" },
      { startMs: ms("2026-11-23T11:00:00Z"), endMs: ms("2026-11-23T11:30:00Z"), status: "outOfOffice" },
      { startMs: ms("2026-11-23T20:00:00Z"), endMs: ms("2026-11-23T19:00:00Z"), status: "busy" },
      { startMs: Number.NaN, endMs: ms("2026-11-23T19:00:00Z"), status: "busy" },
    ], ms("2026-11-23T08:00:00Z"), ms("2026-11-23T18:00:00Z"));

    expect(blocks).toEqual([
      { address: "ana@example.com", start: "2026-11-23T08:00:00Z", end: "2026-11-23T10:00:00Z", status: "busy" },
      { address: "ana@example.com", start: "2026-11-23T10:00:00Z", end: "2026-11-23T11:00:00Z", status: "tentative" },
      { address: "ana@example.com", start: "2026-11-23T11:00:00Z", end: "2026-11-23T11:30:00Z", status: "outOfOffice" },
      { address: "ana@example.com", start: "2026-11-23T11:30:00Z", end: "2026-11-23T12:00:00Z", status: "tentative" },
    ]);
  });

  it("marks the whole range unknown instead of cutting a reply with more intervals than it reads", () => {
    const start = ms("2026-11-23T00:00:00Z");
    const many = Array.from({ length: MAX_BUSY_INTERVALS + 1 }, (_, index) => ({
      startMs: start + index * 60_000, endMs: start + index * 60_000 + 30_000, status: "busy" as const,
    }));

    expect(mergeBusyIntervals("ana@example.com", many, start, ms("2026-11-25T00:00:00Z"))).toEqual([
      { address: "ana@example.com", start: "2026-11-23T00:00:00Z", end: "2026-11-25T00:00:00Z", status: "unknown" },
    ]);
    expect(mergeBusyIntervals("ana@example.com", many.slice(0, MAX_BUSY_INTERVALS), start, ms("2026-11-25T00:00:00Z")))
      .toHaveLength(MAX_BUSY_INTERVALS);
  });
});

describe("event descriptions", () => {
  it("turns HTML into text lines and drops scripts, styles and comments", () => {
    expect(htmlToText("<div>Hi&nbsp;there</div><!-- secret --><style>x{}</style><p>a &lt;b&gt; &#233; &#x1F600;</p><table><tr><td>1</td><td>2</td></tr></table>"))
      .toBe("Hi there\na <b> é 😀\n1 2");
    expect(htmlToText("<p>Keep</p><script>alert(1)")).toBe("Keep");
    expect(htmlToText("<p>line\nwrapped</p>")).toBe("line wrapped");
  });

  it("keeps plain text as written", () => {
    expect(descriptionToText("Call me\r\n\r\nat 5 < 6", "text")).toBe("Call me\n\nat 5 < 6");
    expect(descriptionToText("No markup here, 3 < 4")).toBe("No markup here, 3 < 4");
  });

  it("stays fast on hostile markup", () => {
    const hostile = "<script>".repeat(20_000) + "<".repeat(50_000);
    const started = performance.now();
    htmlToText(hostile);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("time zone names", () => {
  it("keeps IANA names and falls back to UTC", () => {
    expect(ianaZone("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(ianaZone("UTC")).toBe("UTC");
    expect(ianaZone("W. Europe Standard Time")).toBe("UTC");
    expect(ianaZone("Not/AZone")).toBe("UTC");
    expect(ianaZone(undefined)).toBe("UTC");
  });
});

class AccountsBridge extends FakeBridge {
  rows: unknown = [];
  async integrations() {
    if (this.rows instanceof Error) throw this.rows;
    return this.rows as never;
  }
}

describe("connected calendar accounts", () => {
  it("lists active Google calendar accounts and builds their adapter", async () => {
    const bridge = new AccountsBridge();
    bridge.rows = [
      { service: "gmail", account_label: "owner@example.com", account_email: "owner@example.com", status: "active" },
      { service: "google_calendar", account_label: "Work", account_email: "Owner@Example.com", status: "active" },
      { service: "google_calendar", account_label: "Work again", account_email: "owner@example.com", status: "active" },
      { service: "google_calendar", account_label: "old@example.com", status: "revoked" },
    ];

    const accounts = await listCalendarAccounts(bridge);

    expect(accounts).toEqual([
      { account: { id: calendarAccountId("google", "owner@example.com"), provider: "google", address: "owner@example.com", displayName: "Work" }, label: "Work" },
    ]);

    bridge.reply("google_calendar", "list_calendars", { items: [] });
    await createCalendarProvider(accounts[0], bridge).listCalendars();
    expect(bridge.calls[0]).toMatchObject({ service: "google_calendar", action: "list_calendars", label: "Work" });
  });

  it("ignores a connected calendar service that has no adapter, so the owner is asked to connect one", async () => {
    const bridge = new AccountsBridge();
    bridge.rows = [
      { service: "microsoft_outlook_calendar", account_label: "me@contoso.com", account_email: null, status: "active" },
    ];
    expect(await listCalendarAccounts(bridge)).toEqual([]);
  });

  it("reads the owner's address from the primary calendar when the host lists only a label, never using the label", async () => {
    const bridge = new AccountsBridge();
    bridge.rows = [
      { service: "google_calendar", account_label: "Work", status: "active" },
      { service: "google_calendar", account_label: "Side", account_email: null, status: "active" },
    ];
    bridge.reply("google_calendar", "list_calendars",
      { items: [{ id: "team@group.calendar.google.com" }], nextPageToken: "next" },
      { items: [{ id: "Owner@Example.com", primary: true }] },
      { items: [{ id: "shared@group.calendar.google.com", primary: false }] });

    const accounts = await listCalendarAccounts(bridge);

    expect(bridge.calls.map(({ action, params, label }) => ({ action, params, label }))).toEqual([
      { action: "list_calendars", params: { maxResults: 250 }, label: "Work" },
      { action: "list_calendars", params: { maxResults: 250, pageToken: "next" }, label: "Work" },
      { action: "list_calendars", params: { maxResults: 250 }, label: "Side" },
    ]);
    expect(accounts).toEqual([
      { account: { id: calendarAccountId("google", "owner@example.com"), provider: "google", address: "owner@example.com", displayName: "Work" }, label: "Work" },
      { account: { id: calendarAccountId("google", "label:side"), provider: "google", address: "", displayName: "Side" }, label: "Side" },
    ]);
  });

  it("keeps an account whose address cannot be read, and stops reading once the host is rate limited", async () => {
    const bridge = new AccountsBridge();
    bridge.rows = [
      { service: "google_calendar", account_label: "Work", status: "active" },
      { service: "google_calendar", account_label: "Side", status: "active" },
    ];
    bridge.fail("google_calendar", "list_calendars", statusError(429));

    const accounts = await listCalendarAccounts(bridge);

    expect(bridge.calls).toHaveLength(1);
    expect(accounts.map(({ account }) => account.address)).toEqual(["", ""]);
    expect(accounts.map(({ label }) => label)).toEqual(["Work", "Side"]);
  });

  it("maps a failed account listing to a provider error", async () => {
    const bridge = new AccountsBridge();
    bridge.rows = statusError(429);
    await expect(listCalendarAccounts(bridge)).rejects.toMatchObject({ code: "rate_limited" });
  });
});
