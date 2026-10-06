import type { Database, OwnerRecord } from "./types";
// The native bridge validates JSON before transport; structuredClone retains invalid undefined values.
function payload(record: OwnerRecord): Omit<OwnerRecord, "rowId"> {
  const { rowId: _rowId, ...data } = record;
  return JSON.parse(JSON.stringify(data));
}
export async function persistRecord(
  db: Database,
  record: OwnerRecord,
): Promise<OwnerRecord> {
  const saved = { ...record, updatedAt: new Date().toISOString() };
  try {
    if (record.rowId) {
      await db.update("records", record.rowId, { payload: payload(saved) });
      return saved;
    }
    const result = await db.insert("records", {
      id: record.id,
      source_id: `manual:${record.id}`,
      payload: payload(saved),
    });
    if (!result || typeof result.id !== "string")
      throw new Error("Invalid save result");
    return { ...saved, rowId: result.id };
  } catch (error) {
    console.error("Record save failed", error);
    throw new Error("Save failed. Your changes are still here.");
  }
}
export async function archiveRecord(
  db: Database,
  record: OwnerRecord,
): Promise<void> {
  if (!record.rowId)
    throw new Error("Archive failed. Record is still available.");
  try {
    await db.update("records", record.rowId, {
      payload: payload({ ...record, archivedAt: new Date().toISOString() }),
    });
  } catch (error) {
    console.error("Record archive failed", error);
    throw new Error("Archive failed. Record is still available.");
  }
}
