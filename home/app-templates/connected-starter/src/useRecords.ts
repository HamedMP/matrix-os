import { useCallback, useEffect, useRef, useState } from "react";
import { readRecords } from "./model";
import { archiveRecord, persistRecord } from "./persistence";
import type { Database, OwnerRecord } from "./types";
export function useRecords() {
  const [records, setRecords] = useState<OwnerRecord[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [limited, setLimited] = useState(false);
  const revision = useRef(0),
    mounted = useRef(true);
  const reload = useCallback(async () => {
    const ticket = ++revision.current;
    setLoading(true);
    try {
      const db = window.MatrixOS?.db;
      if (!db) throw new Error("Owner data bridge unavailable");
      const result = await loadActive(
        db,
        () => mounted.current && ticket === revision.current,
      );
      if (result && mounted.current && ticket === revision.current) {
        setRecords(result.records);
        setLimited(result.limited);
        setError("");
      }
    } catch (cause) {
      console.error("Connected records load failed", cause);
      if (mounted.current && ticket === revision.current)
        setError("Your records could not be loaded. Try checking again.");
    } finally {
      if (mounted.current && ticket === revision.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void reload();
    const unsubscribe = window.MatrixOS?.db?.onChange?.(
      "records",
      () => void reload(),
    );
    return () => {
      mounted.current = false;
      revision.current++;
      unsubscribe?.();
    };
  }, [reload]);
  const save = async (record: OwnerRecord) => {
    const db = window.MatrixOS?.db;
    if (!db)
      throw new Error("Save is unavailable. Your changes are still here.");
    const saved = await persistRecord(db, record);
    if (mounted.current) {
      revision.current++;
      setLoading(false);
      setError("");
      setRecords((old) => [saved, ...old.filter((r) => r.id !== saved.id)]);
    }
    return saved;
  };
  const archive = async (record: OwnerRecord) => {
    const db = window.MatrixOS?.db;
    if (!db) throw new Error("Archive is unavailable. Record is still here.");
    await archiveRecord(db, record);
    if (mounted.current) {
      revision.current++;
      setLoading(false);
      setError("");
      setRecords((old) => old.filter((r) => r.id !== record.id));
    }
  };
  return { records, error, loading, limited, reload, save, archive };
}

async function loadActive(db: Database, current: () => boolean) {
  const records: OwnerRecord[] = [];
  const seen = new Set<string>(); // At most 1,001 ids; discarded when this bounded read completes.
  for (let page = 0; page < 10; page++) {
    const rows = await db.find("records", {
      limit: 500,
      offset: page * 500,
      orderBy: { created_at: "desc", id: "desc" },
    });
    if (!current()) return;
    if (!Array.isArray(rows)) throw new Error("Invalid record page");
    for (const record of readRecords(rows)) {
      if (!seen.has(record.id)) {
        seen.add(record.id);
        records.push(record);
      }
      if (records.length > 1000)
        return { records: records.slice(0, 1000), limited: true };
    }
    if (rows.length < 500) return { records, limited: false };
  }
  return { records, limited: true };
}
