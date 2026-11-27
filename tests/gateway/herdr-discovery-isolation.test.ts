import { expect, it, vi } from "vitest";
import { discoverChatTerminals } from "../../packages/gateway/src/chat/herdr-discovery.js";
import { createFakeHerdrCore } from "./fixtures/fake-herdr-core-server.js";
import { dialMac, gateway, pair, testMac, unpair } from "./fixtures/desktop-link-harness.js";

async function linked() {
  const computer = await gateway();
  const desktop = testMac();
  await pair(computer.http, desktop);
  const link = dialMac(computer.base, desktop, { revision: 1, core: createFakeHerdrCore() });
  await link.ready();
  return { computer, desktop };
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
