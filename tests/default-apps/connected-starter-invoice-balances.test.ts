import { describe, expect, it } from "vitest";
import { receivablesSummary } from "../../home/app-templates/connected-starter/src/model";
import type { OwnerRecord } from "../../home/app-templates/connected-starter/src/types";

function invoice(fields: OwnerRecord["fields"], extra: Partial<OwnerRecord> = {}): OwnerRecord {
  return { id: "invoice", scope: "personal", fields, accounts: [], sources: [],
    manualFields: [], updatedAt: "2026-10-10", ...extra };
}

describe("remaining invoice balances", () => {
  it("includes partial invoices at their unpaid balance without mixing currencies", () => {
    expect(receivablesSummary([
      invoice({ status: "Partial", amount: 100, "paid-amount": 40, currency: "EUR" }),
      invoice({ status: "Partial", amount: 50, "paid-amount": 10, currency: "EUR" }),
      invoice({ status: "Partial", amount: 200, "paid-amount": 50, currency: "SEK" }),
      invoice({ status: "Sent", amount: 20, currency: "EUR" }),
      invoice({ status: "Overdue", amount: 30, currency: "EUR" }),
    ])).toEqual({ EUR: { Partial: 100, Sent: 20, Overdue: 30 }, SEK: { Partial: 150 } });
  });

  it.each([undefined, null, "40", -1, 101, Infinity, NaN])(
    "excludes partial invoices whose paid amount is invalid: %s", paid => {
      expect(receivablesSummary([invoice({ status: "Partial", amount: 100,
        ...(paid === undefined ? {} : { "paid-amount": paid }), currency: "EUR" })])).toEqual({});
    },
  );

  it("keeps zero-paid invoices and excludes settled or archived invoices", () => {
    expect(receivablesSummary([
      invoice({ status: "Partial", amount: 100, "paid-amount": 0, currency: "EUR" }),
      invoice({ status: "Partial", amount: 100, "paid-amount": 100, currency: "EUR" }),
      invoice({ status: "Paid", amount: 100, currency: "EUR" }),
      invoice({ status: "Externally paid", amount: 100, currency: "EUR" }),
      invoice({ status: "Partial", amount: 100, "paid-amount": 20, currency: "EUR" },
        { archivedAt: "2026-10-10" }),
    ])).toEqual({ EUR: { Partial: 100 } });
  });
});
