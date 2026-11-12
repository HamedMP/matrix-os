import type { CollaborativeAppReadiness } from "@matrix-os/contracts";

export function CollaborativeAppReadinessSummary({ readiness, compact }: {
  readiness: CollaborativeAppReadiness;
  compact: boolean;
}) {
  const className = compact ? "text-xs" : "rounded-xl border p-4 text-sm";
  const spacing = compact ? "mt-1" : "mt-2";
  const actions = readiness.checks.flatMap((check) => check.action ? [check.action] : []);
  return <section aria-label="App collaboration readiness" className={className}>
    <h3 className={compact ? "text-[11px] font-medium text-muted-foreground" : "font-medium"}>App collaboration readiness</h3>
    {readiness.status === "checking" ? <p className={spacing}>Checking the exact app build and multi-user path…</p> : null}
    {readiness.status === "ready" ? <p className={spacing}>This exact app build is ready to share.</p> : null}
    {readiness.status === "stale" ? <p className={spacing}>The app changed. Run readiness again.</p> : null}
    {(readiness.status === "blocked" || readiness.status === "failed") && actions.length > 0
      ? <ul className={`${spacing} space-y-1`}>{actions.map((action) => <li key={action}>{action}</li>)}</ul>
      : null}
  </section>;
}
