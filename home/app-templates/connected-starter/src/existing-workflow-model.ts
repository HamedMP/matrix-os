import { validCurrency, validDate } from "./model";
import type { OwnerRecord } from "./types";
const LIMIT = 1000;
export const text = (record: OwnerRecord, key: string) => String(record.fields[key] ?? "").trim();
const date = (value: unknown) => validDate(value) ? String(value) : null;
const amount = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e12 ? value : null;
const days = (from: string, to: string) => Math.floor((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000);
export function invoiceQueue(records: OwnerRecord[], today: string) {
    return records.slice(0, LIMIT).map(record => {
        const status = text(record, "status"), total = amount(record.fields.amount), paid = amount(record.fields["paid-amount"]);
        const due = date(record.fields["due-date"]), currency = validCurrency(record.fields.currency) ? text(record, "currency") : null;
        const outstanding = ["Paid", "Externally paid"].includes(status) ? 0 : total !== null && (status !== "Partial" || (paid !== null && paid <= total)) ? Math.max(0, total - (status === "Partial" ? paid! : 0)) : null;
        const daysLate = due && validDate(today) ? days(due, today) : null;
        const lane = ["Paid", "Externally paid"].includes(status) ? "Settled" : status === "Disputed" ? "On hold" : !["Sent", "Overdue", "Partial"].includes(status) ? "Review status" : outstanding === null || currency === null ? "Review amount" : !due ? "Review dates" : outstanding === 0 ? "Settled" : daysLate !== null && daysLate > 0 ? "Overdue" : "Upcoming";
        return { record, outstanding, currency, due, daysLate, lane };
    });
}
export function renewalQueue(records: OwnerRecord[], today: string) {
    return records.slice(0, LIMIT).filter(record => text(record, "status") === "Active").map(record => {
        const confirmed = text(record, "renewal-certainty") === "Confirmed";
        const renewal = confirmed ? date(record.fields["renewal-date"]) : null;
        return { record, renewal, daysUntil: renewal && validDate(today) ? days(today, renewal) : null, cancelBy: date(record.fields["cancel-by"]), certainty: text(record, "renewal-certainty") || "Unknown" };
    }).sort((a, b) => (a.daysUntil ?? Infinity) - (b.daysUntil ?? Infinity));
}
export function receiptReview(records: OwnerRecord[]) {
    const bounded = records.slice(0, LIMIT);
    const sourceKey = (record: OwnerRecord, source: OwnerRecord["sources"][number]) => JSON.stringify([record.scope, source.service, source.label, source.id]);
    // Capped at 100,000 entries (1,000 records × 100 sources); discarded after this derivation.
    const sourceCounts = new Map<string, number>();
    for (const record of bounded) {
        const keys = new Set(record.sources.slice(0, 100).map(source => sourceKey(record, source)));
        for (const key of keys)
            sourceCounts.set(key, (sourceCounts.get(key) || 0) + 1);
    }
    return bounded.map(record => {
        const reasons: string[] = [];
        if (text(record, "status") === "Needs review")
            reasons.push("Review requested");
        if (amount(record.fields.amount) === null)
            reasons.push("Amount missing or invalid");
        if (!validCurrency(record.fields.currency))
            reasons.push("Currency missing or invalid");
        if (!date(record.fields.date))
            reasons.push("Receipt date missing or invalid");
        if (!text(record, "provider"))
            reasons.push("Provider missing");
        if (record.sources.slice(0, 100).some(source => (sourceCounts.get(sourceKey(record, source)) || 0) > 1))
            reasons.push("Possible duplicate source");
        return { record, reasons };
    });
}
export function contactReview(records: OwnerRecord[], today: string) {
    const bounded = records.slice(0, LIMIT);
    return bounded.map(record => {
        const email = text(record, "email").toLowerCase(), name = text(record, "title").toLowerCase();
        const identityReview = !email || bounded.some(other => other.id !== record.id && other.scope === record.scope && ((email && text(other, "email").toLowerCase() === email) || (name && text(other, "title").toLowerCase() === name && text(other, "email").toLowerCase() !== email)));
        const last = date(record.fields["last-contact"]), next = date(record.fields["next-contact"]);
        return { record, identityReview, last, next, daysSince: last && validDate(today) ? days(last, today) : null };
    });
}
export interface MeetingAction {
    task: string;
    owner: string | null;
    due: string | null;
    status: "Open" | "Done" | "Unknown";
}
export function meetingActions(value: unknown): MeetingAction[] {
    return String(value ?? "").slice(0, 10000).split("\n").map(line => line.trim()).filter(Boolean).slice(0, 50).map(line => {
        const parts = line.split("|").map(part => part.trim());
        return { task: parts[0], owner: parts[1] || null, due: date(parts[2]), status: parts[3] === "Open" || parts[3] === "Done" ? parts[3] : "Unknown" };
    });
}
export function projectRisks(record: OwnerRecord, today: string): string[] {
    if (text(record, "status") === "Done")
        return [];
    const flags: string[] = [], due = date(record.fields["due-date"]), updated = date(record.fields["source-updated"]);
    if (text(record, "status") === "Blocked")
        flags.push("Blocked");
    if (due && validDate(today) && days(due, today) > 0)
        flags.push("Past recorded due date");
    if (!text(record, "assignee"))
        flags.push("Owner not recorded");
    if (updated && validDate(today) && days(updated, today) > 14)
        flags.push("Source older than 14 days");
    return flags;
}
export function dailyEvents(records: OwnerRecord[], day: string): OwnerRecord[] {
    if (!validDate(day))
        return [];
    const clock = (record: OwnerRecord) => /^([01]\d|2[0-3]):[0-5]\d$/.test(text(record, "time")) ? text(record, "time") : "99:99";
    return records.slice(0, LIMIT).filter(record => text(record, "date") === day && text(record, "status") === "Scheduled").sort((a, b) => clock(a).localeCompare(clock(b)));
}
export function tripChecks(record: OwnerRecord) {
    const checks = [{ label: "Destination", ready: !!text(record, "destination") }, { label: "Departure date", ready: !!date(record.fields.date) }, { label: "Return date", ready: !!date(record.fields["end-date"]) && (!date(record.fields.date) || String(record.fields["end-date"]) >= String(record.fields.date)) }, { label: "Booking reference", ready: !!text(record, "booking") }];
    if (text(record, "travel-mode") === "Flight")
        checks.push({ label: "Flight number", ready: !!text(record, "flight") });
    return checks;
}
