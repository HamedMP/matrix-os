import { createContext, runInContext } from "node:vm";
import { buildBridgeScript } from "../../shell/src/lib/os-bridge";
import { describe, expect, it } from "vitest";
import { prepareBridgeFetchRequest } from "../../shell/src/components/app-viewer-bridge-request";

describe("gallery requests through the shared app viewer", () => {
  it("preserves an install POST while authorizing its actual method", () => {
    const request = prepareBridgeFetchRequest("app-gallery", {
      url: "/api/app-gallery/folio/install",
      init: { method: "post", body: "{}", headers: { "Content-Type": "application/json" } },
    });
    expect(request.url).toBe("/api/app-gallery/folio/install");
    expect(request.init.method).toBe("POST");
    expect(request.init.body).toBe("{}");
  });
  it("blocks a service execution POST even when inventory GET is allowed", () => {
    expect(() => prepareBridgeFetchRequest("app-gallery", {
      url: "/api/integrations", init: { method: "POST", body: "{}" },
    })).toThrow("Blocked bridge fetch URL");
    expect(prepareBridgeFetchRequest("app-gallery", { url: "/api/integrations" }).init.method).toBe("GET");
  });
  it("blocks unsupported and malformed methods before dispatch", () => {
    for (const method of ["DELETE", 7, null, {}]) {
      expect(() => prepareBridgeFetchRequest("app-gallery", {
        url: "/api/app-gallery", init: { method },
      })).toThrow();
    }
  });
});


describe("gallery coexistence with the current app capability host", () => {
  it("binds the trusted identity after method authorization", () => {
    const request = prepareBridgeFetchRequest("tools/drive-chat", {
      url: "/api/bridge/capabilities",
      init: { method: "post", body: JSON.stringify({ kind: "integrations.list", app: "subscriptions" }) },
    });
    expect(JSON.parse(request.init.body as string)).toEqual({ app: "tools/drive-chat", input: { kind: "integrations.list" } });
  });
  it("binds database identity rather than accepting an app hint", () => {
    const request = prepareBridgeFetchRequest("games/chess", {
      url: "/api/bridge/query",
      init: { method: "POST", body: JSON.stringify({ app: "notes", action: "find", table: "scores" }) },
    });
    expect(JSON.parse(request.init.body as string).app).toBe("games/chess");
  });
});


it("runs canonical starter inventory through the same parent broker without app credentials", async () => {
  const requests: string[] = [];
  class Channel {
    port1: any = { close() {}, onmessage: null };
    port2: any = { close() {}, postMessage: (data: unknown) => this.port1.onmessage({ data }) };
  }
  const context = createContext({
    MessageChannel: Channel, setTimeout, clearTimeout,
    document: { documentElement: { dataset: {} }, createElement: () => ({}), head: { appendChild() {} } },
    window: { addEventListener() {}, parent: { postMessage(message: any, _origin: unknown, ports: any[]) {
      const bound = prepareBridgeFetchRequest("subscriptions", message.payload);
      requests.push(bound.url);
      ports[0].postMessage({ ok: true, body: [{ service: "gmail", account_label: "personal", status: "active" }] });
    } } },
  });
  runInContext(buildBridgeScript("subscriptions"), context);
  expect(await runInContext("window.MatrixOS.integrations()", context)).toEqual([{ service: "gmail", account_label: "personal", status: "active" }]);
  expect(requests).toEqual(["/api/integrations"]);
});
