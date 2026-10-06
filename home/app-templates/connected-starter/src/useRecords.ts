import { useCallback, useEffect, useRef, useState } from "react";
import { readRecords } from "./model";
import { archiveRecord, persistRecord } from "./persistence";
import type { OwnerRecord } from "./types";
export function useRecords() {
  const [records, setRecords] = useState<OwnerRecord[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const revision = useRef(0),
    mounted = useRef(true);
  const reload = useCallback(async () => {
    const ticket = ++revision.current;
    setLoading(true);
    try {
      const db = window.MatrixOS?.db;
      if (!db) throw new Error("Owner data bridge unavailable");
      const rows = await db.find("records", {
        limit: 1000,
        orderBy: { created_at: "desc" },
      });
      if (mounted.current && ticket === revision.current) {
        setRecords(readRecords(rows));
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
    if (mounted.current)
      setRecords((old) => [saved, ...old.filter((r) => r.id !== saved.id)]);
    return saved;
  };
  const archive = async (record: OwnerRecord) => {
    const db = window.MatrixOS?.db;
    if (!db) throw new Error("Archive is unavailable. Record is still here.");
    await archiveRecord(db, record);
    if (mounted.current)
      setRecords((old) => old.filter((r) => r.id !== record.id));
  };
  return { records, error, loading, reload, save, archive };
}
