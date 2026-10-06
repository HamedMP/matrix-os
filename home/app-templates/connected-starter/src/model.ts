import type { Account, Definition, Evidence, OwnerRecord } from "./types";
const currencies = Intl.supportedValuesOf("currency");
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeZone: "UTC",
});
export function validCurrency(value: unknown): value is string {
  return typeof value === "string" && currencies.includes(value);
}
export function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(value + "T12:00:00Z");
  return (
    Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value
  );
}
export function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : undefined;
  } catch (error) {
    if (!(error instanceof TypeError)) console.warn("Link could not be parsed");
    return;
  }
}
export function validateFields(
  app: Definition,
  values: OwnerRecord["fields"],
): string[] {
  const errors: string[] = [];
  for (const field of app.fields) {
    const value = values[field.key];
    if (value == null || value === "") {
      if (field.required) errors.push(`${field.label} is required`);
      continue;
    }
    if (field.kind === "money" || field.kind === "number") {
      const nonnegative = field.kind === "money" || field.key === "minutes";
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (nonnegative && value < 0) ||
        Math.abs(Number(value)) > 1e12
      )
        errors.push(
          `${field.label} must be ${nonnegative ? "a non-negative" : "a valid"} number`,
        );
    } else if (
      typeof value !== "string" ||
      value.length > (field.kind === "longtext" ? 12000 : 1000)
    )
      errors.push(`${field.label} is too long`);
    else if (field.kind === "date" && !validDate(value))
      errors.push(`${field.label} must be a valid date`);
    else if (field.kind === "select" && !field.options?.includes(value))
      errors.push(`${field.label} is not a valid choice`);
    else if (field.kind === "url" && !safeUrl(value))
      errors.push(`${field.label} must be a secure web link`);
    else if (field.key === "currency" && !validCurrency(value))
      errors.push("Currency must be a supported three-letter code");
  }
  if (
    validDate(values.date) &&
    validDate(values["end-date"]) &&
    values["end-date"] < values.date
  )
    errors.push("Return must follow departure");
  return errors;
}
export function readRecords(rows: unknown): OwnerRecord[] {
  if (!Array.isArray(rows)) throw new Error("Records could not be read");
  const result: OwnerRecord[] = [];
  for (const row of rows.slice(0, 1000)) {
    const p = row?.payload;
    if (
      !p ||
      typeof p !== "object" ||
      typeof p.id !== "string" ||
      p.id.length > 200 ||
      !p.fields ||
      typeof p.fields !== "object" ||
      Array.isArray(p.fields) ||
      p.archivedAt
    )
      continue;
    const fields = Object.fromEntries(
      Object.entries(p.fields)
        .slice(0, 20)
        .filter(
          ([key, value]) =>
            /^[a-z][a-z0-9-]{0,47}$/.test(key) &&
            (value === null ||
              (typeof value === "number" && Number.isFinite(value)) ||
              (typeof value === "string" && value.length <= 12000)),
        ),
    );
    const accounts: Account[] = [];
    for (const a of Array.isArray(p.accounts) ? p.accounts.slice(0, 16) : []) {
      if (
        !a ||
        typeof a.service !== "string" ||
        a.service.length > 64 ||
        typeof a.label !== "string" ||
        a.label.length > 200
      )
        continue;
      if (
        !accounts.some(
          (other) => other.service === a.service && other.label === a.label,
        )
      )
        accounts.push({
          service: a.service,
          label: a.label,
          email:
            typeof a.email === "string" ? a.email.slice(0, 254) : undefined,
        });
    }
    const sources: Evidence[] = [];
    for (const s of Array.isArray(p.sources) ? p.sources.slice(0, 100) : []) {
      if (
        !s ||
        typeof s.id !== "string" ||
        s.id.length > 512 ||
        typeof s.title !== "string" ||
        s.title.length > 500 ||
        typeof s.service !== "string" ||
        s.service.length > 64 ||
        typeof s.label !== "string" ||
        s.label.length > 200
      )
        continue;
      if (
        !sources.some(
          (other) =>
            other.id === s.id &&
            other.service === s.service &&
            other.label === s.label,
        )
      )
        sources.push({
          id: s.id,
          title: s.title,
          service: s.service,
          label: s.label,
          url: safeUrl(s.url),
          excerpt:
            typeof s.excerpt === "string"
              ? s.excerpt.slice(0, 4000)
              : undefined,
          date: typeof s.date === "string" ? s.date.slice(0, 100) : undefined,
        });
    }
    if (!result.some((r) => r.id === p.id))
      result.push({
        id: p.id,
        rowId: typeof row.id === "string" ? row.id : undefined,
        fields: fields as OwnerRecord["fields"],
        scope: p.scope === "work" ? "work" : "personal",
        accounts,
        sources,
        manualFields: Array.isArray(p.manualFields)
          ? p.manualFields
              .filter((k: unknown) => typeof k === "string")
              .slice(0, 20)
          : [],
        updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : "",
      });
  }
  return result;
}
export function filterRecords(
  records: OwnerRecord[],
  filter: {
    query: string;
    scope: "all" | "personal" | "work";
    account: string;
  },
): OwnerRecord[] {
  const query = filter.query.trim().toLocaleLowerCase();
  return records.filter(
    (r) =>
      !r.archivedAt &&
      (filter.scope === "all" || r.scope === filter.scope) &&
      (!filter.account ||
        r.accounts.some((a) => `${a.service}:${a.label}` === filter.account)) &&
      (!query ||
        Object.values(r.fields).join(" ").toLocaleLowerCase().includes(query)),
  );
}
export function financeSummary(records: OwnerRecord[]) {
  const totals: Record<string, number> = {},
    months: Record<string, Record<string, number>> = {},
    weeks: Record<string, Record<string, number>> = {};
  for (const record of records) {
    const { amount, currency, status, date } = record.fields;
    if (
      record.archivedAt ||
      !["Paid", "Succeeded"].includes(String(status)) ||
      typeof amount !== "number" ||
      !Number.isFinite(amount) ||
      amount < 0 ||
      !validCurrency(currency)
    )
      continue;
    totals[currency] = (totals[currency] ?? 0) + amount;
    if (validDate(date)) {
      const month = date.slice(0, 7),
        d = new Date(date + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      const week = d.toISOString().slice(0, 10);
      months[currency] ??= {};
      weeks[currency] ??= {};
      months[currency][month] = (months[currency][month] ?? 0) + amount;
      weeks[currency][week] = (weeks[currency][week] ?? 0) + amount;
    }
  }
  return { currencies: Object.keys(totals).sort(), totals, months, weeks };
}
function obligationSummary(
  records: OwnerRecord[],
  statuses: string[],
  cadence: boolean,
): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {},
    allowed = new Set(statuses.slice(0, 2));
  for (const record of records) {
    const { amount, currency, status } = record.fields;
    if (
      record.archivedAt ||
      !allowed.has(String(status)) ||
      typeof amount !== "number" ||
      !Number.isFinite(amount) ||
      amount < 0 ||
      !validCurrency(currency)
    )
      continue;
    const bucket =
      cadence &&
      (record.fields.cadence === "Monthly" ||
        record.fields.cadence === "Annual" ||
        record.fields.cadence === "Other")
        ? String(record.fields.cadence)
        : cadence
          ? "Unknown"
          : String(status);
    result[currency] ??= {};
    result[currency][bucket] = (result[currency][bucket] ?? 0) + amount;
  }
  return result;
}
export function recurringSummary(records: OwnerRecord[]) {
  return obligationSummary(records, ["Active"], true);
}
export function receivablesSummary(records: OwnerRecord[]) {
  return obligationSummary(records, ["Sent", "Overdue"], false);
}
export function agendaGroups(records: OwnerRecord[]) {
  const dates = Array.from(
    new Set(
      records.map((r) =>
        validDate(r.fields.date) ? r.fields.date : "Undated",
      ),
    ),
  ).sort((a, b) =>
    a === "Undated" ? 1 : b === "Undated" ? -1 : a.localeCompare(b),
  );
  return dates.map((date) => ({
    date,
    records: records.filter(
      (r) => (validDate(r.fields.date) ? r.fields.date : "Undated") === date,
    ),
  }));
}
export function exportRecords(app: Definition, records: OwnerRecord[]): string {
  const cell = (v: unknown) => {
    let value = String(v ?? "");
    if (/^[\s]*[=+@-]/.test(value)) value = "'" + value;
    return '"' + value.replaceAll('"', '""') + '"';
  };
  return (
    "\uFEFF" +
    [
      app.fields.map((f) => cell(f.label)).join(","),
      ...records
        .slice(0, 1000)
        .map((r) => app.fields.map((f) => cell(r.fields[f.key])).join(",")),
    ].join("\r\n")
  );
}
export function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch (error) {
    if (!(error instanceof RangeError))
      console.warn("Amount could not be formatted");
    return `${value.toFixed(2)} ${currency}`;
  }
}
export function dateText(value: unknown): string {
  return validDate(value)
    ? dateFormatter.format(new Date(value + "T12:00:00Z"))
    : "Date to confirm";
}
