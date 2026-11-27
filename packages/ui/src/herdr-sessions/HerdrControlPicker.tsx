import { useEffect, useState } from "react";
import { HERDR_TERMINAL_WORKSPACE_ID, HerdrSessionIdSchema, TERMINAL_CONTROL_COMMAND } from "@matrix-os/contracts/herdr-terminals";
import { desktopLinkWorkspaceId, type DesktopLinkMachine } from "@matrix-os/contracts/desktop-link";
import { ManagedTerminalPickerListSchema } from "@matrix-os/contracts/managed-terminal-control";
import type { z } from "zod/v4";
import type { CanonicalChatMessagePart, CanonicalChatResourceReference } from "@matrix-os/contracts";
import { Button } from "../Button.js";
import { Input } from "../Input.js";
import { loadDesktopMachines, loadDesktopTerminals } from "../desktop-link/desktop-link-client.js";
import { loadHerdrSessions, type HerdrSession, type HerdrSessionsRequest } from "./herdr-sessions-client.js";

export function herdrControlParts(target: CanonicalChatResourceReference): CanonicalChatMessagePart[] {
  return [{ type: "invocation_reference", invocation: TERMINAL_CONTROL_COMMAND }, { type: "resource_reference", resource: target }];
}

const PAGE_SIZE = 5;
const MANAGED_COMPUTERS_PATH = "/api/terminal/herdr/managed";
type ManagedComputer = z.infer<typeof ManagedTerminalPickerListSchema>["computers"][number];
const EMPTY_COMPUTERS: ManagedComputer[] = [];

export function requestedManagedTerminalAddress(text: string): string | undefined {
  const managed = /^(?:(?:please\s+)?(?:use\s+|select\s+)|(?:请)?(?:使用|用)\s*)?`?matrix:([a-z0-9][a-z0-9_-]{0,127})\/(t[0-9]{1,6}[a-z]{0,2})`?(?=$|[\s,.:，。、：])/iu.exec(text.trimStart());
  return managed ? `matrix:${managed[1]}/${managed[2]!.toLowerCase()}` : undefined;
}

async function loadManagedComputers(request: HerdrSessionsRequest) {
  const response = await request(MANAGED_COMPUTERS_PATH, { method: "GET", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return EMPTY_COMPUTERS;
  const parsed = ManagedTerminalPickerListSchema.safeParse(await response.json());
  return parsed.success ? parsed.data.computers : EMPTY_COMPUTERS;
}

function desktopDisplayName(entry: DesktopLinkMachine, machines: DesktopLinkMachine[], gatewayName: string, directMachines: string[]) {
  const ambiguousDesktop = entry.name === gatewayName || machines.some(other => other.deviceId !== entry.deviceId && other.name === entry.name);
  const name = ambiguousDesktop ? `${entry.name} · ${entry.deviceId.slice(0, 8)}` : entry.name;
  return directMachines.includes(entry.name) ? `${name} · Paired desktop` : name;
}
type PickerProps = {
  request: HerdrSessionsRequest;
  requestedTarget?: string;
  computerName?: string;
  managedOnly?: boolean;
  onSelect(target: CanonicalChatResourceReference, address: string): void;
  onCancel(): void;
};

/** Only an explicit choice produces a terminal grant. A name or address in the prompt is a filter. */
export function HerdrControlPicker({ request, onSelect, onCancel, requestedTarget, computerName, managedOnly }: PickerProps) {
  const [catalog, setCatalog] = useState<{ request: HerdrSessionsRequest; machines: DesktopLinkMachine[] } | null>(null);
  const [selected, setSelected] = useState<{ request: HerdrSessionsRequest; deviceId?: string; machine?: string; managedId?: string } | null>(null);
  const [managedCatalog, setManagedCatalog] = useState<{ request: HerdrSessionsRequest; computers: ManagedComputer[] } | null>(null);
  const [gateway, setGateway] = useState<{ request: HerdrSessionsRequest; sessions: HerdrSession[] } | null>(null);
  const machines = catalog?.request === request ? catalog.machines : [];
  const requestedDesktop = /^desktop:([0-9a-f]{64})\/(?:machine:([a-z0-9][a-z0-9._-]{0,31})\/)?(t[0-9]{1,6}[a-z]{0,2})$/.exec(requestedTarget ?? "");
  const requestedMachine = /^(?:machine:|herdr:)([a-z0-9][a-z0-9._-]{0,31})\/(t[0-9]{1,6}[a-z]{0,2})$/.exec(requestedTarget ?? "");
  const requestedManaged = /^matrix:([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\/(t[0-9]{1,6}[a-z]{0,2})$/.exec(requestedTarget ?? "");
  const requestedManagedId = requestedManaged?.[1];
  const requestedDeviceId = requestedDesktop?.[1];
  const currentSelection = !requestedTarget && selected?.request === request ? selected : null;
  const deviceId = requestedDeviceId ?? currentSelection?.deviceId ?? null;
  const remoteMachine = requestedMachine?.[1] ?? currentSelection?.machine;
  const managedId = requestedManagedId ?? currentSelection?.managedId;
  const managedComputers = managedCatalog?.request === request ? managedCatalog.computers : EMPTY_COMPUTERS;
  const managed = managedComputers.find(entry => entry.machineId === managedId);
  const gatewaySessions = gateway?.request === request ? gateway.sessions : null;
  const directMachines = [...new Set(gatewaySessions?.flatMap(session => session.machine ? [session.machine] : []))];
  const machine = machines.find(entry => entry.deviceId === deviceId);
  const gatewayName = computerName || "This computer";
  const managedName = (entry: ManagedComputer) => {
    const duplicate = managedComputers.some(other => other.machineId !== entry.machineId && other.name === entry.name);
    if (duplicate) {
      const duplicateSlot = managedComputers.some(other => other.machineId !== entry.machineId && other.name === entry.name && other.runtimeSlot === entry.runtimeSlot);
      return `${entry.name} · ${entry.runtimeSlot}${duplicateSlot ? ` · ${entry.machineId}` : ""}`;
    }
    return entry.name === gatewayName || machines.some(other => other.name === entry.name) || directMachines.includes(entry.name)
      ? `${entry.name} · Matrix Computer` : entry.name;
  };
  const selectedName = managed ? managedName(managed) : machine ? desktopDisplayName(machine, machines, gatewayName, directMachines) : computerName;
  const mayLoadManaged = managedOnly && (!requestedTarget || Boolean(requestedManagedId));
  useEffect(() => {
    if (!mayLoadManaged) return;
    let current = true;
    void loadManagedComputers(request).then(computers => {
      if (current) setManagedCatalog({ request, computers });
    }).catch((error: unknown) => {
      const missingRoute = error instanceof Error && error.name === "AppError"
        && "httpStatus" in error && error.httpStatus === 404;
      if (!(error instanceof SyntaxError) && !missingRoute) {
        console.warn("[terminal-control] Matrix Computer list unavailable", error instanceof Error ? error.name : "UnknownError");
      }
      if (current) setManagedCatalog({ request, computers: EMPTY_COMPUTERS });
    });
    return () => { current = false; };
  }, [request, mayLoadManaged]);
  useEffect(() => {
    if (managedOnly || (requestedTarget && !requestedDeviceId)) return;
    let current = true;
    void loadDesktopMachines(request).then(result => {
      if (current) setCatalog({ request, machines: result.machines });
    }).catch((error: unknown) => {
      console.warn("[herdr] Desktop list unavailable", error instanceof Error ? error.name : "UnknownError");
      if (current) setCatalog({ request, machines: [] });
    });
    return () => { current = false; };
  }, [request, requestedTarget, requestedDeviceId, managedOnly]);
  useEffect(() => {
    if (managedOnly || requestedDeviceId || requestedManagedId) return;
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
  }, [request, requestedTarget, requestedDeviceId, requestedManagedId, managedOnly]);
  return <section aria-label="Choose a terminal" className="space-y-2 rounded-lg border p-3 text-sm">
    <p>Choose the terminal this message can read, type into, and interrupt.</p>
    {!requestedTarget && (machines.length > 0 || directMachines.length > 0 || managedComputers.length > 0) && <div role="group" aria-label="Computers" className="flex flex-wrap gap-1">
      {!managedOnly && <Button type="button" size="sm" variant="secondary" aria-pressed={!deviceId && !remoteMachine && !managedId}
        onClick={() => setSelected(null)}>{gatewayName}</Button>}
      {directMachines.map(name => <Button key={name} type="button" size="sm" variant="secondary"
        aria-pressed={remoteMachine === name} onClick={() => setSelected({ request, machine: name })}>{
          name === gatewayName || machines.some(entry => entry.name === name) ? `${name} · Direct connection` : name
        }</Button>)}
      {machines.map(entry => <Button type="button" size="sm" variant="secondary" key={entry.deviceId}
        aria-pressed={deviceId === entry.deviceId} disabled={entry.state !== "online"}
        onClick={() => setSelected({ request, deviceId: entry.deviceId })}>{desktopDisplayName(entry, machines, gatewayName, directMachines)}{entry.state === "offline" ? " (offline)" : ""}</Button>)}
      {managedComputers.length > 0 && <ManagedComputerChoices computers={managedComputers} selectedId={managedId} label={managedName}
        onSelect={entry => setSelected({ request, managedId: entry.machineId })} />}
    </div>}
    {(deviceId && catalog?.request !== request) || ((managedId || managedOnly) && managedCatalog?.request !== request)
      ? <p role="status">Finding computer…</p>
      : (deviceId && machine?.state !== "online") || (managedId && !managed) ? <p role="status">Computer unavailable.</p> :
      managedOnly && !managed ? !managedComputers.length && <p role="status">No other Matrix Computers are available.</p> :
      <TerminalChoices key={JSON.stringify([deviceId, machine?.revision, remoteMachine, managedId, managed?.workspaceId, requestedTarget])} request={request}
        requestedTarget={requestedDesktop?.[3] ?? requestedMachine?.[2] ?? requestedManaged?.[2] ?? requestedTarget}
        requestedEnrolledMachine={requestedDesktop?.[2]}
        computerName={selectedName} deviceId={deviceId} remoteMachine={remoteMachine} managed={managed}
        gatewaySessions={gatewaySessions} onSelect={onSelect} />}
    <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
  </section>;
}

function ManagedComputerChoices({ computers, selectedId, label, onSelect }: {
  computers: ManagedComputer[];
  selectedId?: string;
  label(computer: ManagedComputer): string;
  onSelect(computer: ManagedComputer): void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const search = query.trim().toLowerCase();
  const matches = computers.filter(entry => label(entry).toLowerCase().includes(search));
  const start = Math.min(page, Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1)) * PAGE_SIZE;
  return <div className="flex w-full flex-wrap items-center gap-1">
    {computers.length > PAGE_SIZE && <Input aria-label="Find computer" placeholder="Find a computer by name"
      value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} />}
    {matches.slice(start, start + PAGE_SIZE).map(entry => <Button type="button" size="sm" variant="secondary"
      key={entry.machineId} aria-pressed={selectedId === entry.machineId} onClick={() => onSelect(entry)}>{label(entry)}</Button>)}
    {!matches.length && <p role="status">No matching computers.</p>}
    {matches.length > PAGE_SIZE && <div className="flex items-center gap-2">
      <Button type="button" size="sm" variant="ghost" disabled={start === 0} onClick={() => setPage(start / PAGE_SIZE - 1)}>Previous computers</Button>
      <Button type="button" size="sm" variant="ghost" disabled={start + PAGE_SIZE >= matches.length} onClick={() => setPage(start / PAGE_SIZE + 1)}>Next computers</Button>
    </div>}
  </div>;
}

function TerminalChoices({ request, requestedTarget, computerName, deviceId, remoteMachine, managed, requestedEnrolledMachine, gatewaySessions, onSelect }:
  Omit<PickerProps, "onCancel"> & {
    deviceId: string | null;
    remoteMachine?: string;
    managed?: ManagedComputer;
    requestedEnrolledMachine?: string;
    gatewaySessions: HerdrSession[] | null;
  }) {
  const [inventory, setInventory] = useState<{ request: HerdrSessionsRequest; sessions: HerdrSession[]; unavailable?: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selectedEnrolledMachine, setSelectedEnrolledMachine] = useState<string>();
  const enrolledMachine = requestedEnrolledMachine ?? selectedEnrolledMachine;
  const allSessions = deviceId || managed ? (inventory?.request === request ? inventory.sessions : null) : gatewaySessions;
  const sessions = allSessions?.filter(row => row.machine === (deviceId ? enrolledMachine : remoteMachine));
  const workspaceId = managed?.workspaceId ?? (deviceId ? desktopLinkWorkspaceId(deviceId) : HERDR_TERMINAL_WORKSPACE_ID);
  useEffect(() => {
    const load = managed
      ? () => loadHerdrSessions((_path, init) => request(`${MANAGED_COMPUTERS_PATH}?machine=${encodeURIComponent(managed.machineId)}`, init))
      : deviceId ? () => loadDesktopTerminals(request, deviceId, "chat-control") : null;
    if (!load) return;
    let current = true;
    const refresh = () => void load().then(list => {
      const unavailable = managed && "available" in list && list.available === false;
      if (current) setInventory({ request, unavailable, sessions: unavailable ? [] : list.sessions.filter(row => row.revision) });
    }).catch((error: unknown) => {
      console.warn("[herdr] Chat terminal list unavailable", error instanceof Error ? error.name : "UnknownError");
      if (current) setInventory({ request, sessions: [], unavailable: Boolean(managed) });
    });
    const timer = requestedTarget ? setTimeout(refresh, 180) : undefined;
    if (!requestedTarget) refresh();
    return () => { current = false; clearTimeout(timer); };
  }, [request, requestedTarget, workspaceId, deviceId, managed]);
  if (!sessions) return <p role="status">Loading terminals…</p>;
  if (managed && inventory?.unavailable) return <p role="status">Computer unavailable.</p>;
  const enrolledMachines = deviceId && !requestedTarget
    ? [...new Set(allSessions?.flatMap(row => row.machine ? [row.machine] : []))]
    : [];
  const selectEnrolledMachine = (name?: string) => {
    setSelectedEnrolledMachine(name);
    setQuery("");
    setPage(0);
  };
  const byId = requestedTarget && HerdrSessionIdSchema.safeParse(requestedTarget).success;
  const search = (requestedTarget ?? query).trim().toLowerCase();
  const matches = sessions.filter(row => requestedTarget
    ? (byId ? row.id === requestedTarget : row.title.toLowerCase() === search)
    : row.title.toLowerCase().includes(search) || row.id.includes(search));
  const start = page * PAGE_SIZE;
  const addressLabel = enrolledMachine ?? remoteMachine ?? (deviceId || managed ? computerName : "gateway");
  const addressFor = (id: string) => {
    if (managed) return `matrix:${managed.machineId}/${id}`;
    if (deviceId && enrolledMachine) return `desktop:${deviceId}/machine:${enrolledMachine}/${id}`;
    return remoteMachine ? `machine:${remoteMachine}/${id}` : `${computerName || "gateway"}/${id}`;
  };
  return <>
    {enrolledMachines.length > 0 && <div role="group" aria-label="Machines reachable from this desktop" className="flex flex-wrap gap-1">
      <Button type="button" size="sm" variant="secondary" aria-pressed={!enrolledMachine}
        onClick={() => selectEnrolledMachine()}>Local terminals</Button>
      {enrolledMachines.map(name => <Button key={name} type="button" size="sm" variant="secondary"
        aria-pressed={enrolledMachine === name} onClick={() => selectEnrolledMachine(name)}>{name}</Button>)}
    </div>}
    {!requestedTarget && <Input aria-label="Find terminal" placeholder="Find a terminal by name or ID" value={query} onChange={event => {
      setQuery(event.target.value); setPage(0);
    }} />}
    {!matches.length || (byId && matches.length !== 1) ? <p role="status">{requestedTarget
      ? `${addressLabel}/${requestedTarget} is unavailable. Ask Chat to list terminals again.` : "No matching terminals."}</p> :
      <div className="flex flex-wrap gap-1">{matches.slice(start, start + PAGE_SIZE).map(row => <Button key={row.tabId}
        type="button" variant="secondary" size="sm" onClick={() => onSelect({
          kind: "terminal_session", id: `${workspaceId}:${row.tabId}`, label: row.title, revision: row.revision,
        }, addressFor(row.id))}>{requestedTarget ? `Use ${row.title} (${addressLabel}/${row.id})` : `${row.title} (${row.id})`}</Button>)}</div>}
    {matches.length > PAGE_SIZE && <div className="flex items-center gap-2">
      <Button type="button" variant="ghost" size="sm" disabled={!page} onClick={() => setPage(page - 1)}>Previous</Button>
      <span>{start + 1}–{Math.min(start + PAGE_SIZE, matches.length)} of {matches.length}</span>
      <Button type="button" variant="ghost" size="sm" disabled={start + PAGE_SIZE >= matches.length} onClick={() => setPage(page + 1)}>Next</Button>
    </div>}
  </>;
}
