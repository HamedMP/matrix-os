// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ExistingWorkflows from "../../home/app-templates/connected-starter/src/ExistingWorkflows";
import { invoiceQueue, renewalQueue, receiptReview, contactReview, meetingActions, projectRisks, dailyEvents, tripChecks } from "../../home/app-templates/connected-starter/src/existing-workflow-model";
import type { Definition, OwnerRecord } from "../../home/app-templates/connected-starter/src/types";
import catalog from "../../home/system/app-gallery.json";
beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => { }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const day = "2026-10-07";
function record(id: string, fields: OwnerRecord["fields"]): OwnerRecord { return { id, rowId: id, basePayload: { revision: 2 }, fields, accounts: [], sources: [], manualFields: ["title"], scope: "personal", updatedAt: "2026-10-06" }; }
function props(id: string, records: OwnerRecord[]) { return { app: catalog.apps.find(app => app.id === id) as Definition, records, onEdit: vi.fn(), onEvidence: vi.fn(), onAdd: vi.fn(), onSave: vi.fn(async () => { }) }; }
describe("grounded existing workflows", () => {
    it("calculates outstanding invoices without chasing disputed, settled or unknown due dates", () => {
        const rows = invoiceQueue([record("partial", { amount: 100, "paid-amount": 40, currency: "EUR", status: "Partial", "due-date": "2026-10-01" }), record("dispute", { amount: 200, currency: "USD", status: "Disputed", "due-date": "2026-09-01" }), record("external", { amount: 100, status: "Externally paid" }), record("unknown", { amount: 40, currency: "EUR", status: "Sent", date: "2026-09-01" })], day);
        expect(rows.find(r => r.record.id === "partial")).toMatchObject({ outstanding: 60, daysLate: 6, lane: "Overdue" });
        expect(rows.find(r => r.record.id === "dispute")?.lane).toBe("On hold");
        expect(rows.find(r => r.record.id === "external")?.lane).toBe("Settled");
        expect(rows.find(r => r.record.id === "unknown")?.lane).toBe("Review dates");
    });
    it("requires confirmed payment facts and separates upcoming invoices", () => {
        expect(invoiceQueue([record("bad", { status: "Partial", amount: 100, "paid-amount": 200, currency: "EUR", "due-date": "2026-09-01" }), record("soon", { status: "Sent", amount: 20, currency: "USD", "due-date": "2026-10-09" })], day).map(r => r.lane)).toEqual(["Review amount", "Upcoming"]);
    });
    it("keeps malformed amount strings and contradictory trip dates in review", () => {
        expect(invoiceQueue([record("bad", { status: "Sent", amount: "  ", currency: "EUR", "due-date": "2026-01-01" })], day)[0].lane).toBe("Review amount");
        expect(tripChecks(record("bad-trip", { date: "2026-10-09", "end-date": "2026-10-08" })).find(c => c.label === "Return date")?.ready).toBe(false);
    });
    it("never invents a renewal from a receipt date or estimated cycle", () => {
        const rows = renewalQueue([record("legacy", { status: "Active", date: "2026-10-01" }), record("estimated", { status: "Active", "renewal-date": "2026-10-10", "renewal-certainty": "Estimated" }), record("known", { status: "Active", "renewal-date": "2026-10-10", "renewal-certainty": "Confirmed", "cancel-by": "2026-10-08" }), record("cancelled", { status: "Cancelled" })], day);
        expect(rows.map(r => r.record.id)).toEqual(["known", "legacy", "estimated"]);
        expect(rows[0]).toMatchObject({ daysUntil: 3, cancelBy: "2026-10-08" });
        expect(rows[1].daysUntil).toBeNull();
        expect(rows[2].daysUntil).toBeNull();
    });
    it("flags incomplete receipts and possible shared-source duplicates without hiding records", () => {
        const a = record("a", { provider: "Cafe", amount: 10, currency: "EUR", date: day, status: "Paid" });
        a.sources = [{ id: "mail1", service: "gmail", label: "personal", title: "Receipt" }];
        const b = { ...a, id: "b" };
        const c = record("c", { status: "Needs review", amount: -1, currency: "UNKNOWN", date: "2026-02-30" });
        const rows = receiptReview([a, b, c]);
        expect(rows[0].reasons).toContain("Possible duplicate source");
        expect(rows[2].reasons).toEqual(expect.arrayContaining(["Review requested", "Amount missing or invalid", "Currency missing or invalid", "Receipt date missing or invalid", "Provider missing"]));
    });
    it("keeps personal/work identities separate and never merges same-name contacts", () => {
        const a = record("a", { title: "Alex", email: "alex@one.test" });
        const b = record("b", { title: "Alex", email: "alex@two.test", "last-contact": "2026-09-01" });
        const c = { ...a, id: "c", scope: "work" as const };
        const rows = contactReview([a, b, c], day);
        expect(rows).toHaveLength(3);
        expect(rows[0].identityReview).toBe(true);
        expect(rows[0].daysSince).toBeNull();
        expect(rows[1].daysSince).toBe(36);
    });
    it("reads explicit action ownership and dates while preserving unstructured uncertainty", () => {
        expect(meetingActions("Send draft | Mira | 2026-10-08 | Open\nTalk to customer\nReview | Jo | 2026-02-30 | Done")).toEqual([{ task: "Send draft", owner: "Mira", due: "2026-10-08", status: "Open" }, { task: "Talk to customer", owner: null, due: null, status: "Unknown" }, { task: "Review", owner: "Jo", due: null, status: "Done" }]);
    });
    it("flags explicit blockers, overdue work and stale evidence without claiming CI state", () => {
        expect(projectRisks(record("p", { status: "Blocked", "due-date": "2026-10-01", "source-updated": "2026-09-01" }), day)).toEqual(["Blocked", "Past recorded due date", "Owner not recorded", "Source older than 14 days"]);
        expect(projectRisks(record("done", { status: "Done" }), day)).toEqual([]);
    });
    it("selects a bounded daily agenda and keeps undated events out of confirmed plans", () => {
        const rows = [record("unknown", { title: "Unknown", status: "Scheduled" }), record("late", { status: "Scheduled", date: day, time: "14:00" }), record("early", { status: "Scheduled", date: day, time: "09:00" }), record("cancelled", { status: "Cancelled", date: day })];
        expect(dailyEvents(rows, day).map(r => r.id)).toEqual(["early", "late"]);
    });
    it("requires flight numbers only for explicitly recorded air travel", () => {
        expect(tripChecks(record("train", { destination: "Paris", date: day, "end-date": "2026-10-08", booking: "ABC", "travel-mode": "Train" })).every(c => c.ready)).toBe(true);
        expect(tripChecks(record("air", { "travel-mode": "Flight" })).find(c => c.label === "Flight number")?.ready).toBe(false);
    });
    it("renders an actionable receipt review beside the currency-safe spending desk", () => {
        const p = props("folio", [record("r", { title: "Lunch", status: "Needs review" })]);
        render(createElement(ExistingWorkflows, p));
        const review = screen.getByRole("region", { name: "Receipt review" });
        fireEvent.click(within(review).getByRole("button", { name: "Edit" }));
        expect(p.onEdit).toHaveBeenCalledWith(p.records[0]);
    });
    it("preserves CAS, scope, evidence and corrections when saving a contact draft", async () => {
        const r = record("p", { title: "Mira", email: "mira@example.test" });
        r.scope = "work";
        r.sources = [{ id: "m", service: "gmail", label: "work", title: "Meeting" }];
        const p = props("people", [r]);
        render(createElement(ExistingWorkflows, p));
        fireEvent.change(screen.getByLabelText("Follow-up draft for Mira"), { target: { value: "Hope the launch went well." } });
        fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
        await waitFor(() => expect(p.onSave).toHaveBeenCalledOnce());
        const saved = p.onSave.mock.calls[0][0];
        expect(saved).toMatchObject({ rowId: "p", basePayload: r.basePayload, scope: "work", sources: r.sources, fields: { "follow-up": "Hope the launch went well." }, manualFields: ["title", "follow-up"] });
        expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
    });
    it("keeps the original revision when another update arrives during a local draft", async () => {
        const r = record("p", { title: "Mira", "follow-up": "Old note" });
        const p = props("people", [r]);
        const view = render(createElement(ExistingWorkflows, p));
        fireEvent.change(screen.getByLabelText("Follow-up draft for Mira"), { target: { value: "Local draft" } });
        view.rerender(createElement(ExistingWorkflows, { ...p, records: [{ ...r, basePayload: { revision: 3 }, fields: { ...r.fields, "follow-up": "Changed elsewhere" } }] }));
        fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
        await waitFor(() => expect(p.onSave).toHaveBeenCalledOnce());
        expect(p.onSave.mock.calls[0][0].basePayload).toEqual({ revision: 2 });
        expect(p.onSave.mock.calls[0][0].fields["follow-up"]).toBe("Local draft");
    });
    it("retains an invoice draft after a failed save and shows a safe error", async () => {
        const p = props("cashflow", [record("i", { title: "Design work", status: "Sent", amount: 100, currency: "EUR", "due-date": "2026-01-01" })]);
        p.onSave = vi.fn(async () => { throw new Error("private database path"); });
        render(createElement(ExistingWorkflows, p));
        fireEvent.change(screen.getByLabelText("Reminder draft for Design work"), { target: { value: "Please review the invoice." } });
        fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
        await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Could not save. Your draft is still here; try again."));
        expect((screen.getByLabelText("Reminder draft for Design work") as HTMLTextAreaElement).value).toBe("Please review the invoice.");
    });
    it("reloads saved text only after an explicit discard action following a conflict", async () => {
        const r = record("p", { title: "Mira", "follow-up": "First note" });
        const p = props("people", [r]);
        p.onSave = vi.fn(async () => { throw new Error("conflict"); });
        const view = render(createElement(ExistingWorkflows, p));
        fireEvent.change(screen.getByLabelText("Follow-up draft for Mira"), { target: { value: "My draft" } });
        view.rerender(createElement(ExistingWorkflows, { ...p, records: [{ ...r, basePayload: { revision: 3 }, fields: { ...r.fields, "follow-up": "Latest saved text" } }] }));
        fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
        await screen.findByRole("alert");
        expect((screen.getByLabelText("Follow-up draft for Mira") as HTMLTextAreaElement).value).toBe("My draft");
        fireEvent.click(screen.getByRole("button", { name: "Discard draft and reload saved text" }));
        expect((screen.getByLabelText("Follow-up draft for Mira") as HTMLTextAreaElement).value).toBe("Latest saved text");
    });
    it("allows a daily date change without rescheduling records", () => {
        const p = props("agenda", [record("e", { title: "Planning", date: day, time: "09:00", status: "Scheduled" })]);
        render(createElement(ExistingWorkflows, p));
        fireEvent.change(screen.getByLabelText("Brief date"), { target: { value: day } });
        expect(within(screen.getByRole("region", { name: "Today brief" })).getByText("Planning")).toBeTruthy();
        expect(p.onSave).not.toHaveBeenCalled();
    });
});
