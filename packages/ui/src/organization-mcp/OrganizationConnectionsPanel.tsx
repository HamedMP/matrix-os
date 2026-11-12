"use client";

import { OrgMcpServerDefIdSchema, type OrgMcpMember, type OrgMcpServerDefinition, type OrgMcpServerMode } from "@matrix-os/contracts";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "../Badge.js";
import { Button } from "../Button.js";
import { Input } from "../Input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../Select.js";
import {
  ORG_MCP_LOAD_ERROR,
  ORG_MCP_SAVE_ERROR,
  ORG_MCP_USAGE_WINDOW_DAYS,
  ORG_MCP_VISIBILITY_NOTICE,
  callsByConnectionHost,
  loadOrganizationMcpSnapshot,
  serverModeFor,
  type OrganizationMcpAdminClient,
  type OrganizationMcpSnapshot,
} from "./client.js";

export type WithOrganizationMcpClient = <T>(action: (client: OrganizationMcpAdminClient) => Promise<T>) => Promise<T>;
type Mutate = (action: (client: OrganizationMcpAdminClient) => Promise<void>) => Promise<boolean>;

const muted = { color: "var(--text-tertiary, var(--muted-foreground))" };
const panel = "rounded-xl border border-border/60 p-4";
const MODE_LABELS: Record<OrgMcpServerMode, string> = { allow: "Allowed", recommend: "Recommended", block: "Blocked" };
const MODE_BADGES = { allow: "default", recommend: "success", block: "error" } as const;
const STATUS_LABELS: Record<string, string> = {
  ready: "Connected", pending: "Connecting", auth_required: "Needs sign-in", degraded: "Degraded",
  disabled: "Turned off", action_required: "Needs attention",
};
const USAGE_PREVIEW_ROWS = 25;

function lastUsedLabel(value: string | null): string {
  if (!value) return "Not used in org context";
  const days = Math.floor((Date.now() - Date.parse(value)) / 86_400_000);
  if (days <= 0) return "Used today";
  return days === 1 ? "Used yesterday" : `Used ${days} days ago`;
}

function ModeSelect({ value, onChange, label, disabled }: { value: OrgMcpServerMode; onChange: (mode: OrgMcpServerMode) => void; label: string; disabled?: boolean }) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as OrgMcpServerMode)} disabled={disabled}>
      <SelectTrigger size="sm" aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="allow">Allow</SelectItem>
        <SelectItem value="recommend">Recommend</SelectItem>
        <SelectItem value="block">Block</SelectItem>
      </SelectContent>
    </Select>
  );
}

/** Shown to every member: what their admins can and cannot see. */
export function OrganizationMcpVisibilityNotice() {
  return <p role="note" className="rounded-lg border border-border/60 px-3 py-2 text-xs" style={muted}>{ORG_MCP_VISIBILITY_NOTICE}</p>;
}

function ServerPolicyCard({ servers, busy, mutate }: { servers: readonly OrgMcpServerDefinition[]; busy: boolean; mutate: Mutate }) {
  const [draftId, setDraftId] = useState("");
  const [draftMode, setDraftMode] = useState<OrgMcpServerMode>("recommend");
  const [draftInvalid, setDraftInvalid] = useState(false);
  const addServer = async () => {
    const parsed = OrgMcpServerDefIdSchema.safeParse(draftId.trim().toLowerCase());
    setDraftInvalid(!parsed.success);
    if (!parsed.success) return;
    if (await mutate(client => client.setServerMode(parsed.data, draftMode))) setDraftId("");
  };
  return (
    <div className={panel}>
      <h5 className="text-sm font-medium">Server policy</h5>
      <p className="mt-1 text-xs" style={muted}>Blocking a server stops Matrix from calling it for every member in this organization. Members keep their own connections.</p>
      {servers.length > 0 ? <ul className="mt-3 space-y-2" aria-label="Governed servers">
        {servers.map(server => (
          <li key={server.serverDefId} className="flex items-center justify-between gap-2">
            <span className="truncate text-sm">{server.serverDefId}</span>
            <div className="flex items-center gap-2">
              <ModeSelect value={server.mode} label={`Policy for ${server.serverDefId}`} disabled={busy}
                onChange={(mode) => { void mutate(client => client.setServerMode(server.serverDefId, mode)); }} />
              <Button size="sm" variant="ghost" disabled={busy} aria-label={`Remove policy for ${server.serverDefId}`}
                onClick={() => { void mutate(client => client.clearServer(server.serverDefId)); }}>Remove</Button>
            </div>
          </li>
        ))}
      </ul> : null}
      <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void addServer(); }}>
        <div className="min-w-[200px] flex-1">
          <Input aria-label="Server to govern" placeholder="linear or mcp.linear.app" value={draftId} maxLength={253}
            onChange={(event) => { setDraftId(event.target.value); setDraftInvalid(false); }}
            error={draftInvalid ? "Enter a catalog id like linear or a hostname like mcp.linear.app." : undefined} />
        </div>
        <ModeSelect value={draftMode} onChange={setDraftMode} label="Policy for new server" disabled={busy} />
        <Button size="sm" type="submit" disabled={busy || draftId.trim() === ""}>Add policy</Button>
      </form>
    </div>
  );
}

function MemberCard({ member, snapshot, busy, mutate }: { member: OrgMcpMember; snapshot: OrganizationMcpSnapshot; busy: boolean; mutate: Mutate }) {
  const calls = useMemo(() => callsByConnectionHost(snapshot.usage, member.actorId), [snapshot.usage, member.actorId]);
  const blockedIds = useMemo(() => new Set(member.blockedServerDefIds), [member.blockedServerDefIds]);
  return (
    <li className={panel}>
      <p className="truncate text-sm font-medium">{member.displayName}</p>
      <p className="truncate text-xs" style={muted}>{member.emailAddress ?? member.actorId}</p>
      <ul className="mt-3 space-y-2" aria-label={`Connections for ${member.displayName}`}>
        {member.connections.map(connection => {
          const hostId = connection.serverDefIds[0];
          const blocked = connection.serverDefIds.some(id => blockedIds.has(id));
          const mode = serverModeFor(snapshot.servers, connection.serverDefIds);
          const toggle = () => {
            if (!hostId) return;
            void mutate(client => blocked ? client.unblockMember(member.actorId, hostId) : client.blockMember(member.actorId, hostId));
          };
          return (
            <li key={connection.connectionId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm">{connection.name} <span style={muted}>· {connection.host}</span></p>
                <p className="text-xs" style={muted}>
                  {STATUS_LABELS[connection.status] ?? "Unknown"} · {lastUsedLabel(connection.lastUsedAt)} · {calls.get(connection.host) ?? 0} calls in {ORG_MCP_USAGE_WINDOW_DAYS} days
                </p>
              </div>
              <div className="flex items-center gap-2">
                {mode ? <Badge variant={MODE_BADGES[mode]}>{MODE_LABELS[mode]}</Badge> : null}
                {blocked ? <Badge variant="warning">Blocked for member</Badge> : null}
                {hostId ? <Button size="sm" variant="secondary" disabled={busy} onClick={toggle}
                  aria-label={`${blocked ? "Unblock" : "Block"} ${connection.host} for ${member.displayName}`}>{blocked ? "Unblock" : "Block for member"}</Button> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

function UsageCard({ snapshot }: { snapshot: OrganizationMcpSnapshot }) {
  const [showAll, setShowAll] = useState(false);
  const names = useMemo(() => new Map(snapshot.members.map(member => [member.actorId, member.displayName])), [snapshot.members]);
  const rows = showAll ? snapshot.usage : snapshot.usage.slice(0, USAGE_PREVIEW_ROWS);
  if (snapshot.usage.length === 0) {
    return <div className={panel}><h5 className="text-sm font-medium">Calls by day</h5>
      <p className="mt-1 text-xs" style={muted}>No Matrix Core calls in this organization in the last {ORG_MCP_USAGE_WINDOW_DAYS} days.</p></div>;
  }
  return (
    <div className={panel}>
      <h5 className="text-sm font-medium">Calls by day</h5>
      <table className="mt-2 w-full text-left text-xs">
        <thead style={muted}><tr><th className="py-1 font-normal">Day</th><th className="font-normal">Member</th><th className="font-normal">Server</th><th className="font-normal">Tool</th><th className="text-right font-normal">Calls</th></tr></thead>
        <tbody>{rows.map(row => (
          <tr key={`${row.day}:${row.actorId}:${row.serverKey}:${row.toolName}`} className="border-t border-border/40">
            <td className="py-1">{row.day}</td><td className="truncate">{names.get(row.actorId) ?? row.actorId}</td>
            <td className="truncate">{row.serverKey}</td><td className="truncate">{row.toolName}</td>
            <td className="text-right">{row.calls}{row.failures > 0 ? ` (${row.failures} failed)` : ""}</td>
          </tr>
        ))}</tbody>
      </table>
      {snapshot.usage.length > USAGE_PREVIEW_ROWS
        ? <Button className="mt-2" size="sm" variant="ghost" onClick={() => setShowAll(value => !value)}>{showAll ? "Show less" : `Show all ${snapshot.usage.length} rows`}</Button> : null}
      {snapshot.usageTruncated ? <p className="mt-1 text-xs" style={muted}>Only the most recent rows are shown.</p> : null}
    </div>
  );
}

function LoadFailure({ onRetry }: { onRetry?: () => void }) {
  return (
    <section aria-label="Connections">
      <h4 className="text-sm font-medium">Connections</h4>
      <div role="alert" className={`${panel} mt-2 text-sm`}>{ORG_MCP_LOAD_ERROR}
        {onRetry ? <div className="mt-2"><Button size="sm" variant="secondary" onClick={onRetry}>Try again</Button></div> : null}
      </div>
    </section>
  );
}

type LoadResult = { key: number; state: "loaded"; snapshot: OrganizationMcpSnapshot } | { key: number; state: "failed" };

/** Organization → Connections: member connection metadata, call counts, and server governance. */
export function OrganizationConnectionsPanel({ organizationName, withClient }: { organizationName: string; withClient: WithOrganizationMcpClient | null }) {
  const [result, setResult] = useState<LoadResult | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const refresh = () => setRefreshKey(key => key + 1);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- the selected organization and explicit refreshes are the read boundary; stale responses are discarded.
  useEffect(() => {
    if (!withClient) return;
    let active = true;
    withClient(client => loadOrganizationMcpSnapshot(client)).then((snapshot) => {
      if (active) setResult({ key: refreshKey, state: "loaded", snapshot });
    }).catch((error: unknown) => {
      console.warn("[org-mcp] connections unavailable", error instanceof Error ? error.name : "UnknownError");
      if (active) setResult({ key: refreshKey, state: "failed" });
    });
    return () => { active = false; };
  }, [refreshKey, withClient]);

  if (!withClient) return <LoadFailure />;
  if (result?.state === "failed") return <LoadFailure onRetry={refresh} />;
  if (!result || result.key !== refreshKey) return <p role="status" className="text-sm" style={muted}>Loading connections…</p>;

  // Mutations clear nothing locally; the view reloads only after the server confirms.
  const mutate: Mutate = async (action) => {
    setBusy(true);
    setSaveError(null);
    try {
      await withClient(action);
      refresh();
      return true;
    } catch (error: unknown) {
      console.warn("[org-mcp] update failed", error instanceof Error ? error.name : "UnknownError");
      setSaveError(ORG_MCP_SAVE_ERROR);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const { snapshot } = result;
  const connected = snapshot.members.filter(member => member.connections.length > 0);

  return (
    <section aria-label="Connections" className="space-y-4">
      <div>
        <h4 className="text-sm font-medium">Connections</h4>
        <p className="mt-1 text-xs" style={muted}>MCP servers that members of {organizationName} connected, with Matrix call counts for the last {ORG_MCP_USAGE_WINDOW_DAYS} days. Credentials and call contents are never shown.</p>
      </div>
      {saveError ? <div role="alert" className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--danger, var(--destructive))", color: "var(--danger, var(--destructive))" }}>{saveError}</div> : null}
      <ServerPolicyCard servers={snapshot.servers} busy={busy} mutate={mutate} />
      {connected.length === 0
        ? <div role="status" className="rounded-lg border border-dashed border-border/60 p-6 text-center">
          <p className="text-sm font-medium">No member connections yet</p>
          <p className="mt-1 text-sm" style={muted}>When members connect MCP servers in Settings → Integrations, they appear here with their status and call counts.</p>
          <div className="mt-3"><Button size="sm" variant="secondary" onClick={refresh}>Refresh</Button></div>
        </div>
        : <ul className="space-y-3" aria-label="Member connections">
          {connected.map(member => <MemberCard key={member.actorId} member={member} snapshot={snapshot} busy={busy} mutate={mutate} />)}
        </ul>}
      {snapshot.membersTruncated ? <p className="text-xs" style={muted}>Showing the first members only.</p> : null}
      <UsageCard snapshot={snapshot} />
    </section>
  );
}

/** The Organization section slot: admins get the notice plus the panel, members get the notice only. */
export function OrganizationMcpSettings({ admin, organizationName, withClient }: { admin: boolean; organizationName: string; withClient: WithOrganizationMcpClient | null }) {
  if (!admin) return <OrganizationMcpVisibilityNotice />;
  return <div className="space-y-3"><OrganizationMcpVisibilityNotice /><OrganizationConnectionsPanel organizationName={organizationName} withClient={withClient} /></div>;
}
