// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { buildAuthenticatedWebSocketUrl } = vi.hoisted(() => ({
  buildAuthenticatedWebSocketUrl: vi.fn<() => Promise<string>>(),
}));

vi.mock("@/lib/websocket-auth", () => ({
  buildAuthenticatedWebSocketUrl,
}));

vi.mock("@/lib/gateway", () => ({
  getGatewayUrl: () => "http://gateway.test",
  getGatewayWs: () => "ws://gateway.test/ws",
}));

import { IntegrationsSection } from "../../shell/src/components/settings/sections/IntegrationsSection.js";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("IntegrationsSection websocket lifecycle", () => {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/integrations/available")) {
      return Promise.resolve({ ok: true, json: async () => ({ services: [] }) });
    }
    if (url.includes("/api/integrations")) {
      return Promise.resolve({ ok: true, json: async () => ({ connections: [] }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });

  beforeEach(() => {
    fetchMock.mockClear();
    buildAuthenticatedWebSocketUrl.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not open a websocket after unmount when the authenticated URL resolves late", async () => {
    const deferred = createDeferred<string>();
    const webSocketCtor = vi.fn(function WebSocketMock(this: { close: ReturnType<typeof vi.fn> }) {
      this.close = vi.fn();
    });
    buildAuthenticatedWebSocketUrl.mockReturnValueOnce(deferred.promise);
    vi.stubGlobal("WebSocket", webSocketCtor as unknown as typeof WebSocket);

    const { unmount } = render(<IntegrationsSection />);

    await act(async () => {
      await Promise.resolve();
    });

    unmount();

    await act(async () => {
      deferred.resolve("ws://gateway.test/ws?token=late");
      await deferred.promise;
      await Promise.resolve();
    });

    expect(webSocketCtor).not.toHaveBeenCalled();
  });
});
