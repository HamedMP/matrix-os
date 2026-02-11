import { describe, it, expect, vi } from "vitest";
import {
  handleBridgeMessage,
  buildBridgeScript,
  type BridgeMessage,
  type BridgeHandler,
} from "../../shell/src/lib/os-bridge.js";

function makeMessageEvent(data: BridgeMessage): MessageEvent {
  return new MessageEvent("message", { data });
}

describe("OS Bridge", () => {
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
    });

    it("includes app metadata", () => {
      const script = buildBridgeScript("expense-tracker");
      expect(script).toContain("expense-tracker");
    });
  });
});
