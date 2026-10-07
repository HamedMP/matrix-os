import { validCurrency, validDate } from "../model";
import type { OwnerRecord } from "../types";

const rows = (records: OwnerRecord[]) => records.slice(0, 1000).filter(row => !row.archivedAt);
const text = (value: unknown, limit = 12000) => typeof value === "string" ? value.slice(0, limit).trim() : "";
const positive = (value: unknown, max = 1e9): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
const normalize = (value: unknown) => text(value, 200).toLocaleLowerCase().replace(/\s+/g, " ");

export function workoutHistory(records: OwnerRecord[]) {
  const exercises: Array<{ exercise: string; volumeKg: number; heaviestKg: number; sets: number; trend: Array<{ date: string; volumeKg: number; heaviestKg: number }> }> = [];
  let warmups = 0, unconfirmed = 0;
  for (const row of rows(records)) {
    const f = row.fields;
    const exercise = normalize(f.exercise);
    if (!exercise || !validDate(f.date) || !positive(f.weight, 1500) || !positive(f.reps, 200) || !Number.isInteger(f.reps) || f.reps < 1 || !["kg", "lb"].includes(String(f.unit)) || !["Working", "Warmup"].includes(String(f["set-type"]))) { unconfirmed++; continue; }
    if (f["set-type"] === "Warmup") { warmups++; continue; }
    const kg = f.weight * (f.unit === "lb" ? 0.45359237 : 1);
    let group = exercises.find(item => item.exercise === exercise);
    if (!group) { group = { exercise, volumeKg: 0, heaviestKg: 0, sets: 0, trend: [] }; exercises.push(group); }
    group.volumeKg += kg * f.reps; group.heaviestKg = Math.max(group.heaviestKg, kg); group.sets++;
    let day = group.trend.find(item => item.date === f.date);
    if (!day) { day = { date: f.date, volumeKg: 0, heaviestKg: 0 }; group.trend.push(day); }
    day.volumeKg += kg * f.reps; day.heaviestKg = Math.max(day.heaviestKg, kg);
  }
  for (const group of exercises) group.trend.sort((a, b) => a.date.localeCompare(b.date));
  return { exercises: exercises.sort((a, b) => a.exercise.localeCompare(b.exercise)), warmups, unconfirmed };
}

export function planRunway(records: OwnerRecord[], options: { today: string; payday: string }) {
  if (!validDate(options.today) || !validDate(options.payday) || options.payday < options.today) throw new Error("Choose valid dates with payday after today.");
  const groups: Array<{ currency: string; scope: OwnerRecord["scope"]; available: number; required: number; remaining: number; shortfall: number; allocations: Array<{ record: OwnerRecord; allocated: number; shortfall: number }>; opening?: OwnerRecord }> = [];
  const eligible = rows(records).filter(row => validCurrency(row.fields.currency) && positive(row.fields.amount) && validDate(row.fields.date));
  for (const row of eligible) {
    const currency = String(row.fields.currency);
    if (!groups.some(group => group.currency === currency && group.scope === row.scope)) groups.push({ currency, scope: row.scope, available: 0, required: 0, remaining: 0, shortfall: 0, allocations: [] });
  }
  for (const group of groups) {
    const matching = eligible.filter(row => row.fields.currency === group.currency && row.scope === group.scope);
    const balances = matching.filter(row => row.fields.kind === "Opening balance" && row.fields.status === "Confirmed" && String(row.fields.date) <= options.today).sort((a, b) => String(b.fields.date).localeCompare(String(a.fields.date)) || b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    group.opening = balances[0];
    const openingDate = String(group.opening?.fields.date ?? "");
    let availableCents = Math.round(Number(group.opening?.fields.amount ?? 0) * 100);
    // Received cash after the opening snapshot can be allocated. Forecast income
    // never increases today's available money, even when its date is confirmed.
    for (const row of matching) if (group.opening && row.fields.kind === "Income" && row.fields.status === "Received" && String(row.fields.date) > openingDate && String(row.fields.date) <= options.today) availableCents += Math.round(Number(row.fields.amount) * 100);
    group.available = availableCents / 100;
    const commitments = matching.filter(row => ["Bill", "Reserve"].includes(String(row.fields.kind)) && row.fields.status === "Confirmed" && String(row.fields.date) <= options.payday).sort((a, b) => String(a.fields.date).localeCompare(String(b.fields.date)) || a.id.localeCompare(b.id));
    let requiredCents = 0;
    for (const row of commitments) {
      const amount = Math.round(Number(row.fields.amount) * 100), allocated = Math.min(availableCents, amount);
      availableCents -= allocated; requiredCents += amount;
      group.allocations.push({ record: row, allocated: allocated / 100, shortfall: (amount - allocated) / 100 });
    }
    group.required = requiredCents / 100; group.remaining = availableCents / 100; group.shortfall = Math.max(0, requiredCents / 100 - group.available);
  }
  return groups.sort((a, b) => a.scope.localeCompare(b.scope) || a.currency.localeCompare(b.currency));
}

export interface Ingredient { name: string; quantity: number; unit: string }
export function parseIngredients(value: unknown): { ingredients: Ingredient[]; issues: string[] } {
  const ingredients: Ingredient[] = [], issues: string[] = [];
  const lines = text(value).split(/\r?\n/).filter(line => line.trim());
  if (lines.length > 100) issues.push("Keep each meal to 100 ingredient lines.");
  for (const line of lines.slice(0, 100)) {
    const parts = line.split("|").map(part => part.trim());
    const name = normalize(parts[0]), amount = Number(parts[1]), rawUnit = normalize(parts[2]);
    if (parts.length !== 3 || !name || !parts[1] || !positive(amount, 100000) || !/^[a-z ]{1,24}$/.test(rawUnit)) { issues.push(`Review ingredient: ${line.slice(0, 120)}`); continue; }
    const units: Record<string, [string, number]> = { kg: ["g", 1000], kilogram: ["g", 1000], kilograms: ["g", 1000], g: ["g", 1], gram: ["g", 1], grams: ["g", 1], l: ["ml", 1000], liter: ["ml", 1000], litre: ["ml", 1000], ml: ["ml", 1], each: ["each", 1], pcs: ["each", 1], piece: ["each", 1], pieces: ["each", 1] };
    const [unit, multiplier] = units[rawUnit] ?? [rawUnit, 1];
    ingredients.push({ name, quantity: amount * multiplier, unit });
  }
  return { ingredients, issues };
}
export function mealGroceries(records: OwnerRecord[]) {
  const items: Ingredient[] = [], issues: string[] = [];
  for (const row of rows(records)) {
    if (row.fields.status !== "Planned") continue;
    const servings = row.fields.servings, portions = row.fields["planned-portions"];
    if (!validDate(row.fields.date) || !positive(servings, 100) || servings < 1 || !positive(portions, 100) || portions < 1) { issues.push(`${text(row.fields.title, 100) || "Meal"}: confirm date, recipe servings and planned portions.`); continue; }
    const recipe = parseIngredients(row.fields.ingredients), pantry = parseIngredients(row.fields.pantry);
    issues.push(...recipe.issues, ...pantry.issues);
    const required: Ingredient[] = [];
    for (const ingredient of recipe.ingredients) {
      const existing = required.find(item => item.name === ingredient.name && item.unit === ingredient.unit);
      if (existing) existing.quantity += ingredient.quantity * portions / servings;
      else required.push({ ...ingredient, quantity: ingredient.quantity * portions / servings });
    }
    for (const ingredient of required) {
      const allocatedPantry = pantry.ingredients.filter(item => item.name === ingredient.name && item.unit === ingredient.unit).reduce((sum, item) => sum + item.quantity, 0);
      const quantity = Math.max(0, ingredient.quantity - allocatedPantry);
      if (!quantity) continue;
      const existing = items.find(item => item.name === ingredient.name && item.unit === ingredient.unit);
      if (existing) existing.quantity += quantity; else items.push({ ...ingredient, quantity });
    }
  }
  return { items: items.sort((a, b) => a.name.localeCompare(b.name) || a.unit.localeCompare(b.unit)), issues: issues.slice(0, 100) };
}

export function interviewPacket(record: OwnerRecord) {
  const f = record.fields, confirmed = f.certainty === "Confirmed";
  let zoneValid = false;
  try { if (text(f.timezone, 100)) { new Intl.DateTimeFormat("en", { timeZone: String(f.timezone) }).format(); zoneValid = true; } } catch (error) { if (!(error instanceof RangeError)) throw error; }
  const calendarReady = confirmed && f.stage === "Interview" && validDate(f["interview-date"]) && /^([01]\d|2[0-3]):[0-5]\d$/.test(text(f["interview-time"], 10)) && zoneValid;
  return { confirmed, calendarReady, text: [`${text(f.title, 200) || "Role"} at ${text(f.company, 200) || "Company to confirm"}`, `${confirmed ? "Confirmed" : "Estimated"} stage: ${text(f.stage, 100) || "Unknown"}`, calendarReady ? `Interview: ${f["interview-date"]} ${f["interview-time"]} (${f.timezone})` : "Interview date, time or timezone still needs confirmation.", `Next step: ${text(f["next-step"], 2000) || "Add your next step"}`, `Résumé provided by you:\n${text(f.resume, 6000) || "No résumé provided"}`, `Notes:\n${text(f.notes, 2000) || "No notes yet"}`].join("\n\n") };
}

export interface PracticeCard { question: string; answer: string; quote: string; sourceId: string; supported: boolean }
export function sourceQuestions(record: OwnerRecord): PracticeCard[] {
  const passage = text(record.fields["source-text"]);
  const question = text(record.fields.question, 2000), answer = text(record.fields.answer, 2000), quote = text(record.fields.quote, 2000);
  if (question || answer) return [{ question: question || "Question to review", answer, quote, sourceId: record.id, supported: Boolean(answer && quote && passage.includes(quote)) }];
  const sentences = passage.match(/[^.!?\n]+(?:[.!?]|$)/g)?.map(sentence => sentence.trim()).filter(sentence => sentence.length > 12) ?? [];
  return sentences.slice(0, 5).map(sentence => {
    const word = sentence.match(/([\p{L}\p{N}][\p{L}\p{N}'’-]*)[.!?]?$/u)?.[1];
    return { question: word ? `Complete from your notes: ${sentence.slice(0, sentence.lastIndexOf(word))}___${/[.!?]$/.test(sentence) ? sentence.slice(-1) : ""}` : "What does this passage say?", answer: word ?? sentence, quote: sentence, sourceId: record.id, supported: true };
  });
}

export class JournalSelectionError extends Error {
  constructor(readonly reason: "period" | "scope") { super(reason === "period" ? "Choose a valid reflection period." : "Select either Personal or Work entries; Personal and Work cannot be mixed in one reflection."); }
}
export function journalSelection(records: OwnerRecord[], period: { start: string; end: string }) {
  if (!validDate(period.start) || !validDate(period.end) || period.end < period.start) throw new JournalSelectionError("period");
  const selected = rows(records).filter(row => row.fields.include !== "Exclude" && row.fields.kind !== "Reflection" && validDate(row.fields.date) && row.fields.date >= period.start && row.fields.date <= period.end && text(row.fields.entry)).sort((a, b) => String(a.fields.date).localeCompare(String(b.fields.date)) || a.id.localeCompare(b.id));
  if (selected.some(record => record.scope !== selected[0]?.scope)) throw new JournalSelectionError("scope");
  return selected;
}
export function reflectionDraft(records: OwnerRecord[], period: { start: string; end: string }) {
  const candidates = journalSelection(records, period).slice(0, 20), selected: OwnerRecord[] = [];
  const chunks = [`Your selected entries: ${period.start} to ${period.end}`];
  let size = chunks[0].length;
  for (const row of candidates) {
    const chunk = `${row.fields.date}: ${text(row.fields.title, 100) || "Entry"}\nExcerpt: “${text(row.fields.entry, 380)}” [${row.id}]`;
    if (size + chunk.length + 2 > 10000) break;
    selected.push(row); chunks.push(chunk); size += chunk.length + 2;
  }
  const tags: Array<{ tag: string; ids: string[] }> = [];
  for (const row of selected) for (const tag of Array.from(new Set(text(row.fields.tags, 500).split(",").map(normalize).filter(Boolean))).slice(0, 12)) {
    const existing = tags.find(item => item.tag === tag);
    if (existing) existing.ids.push(row.id); else tags.push({ tag, ids: [row.id] });
  }
  const themes = tags.filter(item => item.ids.length > 1).sort((a, b) => b.ids.length - a.ids.length).slice(0, 5);
  for (const item of themes) {
    const theme = `You used “${item.tag}” in ${item.ids.length} entries [${item.ids.join(", ")}].`;
    if (size + theme.length + 2 > 11800) continue;
    chunks.push(theme); size += theme.length + 2;
  }
  chunks.push(`This digest uses excerpts from ${selected.length} entries, within its size budget. Review full entries for context.`);
  const entry = chunks.join("\n\n");
  return { title: `Reflection ${period.start} – ${period.end}`, date: period.end, entry, kind: "Reflection", include: "Exclude", "period-start": period.start, "period-end": period.end, "source-ids": selected.map(row => row.id).join("\n") };
}

export function correctedRecord(record: OwnerRecord, fields: OwnerRecord["fields"]): OwnerRecord {
  return { ...record, fields: { ...record.fields, ...fields }, manualFields: Array.from(new Set([...record.manualFields, ...Object.keys(fields)])), updatedAt: new Date().toISOString() };
}
export function newRecord(fields: OwnerRecord["fields"], scope: OwnerRecord["scope"] = "personal"): OwnerRecord {
  return { id: crypto.randomUUID(), fields, scope, accounts: [], sources: [], manualFields: Object.keys(fields), updatedAt: new Date().toISOString() };
}
