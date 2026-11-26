import { z } from "zod/v4";
import { HerdrDiscoveryQuerySchema } from "@matrix-os/contracts/herdr-terminals";
import type { HerdrAdapter } from "../herdr/adapter.js";
import { privatePreviewHerdrOwner } from "../herdr/private-preview.js";

export const HerdrDiscoveryActionSchema = HerdrDiscoveryQuerySchema.extend({ action: z.literal("discover") });

// Short answers by default; each follow-up queries current presence.
const PAGE_SIZE = 5;
const addressOrder = new Intl.Collator("en", { numeric: true });
function page<T>(rows: T[], offset: number) {
  const items = rows.slice(offset, offset + PAGE_SIZE);
  return { items, total: rows.length, nextOffset: offset + items.length < rows.length ? offset + items.length : null };
}

export async function discoverChatTerminals(
  adapter: Pick<HerdrAdapter, "discoverTerminals">,
  input: z.infer<typeof HerdrDiscoveryActionSchema>,
) {
  const { machines } = await adapter.discoverTerminals();
  const offset = input.offset ?? 0;
  const nameOf = (machine: typeof machines[number]) =>
    machine.id === "gateway" && privatePreviewHerdrOwner(process.env)
      ? `Private Preview ${process.env.MATRIX_HANDLE}` : machine.name;

  if (!input.machine && !input.query) {
    const ordered = [...machines].sort((a, b) =>
      Number(b.id === "gateway") - Number(a.id === "gateway") ||
      Number(b.online) - Number(a.online) || a.id.localeCompare(b.id),
    );
    const result = page(ordered, offset);
    return {
      source: "current Matrix computer and the remotes registered with its Herdr Core",
      total: result.total, nextOffset: result.nextOffset,
      machines: result.items.map(machine => ({
        id: machine.id, name: nameOf(machine), online: machine.online,
        terminalCount: machine.online ? machine.terminals.length : null,
        ...(machine.online && machine.terminals.length > 0 && machine.terminals.length <= 3
          ? { terminals: machine.terminals.map(t => ({ address: machine.id + "/" + t.id, title: t.title })) } : {}),
      })),
    };
  }
  const selected = input.machine ? machines.find(m => m.id === input.machine) : undefined;
  if (input.machine && !selected) return { machine: input.machine, status: "not_listed" };
  if (selected && !selected.online) return { machine: selected.id, status: "offline" };
  const query = input.query?.toLowerCase() ?? "";
  const matching = (selected ? [selected] : machines).filter(m => m.online).flatMap(m =>
    m.terminals.filter(t => t.title.toLowerCase().includes(query) || (m.id + "/" + t.id).includes(query))
      .map(t => ({ address: m.id + "/" + t.id, title: t.title, status: t.status })),
  );
  matching.sort((a, b) => addressOrder.compare(a.address, b.address));
  const result = page(matching, offset);
  return {
    ...(selected ? { machine: selected.id, name: nameOf(selected), status: "online" } : {}),
    total: result.total, nextOffset: result.nextOffset, terminals: result.items,
  };
}
