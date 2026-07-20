import { describe, it, expect, vi } from "vitest";
import {
  decodeBridgeStoredValue,
  encodeBridgeStoredValue,
  handleBridgeMessage,
  buildBridgeScript,
  type BridgeMessage,
  type BridgeHandler,
} from "../../shell/src/lib/os-bridge.js";

function makeMessageEvent(data: BridgeMessage): MessageEvent {
  return new MessageEvent("message", { data });
}

describe("OS Bridge", () => {
  describe("bridge storage values", () => {
    it.each([
      ["ordinary text", "ordinary text"],
      ["3", "3"],
      [3, 3],
      [[{ id: "home" }], [{ id: "home" }]],
      [{ enabled: true }, { enabled: true }],
      [null, null],
    ])("round-trips %j without guessing JSON-looking strings", (value, expected) => {
      expect(decodeBridgeStoredValue(encodeBridgeStoredValue(value))).toEqual(expected);
    });

    it("leaves legacy untagged storage untouched", () => {
      expect(decodeBridgeStoredValue('{"items":[]}')).toBe('{"items":[]}');
    });
  });

  describe("handleBridgeMessage", () => {
    it("routes os:generate to kernel with app context prefix", () => {
      const handler: BridgeHandler = {
        sendToKernel: vi.fn(),
        fetchData: vi.fn(),
      };

      const event = makeMessageEvent({
        type: "os:generate",
        app: "expense-tracker",
        payload: { context: "show detail for item #3" },
      });

      handleBridgeMessage(event, handler);

      expect(handler.sendToKernel).toHaveBeenCalledWith(
        "[App: expense-tracker] show detail for item #3",
      );
    });

    it("routes os:navigate to kernel with route context", () => {
      const handler: BridgeHandler = {
        sendToKernel: vi.fn(),
        fetchData: vi.fn(),
      };

      const event = makeMessageEvent({
        type: "os:navigate",
        app: "notes",
        payload: { route: "/settings", context: "user wants settings page" },
      });

      handleBridgeMessage(event, handler);

      expect(handler.sendToKernel).toHaveBeenCalledWith(
        "[App: notes] Navigate to /settings: user wants settings page",
      );
    });

    it("routes os:navigate without optional context", () => {
      const handler: BridgeHandler = {
        sendToKernel: vi.fn(),
        fetchData: vi.fn(),
      };

      const event = makeMessageEvent({
        type: "os:navigate",
        app: "notes",
        payload: { route: "/home" },
      });

      handleBridgeMessage(event, handler);

      expect(handler.sendToKernel).toHaveBeenCalledWith(
        "[App: notes] Navigate to /home",
      );
    });

    it("routes os:read-data to fetchData", () => {
      const handler: BridgeHandler = {
        sendToKernel: vi.fn(),
        fetchData: vi.fn(),
      };

      const event = makeMessageEvent({
        type: "os:read-data",
        app: "expense-tracker",
        payload: { key: "expenses" },
      });

      handleBridgeMessage(event, handler);

      expect(handler.fetchData).toHaveBeenCalledWith(
        "read",
        "expense-tracker",
        "expenses",
        undefined,
      );
    });

    it("returns bridge data reads through the request message port", async () => {
      const postMessage = vi.fn();
      const close = vi.fn();
      const handler: BridgeHandler = {
        sendToKernel: vi.fn(),
        fetchData: vi.fn().mockResolvedValue('{"items":[]}'),
      };
      const event = {
        data: {
          type: "os:read-data",
          app: "expense-tracker",
          payload: { key: "expenses" },
        },
        ports: [{ postMessage, close }],
      } as unknown as MessageEvent;

      handleBridgeMessage(event, handler);

      await vi.waitFor(() => {
        expect(postMessage).toHaveBeenCalledWith({ ok: true, value: '{"items":[]}' });
      });
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("routes os:write-data to fetchData with value", () => {
      const handler: BridgeHandler = {
        sendToKernel: vi.fn(),
        fetchData: vi.fn(),
      };

      const event = makeMessageEvent({
        type: "os:write-data",
        app: "notes",
        payload: { key: "drafts", value: '{"items":[]}' },
      });

      handleBridgeMessage(event, handler);

      expect(handler.fetchData).toHaveBeenCalledWith(
        "write",
        "notes",
        "drafts",
        '{"items":[]}',
      );
    });

    it("ignores unknown message types", () => {
      const handler: BridgeHandler = {
        sendToKernel: vi.fn(),
        fetchData: vi.fn(),
      };

      const event = makeMessageEvent({
        type: "os:unknown" as BridgeMessage["type"],
        app: "test",
        payload: {},
      });

      handleBridgeMessage(event, handler);

      expect(handler.sendToKernel).not.toHaveBeenCalled();
      expect(handler.fetchData).not.toHaveBeenCalled();
    });

    it("ignores messages without os: prefix", () => {
      const handler: BridgeHandler = {
        sendToKernel: vi.fn(),
        fetchData: vi.fn(),
      };

      const event = new MessageEvent("message", {
        data: { type: "something-else", app: "test", payload: {} },
      });

      handleBridgeMessage(event, handler);

      expect(handler.sendToKernel).not.toHaveBeenCalled();
      expect(handler.fetchData).not.toHaveBeenCalled();
    });

    it("ignores non-object messages", () => {
      const handler: BridgeHandler = {
        sendToKernel: vi.fn(),
        fetchData: vi.fn(),
      };

      const event = new MessageEvent("message", { data: "just a string" });

      handleBridgeMessage(event, handler);

      expect(handler.sendToKernel).not.toHaveBeenCalled();
      expect(handler.fetchData).not.toHaveBeenCalled();
    });

    it("rejects bridge messages from unexpected windows when a source is required", () => {
      const handler: BridgeHandler = {
        sendToKernel: vi.fn(),
        fetchData: vi.fn(),
      };
      const expectedSource = {} as Window;
      const event = makeMessageEvent({
        type: "os:generate",
        app: "expense-tracker",
        payload: { context: "run hidden command" },
      });

      handleBridgeMessage(event, handler, {
        expectedSource,
        expectedOrigins: new Set(["null"]),
        expectedApp: "expense-tracker",
      });

      expect(handler.sendToKernel).not.toHaveBeenCalled();
    });

    it("rejects bridge messages whose app name does not match the iframe app", () => {
      const handler: BridgeHandler = {
        sendToKernel: vi.fn(),
        fetchData: vi.fn(),
      };
      const event = makeMessageEvent({
        type: "os:generate",
        app: "other-app",
        payload: { context: "run hidden command" },
      });

      handleBridgeMessage(event, handler, {
        expectedOrigins: new Set(["null"]),
        expectedApp: "expense-tracker",
      });

      expect(handler.sendToKernel).not.toHaveBeenCalled();
    });
  });

  describe("buildBridgeScript", () => {
    it("returns a string containing MatrixOS assignment", () => {
      const script = buildBridgeScript("my-app");
      expect(script).toContain("window.MatrixOS");
      expect(script).toContain("my-app");
    });

    it("includes generate function", () => {
      const script = buildBridgeScript("test-app");
      expect(script).toContain("generate");
    });

    it("includes navigate function", () => {
      const script = buildBridgeScript("test-app");
      expect(script).toContain("navigate");
    });

    it("includes readData and writeData", () => {
      const script = buildBridgeScript("test-app");
      expect(script).toContain("readData");
      expect(script).toContain("writeData");
      expect(script).toContain("reject(new Error(\"MatrixOS bridge data request failed\"))");
      expect(script).toContain("decodeStoredValue(e.data.value)");
      expect(script).toContain("encodeStoredValue(value)");
      expect(script).toContain("__matrix_os_value_v1__:");
    });

    it("exposes atomic bulk inserts to sandboxed apps", () => {
      const script = buildBridgeScript("clock");

      expect(script).toContain("bulkInsert: function(table, rows)");
      expect(script).toContain('action: "bulkInsert"');
      expect(script).toContain("appInfo: function()");
      expect(script).toContain('action: "appInfo"');
    });

    it("includes app metadata", () => {
      const script = buildBridgeScript("expense-tracker");
      expect(script).toContain("expense-tracker");
    });

    it("includes optional label forwarding in MatrixOS.service", () => {
      const script = buildBridgeScript("test-app");
      expect(script).toContain("service: function(service, action, params, label)");
      expect(script).toContain("label: label");
    });

    it("routes integration fetches through the parent bridge with timeouts", () => {
      const script = buildBridgeScript("test-app");
      expect(script).toContain('parentFetch("/api/bridge/service", {}, 10000)');
      expect(script).toContain("}, 35000).then");
      expect(script).toContain("gatewayFetch: function(url, init, timeoutMs)");
      expect(script).toContain("MatrixOS bridge fetch timed out");
    });

    it("accepts a design id and exposes it via MatrixOS.design and data-matrix-design", () => {
      const script = buildBridgeScript("test-app", undefined, "win11");
      expect(script).toContain("win11");
      expect(script).toContain("dataset.matrixDesign");
      expect(script).toContain("design: currentDesign");
    });
  });
});
