import { useEffect, useRef, useState, type ReactNode } from "react";
import { RecordConflictError } from "../persistence";
import type { OwnerRecord } from "../types";
import type { ViewProps } from "../views/common";

export function localDate(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
export function plusDays(date: string, days: number) { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
export function Intro({ title, detail, action, children }: { title: string; detail: string; action?: ReactNode; children?: ReactNode }) {
  return <header className="nw-intro"><div><h2>{title}</h2><p>{detail}</p></div>{action}{children}</header>;
}
export function RecordActions({ record, onEdit, onEvidence }: Pick<ViewProps, "onEdit" | "onEvidence"> & { record: OwnerRecord }) {
  const name = String(record.fields.title ?? "record");
  return <div className="record-actions"><button aria-label={`Edit ${name}`} onClick={() => onEdit(record)}>Edit</button><button aria-label={`Sources for ${name}`} onClick={() => onEvidence(record)}>{record.sources.length ? `${record.sources.length} sources` : "Your entry"}</button></div>;
}
export function useSavedAction(onSave: ViewProps["onSave"]) {
  const guard = useRef(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save(record: OwnerRecord) {
    if (guard.current) return false;
    guard.current = true; setBusy(true); setError("");
    try { await onSave(record); return true; }
    catch (cause) { console.warn("Workflow save failed", cause instanceof Error ? cause.name : "UnknownError"); setError(cause instanceof RecordConflictError ? cause.message : "Save failed. Your changes are still here; review and try again."); return false; }
    finally { guard.current = false; setBusy(false); }
  }
  return { save, busy, error, setError };
}
export function SaveError({ error }: { error: string }) { return error ? <p className="notice error" role="alert">{error}</p> : null; }
export function useOwnerRequest() {
  const [notice, setNotice] = useState(""), [error, setError] = useState("");
  function request(context: string) {
    setError("");
    try {
      if (!window.MatrixOS?.generate) { setError("Open this app in Matrix to request a reflection. Your local records are still available."); return; }
      window.MatrixOS.generate(context); setNotice("Your source-grounded reflection was requested in Matrix. Review the result there before saving it.");
    } catch (cause) { console.warn("Owner synthesis request failed", cause instanceof Error ? cause.name : "UnknownError"); setError("The request could not be opened. Your selected records are unchanged."); }
  }
  return { request, notice, error };
}
export function EmptyHint({ children }: { children: ReactNode }) { return <div className="nw-empty">{children}</div>; }
export function MiniTrend({ values, label }: { values: Array<{ label: string; value: number }>; label: string }) {
  const maximum = Math.max(1, ...values.map(item => item.value));
  return <div className="nw-trend" role="img" aria-label={`${label}: ${values.map(item => `${item.label}: ${item.value.toFixed(1)}`).join(", ")}`}>
    {values.slice(-12).map((item, index) => <div key={`${item.label}-${index}`}><span className="nw-trend-value">{item.value.toFixed(0)}</span><span className="nw-trend-bar" style={{ height: `${Math.max(3, item.value / maximum * 100)}px` }} /><small>{item.label.slice(5)}</small></div>)}
  </div>;
}

export function useCreationScope(defaultScope: "personal" | "work" = "personal") {
 const [scope, setScope] = useState(defaultScope);
 useEffect(() => setScope(defaultScope), [defaultScope]);
 return { scope, setScope };
}
export function CreationGroup({ scope, setScope, disabled }: { scope: "personal" | "work"; setScope: (scope: "personal" | "work") => void; disabled: boolean }) {
 return <label>Save new records in<select value={scope} disabled={disabled} onChange={event => setScope(event.target.value === "work" ? "work" : "personal")}><option value="personal">Personal</option><option value="work">Work</option></select></label>;
}
