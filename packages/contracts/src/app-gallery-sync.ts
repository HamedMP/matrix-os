/** Portable, dependency-free wire contract shared with installed Gallery apps. */
export interface GalleryImportAccount {
  service: string;
  label: string;
  connectionId: string;
  expectedEmail: string | null;
}
export interface GalleryImportSelection {
  accounts: GalleryImportAccount[];
  start: string;
  end: string;
  context: string;
  scope?: "personal" | "work";
}
export interface GallerySyncInput extends GalleryImportSelection {
  requestId: string;
  keepUpdated: boolean;
}
export function gallerySyncIntervalMs(accounts: readonly { service: string }[]): number {
  return accounts.length && accounts.every(a => a.service === "gmail") ? 60_000 : 15 * 60_000;
}
export interface GallerySyncSnapshot {
  appId: string;
  runId: string;
  status: "queued" | "running" | "complete" | "partial" | "failed" | "paused";
  stage: "queued" | "reading" | "verifying" | "finished";
  sources: { service: string; label: string; email: string | null; status: "pending" | "running" | "complete" | "partial" | "failed" }[];
  steps: number;
  added: number;
  updated: number;
  skipped: number;
  keepUpdated: boolean;
  startedAt: string | null;
  updatedAt: string;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  error: "connection_changed" | "import_incomplete" | "unavailable" | "interrupted" | null;
}
/** Validate replies before rendering progress; an HTTP error is never an idle state. */
export function parseGallerySyncSnapshot(raw: unknown): GallerySyncSnapshot | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Sync status unavailable");
  const s = raw as GallerySyncSnapshot;
  const time = (value: unknown) => value === null || (typeof value === "string" && value.length < 40 && Number.isFinite(Date.parse(value)));
  if (typeof s.appId !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(s.appId)
    || typeof s.runId !== "string" || !/^[0-9a-f-]{36}$/.test(s.runId)
    || !["queued", "running", "complete", "partial", "failed", "paused"].includes(s.status)
    || !["queued", "reading", "verifying", "finished"].includes(s.stage)
    || !Array.isArray(s.sources) || s.sources.length > 16 || !s.sources.every(source => source && typeof source.service === "string" && source.service.length <= 64
      && typeof source.label === "string" && source.label.length <= 160 && (source.email === null || typeof source.email === "string" && source.email.length <= 320)
      && ["pending", "running", "complete", "partial", "failed"].includes(source.status))
    || ![s.steps, s.added, s.updated, s.skipped].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000)
    || typeof s.keepUpdated !== "boolean" || ![s.startedAt, s.updatedAt, s.lastCheckedAt, s.nextCheckAt].every(time)
    || ![null, "connection_changed", "import_incomplete", "unavailable", "interrupted"].includes(s.error)) throw new Error("Sync status unavailable");
  return s;
}
