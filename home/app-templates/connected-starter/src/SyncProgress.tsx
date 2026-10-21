import { gallerySyncIntervalMs, type GallerySyncSnapshot } from "./generated-sync";

const errors = {
  connection_changed: "An account connection changed. Select your accounts again to continue.",
  import_incomplete: "The import did not finish. You can retry or review the selected accounts.",
  unavailable: "The import stopped. Your saved records are safe. Try again.",
  interrupted: "The import was interrupted. Your saved records are safe. Retry when you’re ready.",
};
const sourceLabels = { pending: "Waiting", running: "Reading & organizing…", complete: "Processed", partial: "Incomplete coverage", failed: "Needs attention" };
const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const when = (value: string) => formatter.format(new Date(value));
const isActive = (s: GallerySyncSnapshot | null) => s?.status === "running" || s?.status === "queued";
function progressTitle(snapshot: GallerySyncSnapshot | null, error: string, name: string) {
  if (!snapshot || error) return "Sync status unavailable";
  if (snapshot.status === "queued") return "Your import is ready to start";
  if (snapshot.status === "running") return snapshot.stage === "verifying" ? "Checking saved records" : `Importing your ${name.toLowerCase()}`;
  return { complete: "Your records are up to date", partial: "Some records need another look", paused: "Automatic updates paused", failed: "Import needs attention" }[snapshot.status];
}
function updateLabel(snapshot: GallerySyncSnapshot | null) {
  if (!snapshot?.keepUpdated) return null;
  return snapshot.status === "failed" || snapshot.status === "partial" ? "Updates need attention" : "Automatic updates on";
}
function SourceProgress({ snapshot, active }: { snapshot: GallerySyncSnapshot; active: boolean }) {
  const completed = snapshot.sources.filter(s => s.status === "complete" || s.status === "partial").length;
  const total = Math.max(1, snapshot.sources.length);
  const description = `${completed} of ${snapshot.sources.length} accounts processed${snapshot.stage === "verifying" ? ", checking saved records" : ""}`;
  return <>
    <div className={`sync-meter${active ? " is-active" : ""}`} role="progressbar" aria-label="Accounts processed" aria-valuemin={0} aria-valuemax={total} aria-valuenow={completed} aria-valuetext={description}>
      <span style={{ width: `${completed / total * 100}%` }} />
    </div>
    <ol className="sync-sources">{snapshot.sources.map(source => <li key={`${source.service}:${source.label}`}>
      <span className={`source-dot ${source.status}`} aria-hidden="true" />
      <span>{source.email || source.label}<small>{source.service.replaceAll("_", " ")}</small></span>
      <span className="source-status">{sourceLabels[source.status]}</span>
    </li>)}</ol>
  </>;
}
function SyncResults({ snapshot, active }: { snapshot: GallerySyncSnapshot; active: boolean }) {
  const stoppedWithoutCounts = ["failed", "paused"].includes(snapshot.status) && snapshot.added + snapshot.updated === 0;
  return <>
    {active ? <p className="sync-note">{snapshot.steps} processing steps finished. You can keep using this app. Records appear as they are saved.</p>
      : stoppedWithoutCounts ? <p className="sync-note">Saved records are available below.</p>
      : <p className="sync-results">{snapshot.added} new · {snapshot.updated} updated{snapshot.skipped > 0 && ` · ${snapshot.skipped} skipped`}</p>}
    {snapshot.status === "partial" && <p className="sync-note">Some sources could not be fully processed. Review or retry to finish; automatic checks are waiting.</p>}
    {snapshot.error && <p className="sync-error">{errors[snapshot.error]}</p>}
    <div className="sync-timing">
      {snapshot.lastCheckedAt && <span>Last checked {when(snapshot.lastCheckedAt)}</span>}
      {snapshot.nextCheckAt && <span>Checks every {gallerySyncIntervalMs(snapshot.sources) === 60_000 ? "minute" : "15 minutes"} · next {when(snapshot.nextCheckAt)}</span>}
    </div>
  </>;
}
interface Props {
  name: string; snapshot: GallerySyncSnapshot | null; error?: string; busy?: boolean;
  onAction?: (action: "pause" | "retry" | "resume") => void;
  onConfigure?: () => void; onRefresh?: () => void;
}
function buttons({ snapshot, error, onAction, onConfigure, onRefresh }: Props) {
  const actions: { text: string; click: () => void }[] = [];
  if (error && onRefresh) actions.push({ text: "Retry status", click: onRefresh });
  const active = isActive(snapshot);
  if (snapshot && !active && onAction) actions.push({ text: snapshot.status === "paused" ? "Resume updates" : snapshot.status === "complete" ? "Sync now" : "Retry import", click: () => onAction(snapshot.status === "paused" ? "resume" : "retry") });
  if (snapshot && (active || snapshot.keepUpdated) && onAction) actions.push({ text: active ? "Stop import & pause" : "Pause updates", click: () => onAction("pause") });
  if (!active && onConfigure) actions.push({ text: "Manage accounts", click: onConfigure });
  return actions;
}
export default function SyncProgress(props: Props) {
  const { name, snapshot, error = "", busy = false } = props;
  if (!snapshot && !error) return null;
  const active = isActive(snapshot) && !error;
  return <section className={`sync-panel${active ? " is-syncing" : ""}`} aria-label="Import and automatic updates">
    <div className="sync-heading"><span className="sync-symbol" aria-hidden="true">↻</span>
      <div><span className="sync-eyebrow">CONNECTED ACCOUNTS</span><h2 aria-live="polite">{progressTitle(snapshot, error, name)}</h2></div>
      {updateLabel(snapshot) && !error && <span className="sync-pill">{updateLabel(snapshot)}</span>}
    </div>
    {snapshot && <><SourceProgress snapshot={snapshot} active={active} /><SyncResults snapshot={snapshot} active={isActive(snapshot)} /></>}
    {error && <p role="alert" className="sync-error">{error}</p>}
    <div className="sync-actions">{buttons(props).map(button => <button key={button.text} disabled={busy} onClick={button.click}>{button.text}</button>)}</div>
  </section>;
}
