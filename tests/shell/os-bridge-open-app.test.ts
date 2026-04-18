import { describe, it, expect, vi } from "vitest";
import {
  handleBridgeMessage,
  buildBridgeScript,
  type BridgeHandler,
} from "../../shell/src/lib/os-bridge.js";

function makeMessageEvent(data: Record<string, unknown>): MessageEvent {
  return new MessageEvent("message", { data });
}

describe("OS Bridge - openApp (T2060)", () => {
  describe("handleBridgeMessage", () => {
    it("routes os:open-app to openApp handler", () => {
      const handler: BridgeHandler = {
        sendToKernel: vi.fn(),
        fetchData: vi.fn(),
        openApp: vi.fn(),
      };

      const event = makeMessageEvent({
        type: "os:open-app",
        app: "game-center",
        payload: { name: "Snake", path: "apps/games/snake/index.html" },
      });

      handleBridgeMessage(event, handler);

      expect(handler.openApp).toHaveBeenCalledWith(
        "Snake",
        "apps/games/snake/index.html",
      );
    });

    it("does not call openApp if handler has no openApp", () => {
      const handler: BridgeHandler = {
        sendToKernel: vi.fn(),
        fetchData: vi.fn(),
      };

      const event = makeMessageEvent({
        type: "os:open-app",
        app: "game-center",
        payload: { name: "Snake", path: "apps/games/snake/index.html" },
      });

      // Should not throw
      handleBridgeMessage(event, handler);

      expect(handler.sendToKernel).not.toHaveBeenCalled();
      expect(handler.fetchData).not.toHaveBeenCalled();
    });

    it("strips leading /files/ prefix from path (spec 063 regression)", () => {
      const handler: BridgeHandler = {
        sendToKernel: vi.fn(),
        fetchData: vi.fn(),
        openApp: vi.fn(),
      };

      const event = makeMessageEvent({
        type: "os:open-app",
        app: "game-center",
        payload: {
          name: "2048",
          path: "/files/apps/games/2048/index.html",
        },
      });

      handleBridgeMessage(event, handler);

      expect(handler.openApp).toHaveBeenCalledWith(
        "2048",
        "apps/games/2048/index.html",
      );
    });

    it("leaves paths without /files/ prefix unchanged", () => {
      const handler: BridgeHandler = {
        sendToKernel: vi.fn(),
        fetchData: vi.fn(),
        openApp: vi.fn(),
      };

      const event = makeMessageEvent({
        type: "os:open-app",
        app: "launcher",
        payload: { name: "Snake", path: "apps/snake/index.html" },
      });

      handleBridgeMessage(event, handler);

      expect(handler.openApp).toHaveBeenCalledWith(
        "Snake",
        "apps/snake/index.html",
      );
    });

    it("ignores os:open-app with missing payload fields", () => {
      const handler: BridgeHandler = {
        sendToKernel: vi.fn(),
        fetchData: vi.fn(),
        openApp: vi.fn(),
      };

      const event = makeMessageEvent({
        type: "os:open-app",
        app: "game-center",
        payload: { name: "Snake" },
      });

      handleBridgeMessage(event, handler);

      expect(handler.openApp).not.toHaveBeenCalled();
    });
  });

  describe("buildBridgeScript", () => {
    it("includes openApp function", () => {
      const script = buildBridgeScript("test-app");
      expect(script).toContain("openApp");
    });

    it("openApp sends os:open-app message type", () => {
      const script = buildBridgeScript("test-app");
      expect(script).toContain("os:open-app");
    });
  });
});
