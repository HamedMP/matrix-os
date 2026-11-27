import { useEffect, useState } from "react";
import { HERDR_TERMINAL_WORKSPACE_ID, HerdrSessionIdSchema, TERMINAL_CONTROL_COMMAND } from "@matrix-os/contracts/herdr-terminals";
import { desktopLinkWorkspaceId, type DesktopLinkMachine } from "@matrix-os/contracts/desktop-link";
import type { CanonicalChatMessagePart, CanonicalChatResourceReference } from "@matrix-os/contracts";
import { Button } from "../Button.js";
import { Input } from "../Input.js";
import { loadDesktopMachines, loadDesktopTerminals } from "../desktop-link/desktop-link-client.js";
import { loadHerdrSessions, type HerdrSession, type HerdrSessionsRequest } from "./herdr-sessions-client.js";

export function herdrControlParts(target: CanonicalChatResourceReference): CanonicalChatMessagePart[] {
  return [{ type: "invocation_reference", invocation: TERMINAL_CONTROL_COMMAND }, { type: "resource_reference", resource: target }];
}

const PAGE_SIZE = 5;

function desktopDisplayName(entry: DesktopLinkMachine, machines: DesktopLinkMachine[], gatewayName: string, directMachines: string[]) {
  const ambiguousDesktop = entry.name === gatewayName || machines.some(other => other.deviceId !== entry.deviceId && other.name === entry.name);
  const name = ambiguousDesktop ? `${entry.name} · ${entry.deviceId.slice(0, 8)}` : entry.name;
  return directMachines.includes(entry.name) ? `${name} · Paired desktop` : name;
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
  const [selected, setSelected] = useState<{ request: HerdrSessionsRequest; deviceId?: string; machine?: string } | null>(null);
  const [gateway, setGateway] = useState<{ request: HerdrSessionsRequest; sessions: HerdrSession[] } | null>(null);
  const machines = catalog?.request === request ? catalog.machines : [];
  const requestedDesktop = /^(?:desktop:)([0-9a-f]{64})\/(t[0-9]{1,6}[a-z]{0,2})$/.exec(requestedTarget ?? "");
  const requestedMachine = /^(?:machine:|herdr:)([a-z0-9][a-z0-9._-]{0,31})\/(t[0-9]{1,6}[a-z]{0,2})$/.exec(requestedTarget ?? "");
  const requestedDeviceId = requestedDesktop?.[1];
  const currentSelection = selected?.request === request ? selected : null;
  const deviceId = requestedDeviceId ?? currentSelection?.deviceId ?? null;
  const remoteMachine = requestedMachine?.[1] ?? currentSelection?.machine;
  const gatewaySessions = gateway?.request === request ? gateway.sessions : null;
  const directMachines = [...new Set(gatewaySessions?.flatMap(session => session.machine ? [session.machine] : []))];
  const machine = machines.find(entry => entry.deviceId === deviceId);
  const gatewayName = computerName || "This computer";
  const selectedName = machine ? desktopDisplayName(machine, machines, gatewayName, directMachines) : computerName;
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
  useEffect(() => {
    if (requestedDeviceId) return;
    let current = true;
    const load = () => void loadHerdrSessions((path, init) => request(`${path}?view=chat-control`, init)).then(list => {
      if (current) setGateway({ request, sessions: list.available ? list.sessions.filter(row => row.revision) : [] });
    }).catch((error: unknown) => {
      console.warn("[terminal-control] Gateway list unavailable", error instanceof Error ? error.name : "UnknownError");
      if (current) setGateway({ request, sessions: [] });
    });
    const timer = requestedTarget ? setTimeout(load, 180) : undefined;
    if (!requestedTarget) load();
    return () => { current = false; clearTimeout(timer); };
  }, [request, requestedTarget, requestedDeviceId]);
  return <section aria-label="Choose a terminal" className="space-y-2 rounded-lg border p-3 text-sm">
    <p>Choose the terminal this message can read, type into, and interrupt.</p>
    {!requestedTarget && (machines.length > 0 || directMachines.length > 0) && <div role="group" aria-label="Computers" className="flex flex-wrap gap-1">
      <Button type="button" size="sm" variant="secondary" aria-pressed={!deviceId && !remoteMachine}
        onClick={() => setSelected(null)}>{gatewayName}</Button>
      {directMachines.map(name => <Button key={name} type="button" size="sm" variant="secondary"
        aria-pressed={remoteMachine === name} onClick={() => setSelected({ request, machine: name })}>{
          name === gatewayName || machines.some(entry => entry.name === name) ? `${name} · Direct connection` : name
        }</Button>)}
      {machines.map(entry => <Button type="button" size="sm" variant="secondary" key={entry.deviceId}
        aria-pressed={deviceId === entry.deviceId} disabled={entry.state !== "online"}
        onClick={() => setSelected({ request, deviceId: entry.deviceId })}>{desktopDisplayName(entry, machines, gatewayName, directMachines)}{entry.state === "offline" ? " (offline)" : ""}</Button>)}
    </div>}
    {deviceId && catalog?.request !== request ? <p role="status">Finding computer…</p> : deviceId && machine?.state !== "online" ? <p role="status">Computer unavailable.</p> :
      <TerminalChoices key={JSON.stringify([deviceId, machine?.revision, remoteMachine, requestedTarget])} request={request}
        requestedTarget={requestedDesktop?.[2] ?? requestedMachine?.[2] ?? requestedTarget}
        computerName={selectedName} deviceId={deviceId} remoteMachine={remoteMachine} gatewaySessions={gatewaySessions} onSelect={onSelect} />}
    <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
  </section>;
}

function TerminalChoices({ request, requestedTarget, computerName, deviceId, remoteMachine, gatewaySessions, onSelect }:
  Omit<PickerProps, "onCancel"> & { deviceId: string | null; remoteMachine?: string; gatewaySessions: HerdrSession[] | null }) {
  const [inventory, setInventory] = useState<{ request: HerdrSessionsRequest; sessions: HerdrSession[] } | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const sessions = deviceId
    ? (inventory?.request === request ? inventory.sessions : null)
    : gatewaySessions?.filter(row => row.machine === remoteMachine) ?? null;
  const workspaceId = deviceId ? desktopLinkWorkspaceId(deviceId) : HERDR_TERMINAL_WORKSPACE_ID;
  useEffect(() => {
    if (!deviceId) return;
    let current = true;
    const refresh = () => void loadDesktopTerminals(request, deviceId, "chat-control").then(list => {
      if (current) setInventory({ request, sessions: list.sessions.filter(row => row.revision) });
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
  const addressLabel = remoteMachine ?? (deviceId ? computerName : "gateway");
  return <>
    {!requestedTarget && <Input aria-label="Find terminal" placeholder="Find a terminal by name or ID" value={query} onChange={event => {
      setQuery(event.target.value); setPage(0);
    }} />}
    {!matches.length || (byId && matches.length !== 1) ? <p role="status">{requestedTarget
      ? `${addressLabel}/${requestedTarget} is unavailable. Ask Chat to list terminals again.` : "No matching terminals."}</p> :
      <div className="flex flex-wrap gap-1">{matches.slice(start, start + PAGE_SIZE).map(row => <Button key={row.tabId}
        type="button" variant="secondary" size="sm" onClick={() => onSelect({
          kind: "terminal_session", id: `${workspaceId}:${row.tabId}`, label: row.title, revision: row.revision,
        }, remoteMachine ? `machine:${remoteMachine}/${row.id}` : `${computerName || "gateway"}/${row.id}`)}>{requestedTarget ? `Use ${row.title} (${addressLabel}/${row.id})` : `${row.title} (${row.id})`}</Button>)}</div>}
    {matches.length > PAGE_SIZE && <div className="flex items-center gap-2">
      <Button type="button" variant="ghost" size="sm" disabled={!page} onClick={() => setPage(page - 1)}>Previous</Button>
      <span>{start + 1}–{Math.min(start + PAGE_SIZE, matches.length)} of {matches.length}</span>
      <Button type="button" variant="ghost" size="sm" disabled={start + PAGE_SIZE >= matches.length} onClick={() => setPage(page + 1)}>Next</Button>
    </div>}
  </>;
}
