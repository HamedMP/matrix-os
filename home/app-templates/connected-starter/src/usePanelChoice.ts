import { useEffect, useRef, useState } from "react";
import type { Database } from "./types";
// The host scopes this metadata row to the installed app's owner database.
// It has no record id/fields, so record lists and exports do not project it.
const preferenceId = "f954d542-8bfe-4a50-bac8-10ba5fbe9f25";
function payload(row: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!row) return null;
  const value = row.payload;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid panel preference");
  const p = value as Record<string, unknown>;
  if (p.kind !== "matrix:panel:v1" || typeof p.controlsOpen !== "boolean" || p.id !== undefined || p.fields !== undefined || JSON.stringify(p).length > 1024) throw new Error("Invalid panel preference");
  return p;
}
async function save(db: Database | undefined, controlsOpen: boolean) {
  if (!db?.findOne || !db.compareAndSwap) throw new Error("Panel preference unavailable");
  let row = await db.findOne("records", preferenceId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = payload(row);
    if (!current) {
      try {
        await db.insert("records", { id: preferenceId, source_id: "matrix:panel:v1", payload: { kind: "matrix:panel:v1", controlsOpen } });
        return;
      } catch (cause) {
        // Another client may have created the same app-scoped preference.
        row = await db.findOne("records", preferenceId);
        if (!row) throw cause;
      }
    } else {
      const result = await db.compareAndSwap("records", preferenceId, current, { payload: { ...current, controlsOpen } });
      if (result?.ok === true) return;
      if (result?.ok !== false) throw new Error("Invalid panel save result");
      row = await db.findOne("records", preferenceId);
    }
  }
  throw new Error("Panel preference changed");
}
function report(cause: unknown) {
  console.warn("Panel preference failed", cause instanceof Error ? "Error" : "non-error");
}
type Session = { appId: string; db: Database | undefined; active: boolean; dirty: boolean; open: boolean; saving: boolean; pending: boolean | null };
export function usePanelChoice(appId: string, initialOpen: boolean) {
  const db = window.MatrixOS?.db;
  const [state, setState] = useState({ open: initialOpen, error: false });
  const session = useRef<Session | null>(null);
  useEffect(() => {
    const current: Session = { appId, db, active: true, dirty: false, open: initialOpen, saving: false, pending: null };
    session.current = current;
    setState({ open: initialOpen, error: false });
    if (db?.findOne) void (async () => db.findOne!("records", preferenceId))().then(row => {
      const saved = payload(row);
      if (current.active && !current.dirty && saved) {
        current.open = saved.controlsOpen as boolean;
        setState({ open: current.open, error: false });
      }
    }).catch(cause => {
      if (current.active && !current.dirty) { report(cause); setState(old => ({ ...old, error: true })); }
    });
    return () => { current.active = false; };
    // Filter edits do not override an explicit open/closed panel choice.
  }, [appId, db]);
  async function flush(current: Session) {
    if (current.saving) return;
    current.saving = true;
    try {
      // Coalesce to one pending boolean while one bounded host request runs.
      while (current.pending !== null) {
        const next = current.pending; current.pending = null;
        try {
          await save(current.db, next);
          if (current.active) setState(old => ({ ...old, error: false }));
        } catch (cause) {
          report(cause); current.pending = null;
          if (current.active) setState(old => ({ ...old, error: true }));
          break;
        }
      }
    } finally { current.saving = false; }
  }
  function choose(open: boolean, retry = false) {
    const current = session.current;
    if (!current?.active || current.appId !== appId || current.db !== db || (!retry && current.open === open)) return;
    current.dirty = true; current.open = open; current.pending = open;
    setState({ open, error: false }); void flush(current);
  }
  return { ...state, choose, retry: () => choose(state.open, true) };
}
