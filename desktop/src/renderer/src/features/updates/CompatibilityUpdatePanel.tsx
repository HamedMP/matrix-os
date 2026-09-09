import { AlertCircle } from "../../lib/hugeicons";
import { Button } from "../../design/primitives";
import type { ComponentVersion } from "../../lib/compatibility-repair";
import type { useCompatibilityRepair } from "../../lib/use-compatibility-repair";

function deviceDescription(platform: string): string {
  if (/^Mac/i.test(platform)) return "Runs on this Mac";
  if (/^Win/i.test(platform)) return "Runs on this Windows PC";
  if (/^Linux/i.test(platform)) return "Runs on this Linux computer";
  return "Runs on this computer";
}

function VersionRow({ name, description, version, loading }: {
  name: string; description: string; version?: ComponentVersion; loading: boolean;
}) {
  const state = version?.state;
  return (
    <tr className="border-t align-top" style={{ borderColor: "var(--border-subtle)" }}>
      <th scope="row" className="w-[32%] px-4 py-3 text-left font-medium">
        {name}<span className="mt-1 block text-xs font-normal" style={{ color: "var(--text-secondary)" }}>{description}</span>
      </th>
      <td className="w-[34%] px-3 py-3">
        <span className="break-all font-mono text-xs">{version?.installed ?? (loading ? "Checking…" : "Unavailable")}</span>
        {version?.running && version.running !== version.installed ? <span className="mt-1 block break-all text-xs" style={{ color: "var(--text-secondary)" }}>Running: {version.running}</span> : null}
      </td>
      <td className="w-[34%] px-3 py-3">
        <span className="break-all font-mono text-xs">{version?.available ?? (loading ? "Checking…" : "Unavailable")}</span>
        {!loading ? <span className="mt-1 block text-xs" style={{ color: state === "update" ? "var(--update-action)" : "var(--text-secondary)" }}>
          {state === "update" ? "Update available" : state === "current" ? "Up to date" : state === "pending" ? "Waiting for services to restart" : state === "preview" ? "Automatic updates require an installed release" : "Check could not be completed"}
        </span> : null}
      </td>
    </tr>
  );
}

export default function CompatibilityUpdatePanel({ repair, close }: {
  repair: ReturnType<typeof useCompatibilityRepair>; close: () => void;
}) {
  const { plan, loading, busy, progress, error, complete } = repair;
  const hasUpdate = Boolean(plan?.targets.length);
  const current = plan?.local.state === "current" && plan.cloud.state === "current" && !plan.compatibilityUpdateRequired;
  const restart = plan?.targets.includes("local");
  const done = complete || (!hasUpdate && current);
  return (
    <>
      <div className="flex items-start gap-4 px-6 pt-6 pb-5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl" style={{ background: "var(--update-action-muted)", color: "var(--update-action)" }}><AlertCircle size={22} /></span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>Update Matrix OS</h2>
          <p className="mt-1 text-sm leading-5" style={{ color: "var(--text-secondary)" }}>
            Your desktop app connects to your cloud computer. We check both and update only what needs updating.
          </p>
        </div>
      </div>
      <div className="px-6 pb-5 text-sm" style={{ color: "var(--text-primary)" }}>
        <div className="overflow-hidden rounded-lg border" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}>
          <table className="w-full table-fixed text-left">
            <thead className="text-xs" style={{ color: "var(--text-secondary)" }}><tr><th className="px-4 py-2 font-normal">Component</th><th className="px-3 py-2 font-normal">Installed</th><th className="px-3 py-2 font-normal">Available</th></tr></thead>
            <tbody>
              <VersionRow name="Desktop app" description={deviceDescription(navigator.platform)} version={plan?.local} loading={loading} />
              <VersionRow name="Cloud computer" description="Hosts your apps, files and AI" version={plan?.cloud} loading={loading} />
            </tbody>
          </table>
        </div>
        <p className="mt-4 leading-5" role={busy ? "status" : undefined}>{progress || (loading ? "Checking installed versions and update channels…" : plan?.reason)}</p>
        {hasUpdate && !busy && !complete ? <p className="mt-2 text-xs leading-5" style={{ color: "var(--text-secondary)" }}>
          {restart ? "The desktop app will restart after downloading. Save your work before updating." : "The cloud connection may briefly restart during the update."}
          {plan?.channel ? ` Cloud update channel: ${plan.channel}.` : ""}
        </p> : null}
        {error ? <p role="alert" className="mt-3 text-sm" style={{ color: "var(--danger)" }}>We couldn't confirm the update completed. Check versions again before retrying.</p> : null}
      </div>
      <div className="flex justify-end gap-2 border-t px-6 py-4" style={{ borderColor: "var(--border-subtle)" }}>
        {!done ? <Button variant="ghost" onClick={close}>{busy ? "Hide" : "Later"}</Button> : null}
        <Button variant="primary" disabled={loading || busy} onClick={() => {
          if (done && !error) close();
          else if (error || !hasUpdate) void repair.check();
          else void repair.update();
        }}>
          {busy ? "Updating…" : loading ? "Checking…" : error ? "Check again" : done ? "Done" : hasUpdate ? (restart ? "Update & restart" : "Update") : "Check again"}
        </Button>
      </div>
    </>
  );
}
