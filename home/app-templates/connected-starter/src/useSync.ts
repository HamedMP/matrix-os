import { useCallback, useEffect, useRef, useState } from "react";
import { parseGallerySyncSnapshot, type GallerySyncInput, type GallerySyncSnapshot } from "./generated-sync";

export async function syncRequest(appId: string, action?: "start" | "pause" | "retry" | "resume", input?: GallerySyncInput) {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(appId) || !window.MatrixOS?.gatewayFetch) throw new Error("Sync unavailable");
  const path = `/api/app-gallery/${appId}/sync${action && action !== "start" ? `/${action}` : ""}`;
  const raw = await window.MatrixOS.gatewayFetch(path, action ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input ?? {}) } : undefined);
  const status = parseGallerySyncSnapshot(raw);
  if (status?.appId !== appId && status !== null || action && !status) throw new Error("Sync unavailable");
  return status;
}
export function useSync(appId: string, enabled: boolean, reloadRecords: () => Promise<void>) {
  const [snapshot, setSnapshot] = useState<GallerySyncSnapshot | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const mounted = useRef(false), revision = useRef(0), previous = useRef<string | null>(null), polling = useRef(false);
  const lastRecordRead = useRef(0);
  const accept = useCallback((next: GallerySyncSnapshot | null) => {
    setSnapshot(next); setError("");
    if (next?.status === "running" && next.steps > 0 && Date.now() - lastRecordRead.current >= 5000) {
      lastRecordRead.current = Date.now(); void reloadRecords();
    }
    if (next && !["queued", "running"].includes(next.status)) {
      const marker = `${next.runId}:${next.status}`;
      if (marker !== previous.current) { previous.current = marker; void reloadRecords(); }
    }
  }, [reloadRecords]);
  const refresh = useCallback(async () => {
    if (!enabled || polling.current) return;
    polling.current = true; const ticket = revision.current;
    try { const next = await syncRequest(appId); if (mounted.current && ticket === revision.current) accept(next); }
    catch (cause) { console.warn("Sync status unavailable", cause); if (mounted.current && ticket === revision.current) setError("Live status is unavailable. Your saved records are still here. Try again."); }
    finally { polling.current = false; }
  }, [appId, enabled, accept]);
  useEffect(() => {
    mounted.current = true; previous.current = null; setSnapshot(null);
    void refresh();
    // Poll the durable status, not the inbox. The computer owns scheduled source checks.
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 2500);
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", focus);
    return () => { mounted.current = false; revision.current++; clearInterval(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus); };
  }, [refresh]);
  const action = useCallback(async (name: "start" | "pause" | "retry" | "resume", input?: GallerySyncInput) => {
    const ticket = ++revision.current; setBusy(true);
    try { const next = await syncRequest(appId, name, input); if (mounted.current && ticket === revision.current) { revision.current++; accept(next); } return next!; }
    catch (cause) { console.warn("Sync action unavailable", cause); if (mounted.current && ticket === revision.current) setError("Sync could not be updated. Try again or review your connected accounts."); throw new Error("Sync could not be updated. Try again or review your connected accounts."); }
    finally { setBusy(false); }
  }, [appId, accept]);
  return { snapshot, error, busy, refresh, action };
}
