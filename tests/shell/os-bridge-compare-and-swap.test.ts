import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { buildBridgeScript } from "../../shell/src/lib/os-bridge";

it("dispatches compareAndSwap through the authenticated parent bridge with its exact app and snapshot", async () => {
  const requests: unknown[] = [];
  class Channel {
    port1 = { close: vi.fn(), onmessage: undefined as undefined | ((event: unknown) => void) };
    port2 = { reply: (data: unknown) => this.port1.onmessage?.({ data }) };
  }
  const window = { MatrixOS: undefined as any, addEventListener: vi.fn(), parent: {
    postMessage(message: any, _origin: string, ports: Channel["port2"][]) {
      requests.push(message);
      ports[0].reply({ ok: true, body: { ok: false } });
    },
  } };
  runInNewContext(buildBridgeScript("folio"), { window, document: { documentElement: { dataset: {} }, createElement: () => ({}), head: { appendChild: vi.fn() } }, MessageChannel: Channel, setTimeout, clearTimeout, console });
  const expectedPayload = { fields: { title: "Original" }, manualFields: [] };
  const data = { payload: { fields: { title: "Edited" }, manualFields: ["title"] } };
  await expect(window.MatrixOS.db.compareAndSwap("records", "row-id", expectedPayload, data)).resolves.toEqual({ ok: false });
  expect(requests).toHaveLength(1);
  const request = requests[0] as any;
  expect(request.type).toBe("os:bridge-fetch");
  expect(request.payload.url).toBe("/api/bridge/query");
  expect(request.payload.init.method).toBe("POST");
  expect(JSON.parse(request.payload.init.body)).toEqual({ app: "folio", action: "compareAndSwap", table: "records", id: "row-id", expectedPayload, data });
});
