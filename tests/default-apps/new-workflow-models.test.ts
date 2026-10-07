import { describe, expect, it } from "vitest";
import type { OwnerRecord } from "../../home/app-templates/connected-starter/src/types";
import { workoutHistory, planRunway, mealGroceries, interviewPacket, sourceQuestions, journalSelection, reflectionDraft } from "../../home/app-templates/connected-starter/src/workflows/models";

function record(id: string, fields: OwnerRecord["fields"], extra: Partial<OwnerRecord> = {}): OwnerRecord {
  return { id, fields, scope: "personal", accounts: [], sources: [], manualFields: [], updatedAt: "2026-10-07", ...extra };
}
describe("workout history from saved sets", () => {
  it("normalizes pounds, excludes warmups from volume and records actual heaviest-set progression", () => {
    const result = workoutHistory([
      record("a", { exercise: " Bench press ", date: "2026-10-01", weight: 100, unit: "lb", reps: 5, "set-type": "Working" }),
      record("b", { exercise: "bench press", date: "2026-10-07", weight: 50, unit: "kg", reps: 5, "set-type": "Working" }),
      record("c", { exercise: "Bench press", date: "2026-10-07", weight: 60, unit: "kg", reps: 1, "set-type": "Warmup" }),
    ]);
    expect(result.exercises).toHaveLength(1);
    expect(result.exercises[0].volumeKg).toBeCloseTo(476.796185);
    expect(result.exercises[0].heaviestKg).toBe(50);
    expect(result.exercises[0].trend).toHaveLength(2);
    expect(result.warmups).toBe(1);
  });
  it("keeps invalid units, fractional reps and archived sets out of confirmed calculations", () => {
    const fields = { exercise: "Squat", date: "2026-10-07", weight: 50, unit: "kg", reps: 5, "set-type": "Working" };
    const result = workoutHistory([record("a", { ...fields, unit: "unknown" }), record("b", { ...fields, reps: 2.5 }), record("c", fields, { archivedAt: "2026-10-07" })]);
    expect(result.exercises).toEqual([]); expect(result.unconfirmed).toBe(2);
  });
});
describe("cash allocation before payday", () => {
  const options = { today: "2026-10-07", payday: "2026-10-14" };
  it("allocates confirmed cash in due-date order without spending future income", () => {
    const rows = [record("cash", { kind: "Opening balance", status: "Confirmed", amount: 100, currency: "USD", date: "2026-10-07" }), record("future", { kind: "Income", status: "Confirmed", amount: 900, currency: "USD", date: "2026-10-12" }), record("b", { title: "Rent", kind: "Bill", status: "Confirmed", amount: 80, currency: "USD", date: "2026-10-10" }), record("a", { title: "Energy", kind: "Bill", status: "Confirmed", amount: 40, currency: "USD", date: "2026-10-09" })];
    const plan = planRunway(rows, options);
    expect(plan[0]).toMatchObject({ currency: "USD", available: 100, required: 120, shortfall: 20, remaining: 0 });
    expect(plan[0].allocations.map(a => [a.record.id, a.allocated, a.shortfall])).toEqual([["a", 40, 0], ["b", 60, 20]]);
  });
  it("separates currencies and ownership groups, excludes estimates, paid bills and invalid dates", () => {
    const rows = [record("usd", { kind: "Opening balance", status: "Confirmed", amount: 10, currency: "USD", date: options.today }), record("eur", { kind: "Opening balance", status: "Confirmed", amount: 20, currency: "EUR", date: options.today }), record("work", { kind: "Opening balance", status: "Confirmed", amount: 100, currency: "USD", date: options.today }, { scope: "work" }), record("estimated", { kind: "Bill", status: "Estimate", amount: 900, currency: "USD", date: options.today }), record("paid", { kind: "Bill", status: "Paid", amount: 900, currency: "USD", date: options.today })];
    const plan = planRunway(rows, options);
    expect(plan.map(p => [p.scope, p.currency, p.available]).sort()).toEqual([["personal", "EUR", 20], ["personal", "USD", 10], ["work", "USD", 100]]);
    expect(plan.every(p => p.required === 0)).toBe(true);
    expect(() => planRunway(rows, { ...options, payday: "2026-02-30" })).toThrow();
  });
  it("uses the latest opening snapshot plus only income received after its date", () => {
    const rows = [record("old", { kind: "Opening balance", status: "Confirmed", amount: 100, currency: "USD", date: "2026-10-01" }), record("latest", { kind: "Opening balance", status: "Confirmed", amount: 50, currency: "USD", date: "2026-10-05" }), record("income", { kind: "Income", status: "Received", amount: 10, currency: "USD", date: "2026-10-06" })];
    expect(planRunway(rows, options)[0].available).toBe(60);
  });
  it("deducts paid commitments only after the opening snapshot through today", () => {
    const cash = record("cash", { kind: "Opening balance", status: "Confirmed", amount: 100, currency: "USD", date: "2026-10-05" });
    const paid = (id: string, date: string, amount: number, kind = "Bill") => record(id, { kind, status: "Paid", amount, currency: "USD", date });
    const upcoming = record("upcoming", { kind: "Bill", status: "Confirmed", amount: 80, currency: "USD", date: "2026-10-10" });
    const futureIncome = record("future-income", { kind: "Income", status: "Received", amount: 900, currency: "USD", date: "2026-10-08" });
    const plan = planRunway([cash, paid("before", "2026-10-04", 400), paid("snapshot", "2026-10-05", 400), paid("bill", "2026-10-06", 40), paid("reserve", options.today, 20, "Reserve"), paid("future", "2026-10-08", 400), upcoming, futureIncome], options)[0];
    expect(plan).toMatchObject({ available: 40, required: 80, shortfall: 40, remaining: 0 });
    expect(plan.allocations).toEqual([expect.objectContaining({ record: upcoming, allocated: 40, shortfall: 40 })]);
  });
  it("never allocates negative cash when paid commitments exceed the snapshot", () => {
    const plan = planRunway([
      record("cash", { kind: "Opening balance", status: "Confirmed", amount: 100, currency: "USD", date: "2026-10-05" }),
      record("paid", { kind: "Reserve", status: "Paid", amount: 150, currency: "USD", date: options.today }),
      record("bill", { kind: "Bill", status: "Confirmed", amount: 80, currency: "USD", date: options.payday }),
    ], options)[0];
    expect(plan.available).toBe(-50); expect(plan.allocations[0]).toMatchObject({ allocated: 0, shortfall: 80 });
    expect(plan.shortfall).toBe(130);
    expect(planRunway([record("paid", { kind: "Bill", status: "Paid", amount: 60, currency: "USD", date: options.today })], options)[0].available).toBe(0);
  });
  it("includes confirmed overdue unpaid bills before allocating later commitments", () => {
    const rows = [record("cash", { kind: "Opening balance", status: "Confirmed", amount: 100, currency: "USD", date: options.today }), record("old", { kind: "Bill", status: "Confirmed", amount: 50, currency: "USD", date: "2026-10-01" })];
    expect(planRunway(rows, options)[0].allocations[0]).toMatchObject({ record: { id: "old" }, allocated: 50 });
  });
});
describe("portion-scaled grocery plan", () => {
  it("merges compatible normalized ingredients and subtracts only assigned pantry portions", () => {
    const meals = [record("a", { title: "Rice bowl", status: "Planned", date: "2026-10-07", servings: 2, "planned-portions": 4, ingredients: "Rice | 0.2 | kg\nEgg | 2 | each", pantry: "rice | 100 | g" }), record("b", { title: "Egg rice", status: "Planned", date: "2026-10-08", servings: 1, "planned-portions": 1, ingredients: " rice  | 50 | g\negg | 1 | each" })];
    const result = mealGroceries(meals);
    expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ name: "rice", unit: "g", quantity: 350 }), expect.objectContaining({ name: "egg", unit: "each", quantity: 5 })]));
    expect(result.issues).toEqual([]);
  });
  it("keeps unknown units distinct, flags malformed lines and does not manufacture quantities", () => {
    const result = mealGroceries([record("a", { status: "Planned", date: "2026-10-07", servings: 1, "planned-portions": 1, ingredients: "rice | 2 | cup\nrice | 100 | g\nsalt to taste\nwater | -1 | ml" })]);
    expect(result.items).toHaveLength(2); expect(result.issues).toHaveLength(2);
    expect(mealGroceries([record("b", { status: "Recipe", servings: 1, ingredients: "rice | 1 | g" })]).items).toEqual([]);
  });
});
describe("reviewed application packet", () => {
  it("keeps employer-confirmed and estimated stages distinct and flags incomplete interview scheduling", () => {
    const row = record("job", { title: "Engineer", company: "Example", stage: "Interview", certainty: "Estimate", "interview-date": "2026-10-08", resume: "Owned résumé" });
    const packet = interviewPacket(row);
    expect(packet.confirmed).toBe(false); expect(packet.calendarReady).toBe(false); expect(packet.text).toContain("Estimated stage"); expect(packet.text).toContain("Owned résumé");
    expect(interviewPacket(record("job", { ...row.fields, certainty: "Confirmed", "interview-time": "14:30", timezone: "Europe/Stockholm" })).calendarReady).toBe(true);
  });
});
describe("source-backed study practice", () => {
  it("makes questions with exact passage quotations and respects corrected question/answer fields", () => {
    const row = record("notes", { title: "Biology", "source-text": "Mitochondria produce ATP. Chloroplasts perform photosynthesis." });
    const cards = sourceQuestions(row);
    expect(cards).toHaveLength(2); expect(cards.every(card => String(row.fields["source-text"]).includes(card.quote))).toBe(true);
    const corrected = sourceQuestions(record("edited", { ...row.fields, question: "What produces ATP?", answer: "Mitochondria", quote: "Mitochondria produce ATP." }));
    expect(corrected[0]).toMatchObject({ question: "What produces ATP?", answer: "Mitochondria", quote: "Mitochondria produce ATP." });
  });
  it("flags an answer without a valid supporting quote and bounds large passages", () => {
    expect(sourceQuestions(record("bad", { "source-text": "Known fact.", question: "Who?", answer: "Invented", quote: "Not in passage" }))[0].supported).toBe(false);
    expect(sourceQuestions(record("long", { "source-text": "Known fact. ".repeat(1000) })).length).toBeLessThanOrEqual(5);
  });
});
describe("selected private journal memory", () => {
  const options = { start: "2026-10-01", end: "2026-10-07" };
  it("excludes opted-out, archived, outside-period, and reflection records from synthesis inputs", () => {
    const rows = [record("yes", { title: "Walk", date: "2026-10-05", entry: "Walked with Ada", include: "Include", kind: "Entry", tags: "walk, Ada" }), record("no", { date: "2026-10-06", entry: "Private excluded detail", include: "Exclude" }), record("later", { date: "2026-10-09", entry: "Later" }), record("reflection", { date: "2026-10-05", entry: "Prior synthesis", kind: "Reflection" })];
    expect(journalSelection(rows, options).map(row => row.id)).toEqual(["yes"]);
    const draft = reflectionDraft(rows, options);
    expect(draft.entry).toContain("Walked with Ada"); expect(draft["source-ids"]).toBe("yes"); expect(draft.entry).not.toContain("Private excluded");
  });
  it("uses the latest corrected text on every reopening and never infers diagnoses", () => {
    const row = record("entry", { title: "A day", date: "2026-10-05", entry: "Corrected meeting with Bea", include: "Include" });
    expect(reflectionDraft([row], options).entry).toContain("Corrected meeting with Bea");
    expect(() => journalSelection([row], { start: "2026-10-07", end: "2026-10-01" })).toThrow();
  });
  it("keeps each source citation complete when a digest reaches its size budget", () => {
    const rows = Array.from({ length: 20 }, (_, index) => record(`${index}-${"x".repeat(190)}`, { title: "A".repeat(100), date: "2026-10-05", entry: "Actual passage ".repeat(500), tags: Array.from({ length: 5 }, (_, i) => `${i}${"t".repeat(80)}`).join(",") }));
    const draft = reflectionDraft(rows, options);
    expect(draft.entry.length).toBeLessThanOrEqual(12000);
    for (const id of draft["source-ids"].split("\n")) expect(draft.entry).toContain(`[${id}]`);
  });
  it("rejects synthesis that would mix Personal and Work journal ownership", () => {
    const fields = { date: "2026-10-05", entry: "Entry" };
    expect(() => reflectionDraft([record("personal", fields), record("work", fields, { scope: "work" })], options)).toThrow(/Personal and Work/);
  });
});
