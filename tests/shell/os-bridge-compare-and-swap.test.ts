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

it("keeps an owner collaboration mutation reply open through the shared-app request budget", async () => {
  vi.useFakeTimers();
  try {
    let reply: ((data: unknown) => void) | undefined;
    class Channel {
      port1 = { close: vi.fn(), onmessage: undefined as undefined | ((event: { data: unknown }) => void) };
      port2 = { reply: (data: unknown) => this.port1.onmessage?.({ data }) };
    }
    const window = { MatrixOS: undefined as any, addEventListener: vi.fn(), parent: {
      postMessage(_message: unknown, _origin: string, ports: Channel["port2"][]) {
        reply = ports[0].reply;
      },
    } };
    runInNewContext(buildBridgeScript("tracker"), {
      window,
      document: { documentElement: { dataset: {} }, createElement: () => ({}), head: { appendChild: vi.fn() } },
      MessageChannel: Channel, setTimeout, clearTimeout, console,
    });

    const mutation = window.MatrixOS.collaboration.mutate({ action: "update" }, "7");
    const settled = expect(mutation).resolves.toMatchObject({ revision: "8" });
    await vi.advanceTimersByTimeAsync(70_001);
    reply?.({ ok: true, value: { result: { saved: true }, revision: "8", replayed: false } });
    await settled;
  } finally {
    vi.useRealTimers();
  }
});
