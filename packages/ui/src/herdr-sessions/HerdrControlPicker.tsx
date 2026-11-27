import { useEffect, useState } from "react";
import { HERDR_TERMINAL_WORKSPACE_ID, HerdrSessionIdSchema } from "@matrix-os/contracts/herdr-terminals";
import { desktopLinkWorkspaceId, type DesktopLinkMachine } from "@matrix-os/contracts/desktop-link";
import type { CanonicalChatMessagePart, CanonicalChatResourceReference } from "@matrix-os/contracts";
import { Button } from "../Button.js";
import { Input } from "../Input.js";
import { loadDesktopMachines, loadDesktopTerminals } from "../desktop-link/desktop-link-client.js";
import { loadHerdrSessions, type HerdrSession, type HerdrSessionsRequest } from "./herdr-sessions-client.js";

export const herdrControlCommand = { kind: "command", descriptorId: "herdr-terminal-control", invocation: "/herdr-terminal-control" } as const;

export function herdrControlParts(target: CanonicalChatResourceReference): CanonicalChatMessagePart[] {
  return [{ type: "invocation_reference", invocation: herdrControlCommand }, { type: "resource_reference", resource: target }];
}

const PAGE_SIZE = 5;

function displayName(entry: DesktopLinkMachine, machines: DesktopLinkMachine[], gatewayName: string) {
  if (entry.name !== gatewayName && !machines.some(other => other.deviceId !== entry.deviceId && other.name === entry.name)) return entry.name;
  return `${entry.name} · ${entry.deviceId.slice(0, 8)}`;
}
type PickerProps = {
  request: HerdrSessionsRequest;
  requestedTarget?: string;
  computerName?: string;
  onSelect(target: CanonicalChatResourceReference, address: string): void;
  onCancel(): void;
};

/** Only an explicit choice produces a terminal grant. A name or address in the prompt is a filter. */
export function HerdrControlPicker({ request, onSelect, onCancel, requestedTarget, computerName }: PickerProps) {
  const [catalog, setCatalog] = useState<{ request: HerdrSessionsRequest; machines: DesktopLinkMachine[] } | null>(null);
  const [selected, setSelected] = useState<{ request: HerdrSessionsRequest; deviceId: string } | null>(null);
  const machines = catalog?.request === request ? catalog.machines : [];
  const requestedDesktop = /^(?:desktop:)([0-9a-f]{64})\/(t[0-9]{1,6}[a-z]{0,2})$/.exec(requestedTarget ?? "");
  const requestedDeviceId = requestedDesktop?.[1];
  const deviceId = requestedDeviceId ?? (selected?.request === request ? selected.deviceId : null);
  const machine = machines.find(entry => entry.deviceId === deviceId);
  const gatewayName = computerName || "This computer";
  const selectedName = machine ? displayName(machine, machines, gatewayName) : computerName;
  useEffect(() => {
    if (requestedTarget && !requestedDeviceId) return;
    let current = true;
    void loadDesktopMachines(request).then(result => {
      if (current) setCatalog({ request, machines: result.machines });
    }).catch((error: unknown) => {
      console.warn("[herdr] Desktop list unavailable", error instanceof Error ? error.name : "UnknownError");
      if (current) setCatalog({ request, machines: [] });
    });
    return () => { current = false; };
  }, [request, requestedTarget, requestedDeviceId]);
  return <section aria-label="Choose a Herdr terminal" className="space-y-2 rounded-lg border p-3 text-sm">
    <p>Choose the terminal this message can read, type into, and interrupt.</p>
    {!requestedTarget && machines.length > 0 && <div role="group" aria-label="Computers" className="flex flex-wrap gap-1">
      <Button type="button" size="sm" variant="secondary" aria-pressed={!deviceId}
        onClick={() => setSelected(null)}>{gatewayName}</Button>
      {machines.map(entry => <Button type="button" size="sm" variant="secondary" key={entry.deviceId}
        aria-pressed={deviceId === entry.deviceId} disabled={entry.state !== "online"}
        onClick={() => setSelected({ request, deviceId: entry.deviceId })}>{displayName(entry, machines, gatewayName)}{entry.state === "offline" ? " (offline)" : ""}</Button>)}
    </div>}
    {deviceId && catalog?.request !== request ? <p role="status">Finding computer…</p> : deviceId && machine?.state !== "online" ? <p role="status">Computer unavailable.</p> :
      <TerminalChoices key={JSON.stringify([deviceId, machine?.revision, requestedTarget])} request={request} requestedTarget={requestedDesktop?.[2] ?? requestedTarget}
        computerName={selectedName} deviceId={deviceId} onSelect={onSelect} />}
    <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
  </section>;
}

function TerminalChoices({ request, requestedTarget, computerName, deviceId, onSelect }: Omit<PickerProps, "onCancel"> & { deviceId: string | null }) {
  const [inventory, setInventory] = useState<{ request: HerdrSessionsRequest; sessions: HerdrSession[] } | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const sessions = inventory?.request === request ? inventory.sessions : null;
  const workspaceId = deviceId ? desktopLinkWorkspaceId(deviceId) : HERDR_TERMINAL_WORKSPACE_ID;
  useEffect(() => {
    let current = true;
    const load = async () => {
      if (deviceId) {
        const list = await loadDesktopTerminals(request, deviceId, "chat-control");
        return list.sessions;
      }
      const list = await loadHerdrSessions((path, init) => request(`${path}?view=chat-control`, init));
      return list.available ? list.sessions : [];
    };
    const refresh = () => void load().then(rows => {
      if (current) setInventory({ request, sessions: rows.filter(row => row.revision) });
    }).catch((error: unknown) => {
      console.warn("[herdr] Chat terminal list unavailable", error instanceof Error ? error.name : "UnknownError");
      if (current) setInventory({ request, sessions: [] });
    });
    const timer = requestedTarget ? setTimeout(refresh, 180) : undefined;
    if (!requestedTarget) refresh();
    return () => { current = false; clearTimeout(timer); };
  }, [request, requestedTarget, workspaceId, deviceId]);
  if (!sessions) return <p role="status">Loading terminals…</p>;
  const byId = requestedTarget && HerdrSessionIdSchema.safeParse(requestedTarget).success;
  const search = (requestedTarget ?? query).trim().toLowerCase();
  const matches = sessions.filter(row => requestedTarget
    ? (byId ? row.id === requestedTarget : row.title.toLowerCase() === search)
    : row.title.toLowerCase().includes(search) || row.id.includes(search));
  const start = page * PAGE_SIZE;
  const addressLabel = deviceId ? computerName : "gateway";
  return <>
    {!requestedTarget && <Input aria-label="Find terminal" placeholder="Find a terminal by name or ID" value={query} onChange={event => {
      setQuery(event.target.value); setPage(0);
    }} />}
    {!matches.length || (byId && matches.length !== 1) ? <p role="status">{requestedTarget
      ? `${addressLabel}/${requestedTarget} is unavailable. Ask Chat to list terminals again.` : "No matching terminals."}</p> :
      <div className="flex flex-wrap gap-1">{matches.slice(start, start + PAGE_SIZE).map(row => <Button key={row.tabId}
        type="button" variant="secondary" size="sm" onClick={() => onSelect({
          kind: "terminal_session", id: `${workspaceId}:${row.tabId}`, label: row.title, revision: row.revision,
        }, `${computerName || "gateway"}/${row.id}`)}>{requestedTarget ? `Use ${row.title} (${addressLabel}/${row.id})` : `${row.title} (${row.id})`}</Button>)}</div>}
    {matches.length > PAGE_SIZE && <div className="flex items-center gap-2">
      <Button type="button" variant="ghost" size="sm" disabled={!page} onClick={() => setPage(page - 1)}>Previous</Button>
      <span>{start + 1}–{Math.min(start + PAGE_SIZE, matches.length)} of {matches.length}</span>
      <Button type="button" variant="ghost" size="sm" disabled={start + PAGE_SIZE >= matches.length} onClick={() => setPage(page + 1)}>Next</Button>
    </div>}
  </>;
}
