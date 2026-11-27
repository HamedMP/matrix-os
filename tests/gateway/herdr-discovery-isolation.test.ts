import { expect, it, vi } from "vitest";
import { discoverChatTerminals } from "../../packages/gateway/src/chat/herdr-discovery.js";
import { createFakeHerdrCore } from "./fixtures/fake-herdr-core-server.js";
import { dialMac, gateway, pair, testMac, unpair } from "./fixtures/desktop-link-harness.js";

async function linked(herdrInventory = false) {
  const computer = await gateway();
  const desktop = testMac();
  await pair(computer.http, desktop);
  const link = dialMac(computer.base, desktop, { revision: 1, core: createFakeHerdrCore(), herdrInventory });
  await link.ready();
  return { computer, desktop, link };
}

const local = { id: "gateway", name: "Gateway", online: true, terminals: [{ id: "t7", title: "build", status: null }] };

it("continues discovering gateway terminals when desktop pairing storage is unavailable", async () => {
  const { computer } = await linked();
  vi.spyOn(computer.registry!, "chatLease").mockRejectedValue(new Error("pairing temporarily unavailable"));
  const found = await discoverChatTerminals({ discoverTerminals: async () => ({ machines: [local] }) },
    { action: "discover", query: "build" }, computer.registry);
  expect(found).toMatchObject({ partial: true, total: 1, terminals: [{ address: "gateway/t7" }] });
});

it("withholds a desktop revoked while a different computer's inventory was loading", async () => {
  const { computer, desktop } = await linked();
  const found = await discoverChatTerminals({
    discoverTerminals: async () => {
      expect((await unpair(computer.http, desktop, 1)).ok).toBe(true);
      return { machines: [local] };
    },
  }, { action: "discover" }, computer.registry);
  expect(found).toMatchObject({ total: 1, machines: [{ id: "gateway" }] });
});

it("reports the reachable Matrix host even when its terminal service has no inventory", async () => {
  const adapter = { discoverTerminals: async () => ({ machines: [] }) };
  const overview = await discoverChatTerminals(adapter, { action: "discover" });
  expect(overview).toMatchObject({ machines: [{ id: "gateway", online: true, terminalCount: null }] });
  expect(await discoverChatTerminals(adapter, { action: "discover", machine: "gateway" }))
    .toMatchObject({ status: "terminal_inventory_unavailable" });
});

it("searches and pages machines reported by the owner's current Mac without fabricating terminal addresses", async () => {
  const { computer, desktop, link } = await linked(true);
  const registry = computer.registry!;
  const rows = [
    { name: "lab-build", state: "connected" },
    { name: "dev-host", state: "unreachable" },
    { name: "dev-host", state: "unknown", source: "matrix", runtimeSlot: "qa" },
    { name: "dev-host", state: "connected", source: "matrix", runtimeSlot: "pr-55" },
    { name: "core-duplicate", state: "unknown", core: "private" },
    { name: "core-duplicate", state: "connected" },
    ...["a", "b"].map(name => ({ name, state: "connected" })),
  ] as const;
  link.socket.send(JSON.stringify({ t: "pong", herdrMachines: rows }));
  await expect.poll(() => registry.linked()[0]?.herdrMachines?.length).toBe(rows.length);
  const discover = (filters = {}) => discoverChatTerminals(null, { action: "discover", ...filters }, registry);
  const overview = await discover();
  expect(overview).toMatchObject({ total: 10, nextOffset: 5 });
  expect(await discover({ offset: 5 })).toMatchObject({ total: 10, nextOffset: null });
  const lab = await discover({ machineQuery: "BuIlD", onlineOnly: true });
  const coreId = "via:" + desktop.deviceId + ":private-herdr:core-duplicate";
  expect((await discover({ machineQuery: "core-duplicate" })).machines).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: coreId, core: "private", state: "unknown" }),
    expect.objectContaining({ id: "via:" + desktop.deviceId + ":herdr:core-duplicate", state: "connected" }),
  ]));
  expect(await discover({ machine: coreId })).toMatchObject({ status: "inventory_only", core: "private" });
  const id = "via:" + desktop.deviceId + ":herdr:lab-build";
  expect(lab).toMatchObject({ total: 1, machines: [{ id, name: "lab-build", online: true, terminalCount: null,
    inventoryOnly: true, state: "connected", via: expect.objectContaining({ id: "desktop:" + desktop.deviceId }) }] });
  expect(await discover({ machine: id })).toMatchObject({ machine: id, status: "inventory_only" });
  const aliases = await discover({ machineQuery: "dev-host" });
  expect(aliases).toMatchObject({ total: 3, machines: expect.arrayContaining([
    expect.objectContaining({ id: "via:" + desktop.deviceId + ":herdr:dev-host", online: null, state: "unreachable" }),
    expect.objectContaining({ id: "via:" + desktop.deviceId + ":matrix:dev-host:qa", runtimeSlot: "qa", online: null, state: "unknown" }),
  ]) });
  expect(await discover({ machineQuery: "PR-55", onlineOnly: true })).toMatchObject({ total: 1, machines: [
    { id: "via:" + desktop.deviceId + ":matrix:dev-host:pr-55", online: true, inventoryOnly: true },
  ] });
  expect(await discover({ machine: "via:" + desktop.deviceId + ":matrix:dev-host:qa" })).toMatchObject({ status: "inventory_only" });
});

it("retains the owner's paired desktop while disconnected, excluding its stale remote inventory", async () => {
  const { computer, desktop, link } = await linked(true);
  const registry = computer.registry!;
  link.socket.send(JSON.stringify({ t: "pong", herdrMachines: [{ name: "remote", state: "connected" }] }));
  await expect.poll(() => registry.linked()[0]?.herdrMachines?.length).toBe(1);
  link.socket.close();
  await link.closed();
  const discover = (onlineOnly?: boolean) => discoverChatTerminals(null, { action: "discover", onlineOnly }, registry);
  expect(await discover()).toMatchObject({ total: 2, machines: [{ id: "gateway" }, { id: "desktop:" + desktop.deviceId, online: false, terminalCount: null }] });
  expect(await discover(true)).toMatchObject({ total: 1, machines: [{ id: "gateway" }] });
  expect((await unpair(computer.http, desktop, 1)).ok).toBe(true);
  expect(await discover()).toMatchObject({ total: 1, machines: [{ id: "gateway" }] });
});
