import type { Database, OwnerRecord } from "./types";
export class RecordConflictError extends Error {
  constructor() {
    super(
      "This record changed since you opened it. Your draft is still here. Check records and review the latest version before saving.",
    );
  }
}
// The native bridge validates JSON before transport; structuredClone retains invalid undefined values.
function payload(
  record: OwnerRecord,
): Omit<OwnerRecord, "rowId" | "basePayload"> {
  const { rowId: _rowId, basePayload, ...data } = record;
  if (!basePayload) return JSON.parse(JSON.stringify(data));
  // Display bounds must never truncate stored evidence or opaque owner metadata.
  const baseFields = basePayload.fields && typeof basePayload.fields === "object" && !Array.isArray(basePayload.fields)
    ? basePayload.fields as Record<string, unknown> : {};
  const markers = Array.isArray(basePayload.manualFields) ? basePayload.manualFields : [];
  const { rowId: _storedRow, basePayload: _storedBase, ...stored } = basePayload;
  return JSON.parse(JSON.stringify({
    ...stored,
    fields: { ...baseFields, ...data.fields },
    scope: data.scope,
    manualFields: [...markers, ...data.manualFields.filter(key => !markers.includes(key))],
    updatedAt: data.updatedAt,
    ...(data.archivedAt ? { archivedAt: data.archivedAt } : {}),
  }));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function intended(value: Record<string, unknown>) {
  const { updatedAt: _time, rowId: _row, basePayload: _base, ...rest } = value;
  return canonical(rest);
}
async function guardedUpdate(
  db: Database,
  record: OwnerRecord,
  next: Record<string, unknown>,
) {
  if (!db.compareAndSwap || !record.rowId || !record.basePayload)
    throw new Error("Atomic record writes unavailable");
  const result = await db.compareAndSwap(
    "records",
    record.rowId,
    record.basePayload,
    { payload: next },
  );
  if (result?.ok === false) throw new RecordConflictError();
  if (result?.ok !== true) throw new Error("Invalid write result");
}
export async function persistRecord(
  db: Database,
  record: OwnerRecord,
): Promise<OwnerRecord> {
  const saved = { ...record, updatedAt: new Date().toISOString() };
  const next = payload(saved);
  try {
    if (record.rowId) {
      await guardedUpdate(db, record, next);
      return { ...saved, basePayload: next };
    }
    try {
      const result = await db.insert("records", {
        id: record.id,
        source_id: `manual:${record.id}`,
        payload: next,
      });
      if (!result || typeof result.id !== "string")
        throw new Error("Invalid save result");
      return { ...saved, rowId: result.id, basePayload: next };
    } catch (insertError) {
      if (!db.findOne) throw insertError;
      const existing = await db.findOne("records", record.id);
      if (!existing) throw insertError;
      if (!existing.payload || typeof existing.payload !== "object")
        throw new Error("Invalid stored record");
      const original = existing.payload as Record<string, unknown>;
      if (intended(original) !== intended(next))
        throw new RecordConflictError();
      return {
        ...saved,
        updatedAt:
          typeof original.updatedAt === "string"
            ? original.updatedAt
            : saved.updatedAt,
        rowId: String(existing.id),
        basePayload: original,
      };
    }
  } catch (error) {
    console.error("Record save failed", error);
    if (error instanceof RecordConflictError) throw error;
    throw new Error("Save failed. Your changes are still here.");
  }
}
export async function archiveRecord(
  db: Database,
  record: OwnerRecord,
): Promise<void> {
  try {
    await guardedUpdate(
      db,
      record,
      payload({ ...record, archivedAt: new Date().toISOString() }),
    );
  } catch (error) {
    console.error("Record archive failed", error);
    if (error instanceof RecordConflictError) throw error;
    throw new Error("Archive failed. Record is still available.");
  }
}
