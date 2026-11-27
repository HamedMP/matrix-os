import { z } from "zod/v4";
import { HerdrDiscoveryQuerySchema } from "@matrix-os/contracts/herdr-terminals";
import type { DiscoveredMachine } from "@matrix-os/herdr-core-client/sessions";
import type { DesktopLinkRegistry } from "../desktop-link/registry.js";
import type { HerdrAdapter } from "../herdr/adapter.js";
import { privatePreviewHerdrOwner } from "../herdr/private-preview.js";

export const HerdrDiscoveryActionSchema = HerdrDiscoveryQuerySchema.extend({ action: z.literal("discover") });
type Query = z.infer<typeof HerdrDiscoveryActionSchema>;
type Machine = Omit<DiscoveredMachine, "online"> & {
  online: boolean | null;
  terminalInventory?: "unknown" | "unavailable";
  inventoryOnly?: true;
  runtimeSlot?: string;
  source?: "matrix" | "herdr";
  core?: "private";
  via?: { id: string; name: string };
};
type Inventory = { machines: Machine[]; partial?: boolean };
type Desktop = ReturnType<DesktopLinkRegistry["linked"]>[number];

// Short answers by default; each follow-up queries current presence.
const PAGE_SIZE = 5;
const addressOrder = new Intl.Collator("en", { numeric: true });
function page<T>(rows: T[], offset: number) {
  const items = rows.slice(offset, offset + PAGE_SIZE);
  return { items, total: rows.length, nextOffset: offset + items.length < rows.length ? offset + items.length : null };
}
const empty = (): Inventory => ({ machines: [] });

async function desktopInventory(registry: DesktopLinkRegistry, desktop: Desktop, input: Query): Promise<() => Inventory> {
  const id = "desktop:" + desktop.deviceId;
  const lease = await registry.chatLease(desktop.deviceId);
  if (!lease) return empty;
  const machine: Machine = { id, name: lease.name, online: true, terminalInventory: "unknown", terminals: [] };
  const listsLocalTerminals = input.machine === id || (!input.machine && input.query);
  if (listsLocalTerminals && (!input.machineQuery || machine.name.toLowerCase().includes(input.machineQuery.toLowerCase()))) {
    try {
      const list = await desktop.adapter.list();
      machine.terminalInventory = list.available ? undefined : "unavailable";
      machine.terminals = list.sessions;
    } catch (error: unknown) {
      console.warn("[chat-herdr] Desktop terminals unavailable", error instanceof Error ? error.name : "unknown_error");
      machine.terminalInventory = "unavailable";
    }
  }
  // Read the snapshot at response time. Replacement, expiry and revocation during
  // another source's lookup must not leak the old connection's inventory.
  return () => {
    if (!lease.current()) return empty();
    const snapshot = lease.herdrMachines();
    const machines: Machine[] = [machine];
    for (const row of snapshot ?? []) {
      const source = row.source ?? "herdr";
      const slot = row.source === "matrix" ? row.runtimeSlot : undefined;
      const privateCore = row.source !== "matrix" && row.core === "private";
      machines.push({
        ...(privateCore ? { core: "private" as const } : {}),
        id: "via:" + desktop.deviceId + ":" + (privateCore ? "private-herdr" : source) + ":" + row.name + (slot ? ":" + slot : ""), name: row.name,
        ...(slot ? { runtimeSlot: slot } : {}),
        online: row.state === "connected" ? true : null, state: row.state,
        via: { id, name: machine.name }, source, inventoryOnly: true, terminals: [],
      });
    }
    return {
      machines,
      partial: machine.terminalInventory === "unavailable" ||
        (!input.machine || input.machine.startsWith("via:") ? !snapshot || lease.herdrMachinesPartial() === true : false),
    };
  };
}

export async function discoverChatTerminals(
  adapter: Pick<HerdrAdapter, "discoverTerminals"> | null, input: Query, desktops?: DesktopLinkRegistry | null,
) {
  const sources: Array<Promise<() => Inventory>> = [];
  const needGateway = !input.machine || input.machine === "gateway" || input.machine.startsWith("herdr:");
  if (adapter && needGateway) {
    sources.push(adapter.discoverTerminals().then(({ machines }) => () => ({
      machines: machines.map(machine => machine.state ? {
        ...machine, online: machine.state === "connected" ? true : null,
        source: "herdr" as const, via: { id: "gateway", name: "Current Matrix computer" },
      } : machine),
    })));
  }
  if (desktops) {
    for (const device of desktops.linked()) {
      if (input.machine && input.machine !== "desktop:" + device.deviceId && !input.machine.startsWith("via:" + device.deviceId + ":")) continue;
      sources.push(desktopInventory(desktops, device, input));
    }
    if (!input.machine || input.machine.startsWith("desktop:")) {
      sources.push(desktops.pairedOffline().then(device => () => device?.current() ? {
        machines: [{ id: "desktop:" + device.deviceId, name: device.name, online: false, terminals: [] }],
      } : empty()));
    }
  }
  const machines: Machine[] = [];
  let partial = false;
  for (const result of await Promise.allSettled(sources)) {
    if (result.status === "fulfilled") {
      const inventory = result.value();
      machines.push(...inventory.machines);
      partial ||= inventory.partial === true;
    } else {
      console.warn("[chat-herdr] Inventory source unavailable", result.reason instanceof Error ? result.reason.name : "unknown_error");
      partial = true;
    }
  }
  if (needGateway && !machines.some(machine => machine.id === "gateway")) {
    // This owner-scoped request reached the gateway even when its Herdr is down.
    machines.push({ id: "gateway", name: "Current Matrix computer", online: true, terminalInventory: "unavailable", terminals: [] });
    partial = true;
  }
  const completeness = partial ? { partial: true } : {};
  const offset = input.offset ?? 0;
  const nameOf = (machine: Machine) => {
    if (machine.id !== "gateway") return machine.name;
    if (privatePreviewHerdrOwner(process.env)) return `Private Preview ${process.env.MATRIX_HANDLE}`;
    const label = process.env.MATRIX_RUNTIME_SLOT === "primary" ? "Main Computer" : machine.name;
    return process.env.MATRIX_HANDLE ? `${label} (${process.env.MATRIX_HANDLE})` : label;
  };
  const machineQuery = input.machineQuery?.toLowerCase();
  const filtered = machines.filter(machine =>
    (!input.onlineOnly || machine.online === true) &&
    (!machineQuery || nameOf(machine).toLowerCase().includes(machineQuery) || machine.runtimeSlot?.includes(machineQuery)));
  if (!input.machine && !input.query) {
    filtered.sort((a, b) => Number(b.id === "gateway") - Number(a.id === "gateway") ||
      Number(b.online) - Number(a.online) || a.id.localeCompare(b.id));
    const result = page(filtered, offset);
    return {
      ...completeness, source: "Current Matrix computer and computers reported by its Herdr or paired desktops",
      total: result.total, nextOffset: result.nextOffset,
      machines: result.items.map(machine => ({
        id: machine.id, name: nameOf(machine), online: machine.online,
        ...(machine.terminalInventory ? { terminalInventory: machine.terminalInventory } : {}),
        ...(machine.via ? { via: machine.via, source: machine.source, state: machine.state } : {}),
        ...(machine.inventoryOnly ? { inventoryOnly: true } : {}),
        ...(machine.runtimeSlot ? { runtimeSlot: machine.runtimeSlot } : {}),
        ...(machine.core ? { core: machine.core } : {}),
        terminalCount: machine.online && !machine.terminalInventory && !machine.inventoryOnly ? machine.terminals.length : null,
        ...(machine.online && machine.terminals.length > 0 && machine.terminals.length <= 3
          ? { terminals: machine.terminals.map(t => ({ address: machine.id + "/" + t.id, title: t.title })) } : {}),
      })),
    };
  }
  const selected = input.machine ? filtered.find(m => m.id === input.machine) : undefined;
  if (input.machine && !selected) return { ...completeness, machine: input.machine, status: "not_listed" };
  if (selected?.inventoryOnly) return { machine: selected.id, name: selected.name, status: "inventory_only", state: selected.state, via: selected.via, source: selected.source, core: selected.core, runtimeSlot: selected.runtimeSlot };
  if (selected?.terminalInventory === "unavailable") return { machine: selected.id, status: "terminal_inventory_unavailable" };
  if (selected?.via && selected.online !== true) return { machine: selected.id, status: selected.state, via: selected.via };
  if (selected && !selected.online) return { machine: selected.id, status: "offline" };
  const query = input.query?.toLowerCase() ?? "";
  const matching = (selected ? [selected] : filtered).filter(m => m.online && !m.inventoryOnly).flatMap(m =>
    m.terminals.filter(t => t.title.toLowerCase().includes(query) || (m.id + "/" + t.id).includes(query))
      .map(t => ({ address: m.id + "/" + t.id, title: t.title, status: t.status })),
  );
  matching.sort((a, b) => addressOrder.compare(a.address, b.address));
  const result = page(matching, offset);
  return {
    ...(partial || (!selected && filtered.some(machine => machine.inventoryOnly)) ? { partial: true } : {}),
    ...(selected ? { machine: selected.id, name: nameOf(selected), status: "online" } : {}),
    total: result.total, nextOffset: result.nextOffset, terminals: result.items,
  };
}
