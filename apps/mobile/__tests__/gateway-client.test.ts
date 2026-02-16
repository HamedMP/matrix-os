import { GatewayClient } from "../lib/gateway-client";

describe("GatewayClient", () => {
  it("initializes with disconnected state", () => {
    const client = new GatewayClient("http://localhost:4000");
    expect(client.connectionState).toBe("disconnected");
  });

  it("derives HTTP URL correctly", () => {
    const client = new GatewayClient("http://localhost:4000");
    expect(client.httpUrl).toBe("http://localhost:4000");
  });

  it("derives WS URL correctly", () => {
    const client = new GatewayClient("http://localhost:4000");
    expect(client.wsUrl).toBe("ws://localhost:4000/ws");
  });

  it("converts https to wss", () => {
    const client = new GatewayClient("https://my.gateway.com");
    expect(client.wsUrl).toBe("wss://my.gateway.com/ws");
  });

  it("strips trailing slashes from base URL", () => {
    const client = new GatewayClient("http://localhost:4000///");
    expect(client.httpUrl).toBe("http://localhost:4000");
  });

  it("registers message handlers", () => {
    const client = new GatewayClient("http://localhost:4000");
    const handler = jest.fn();
    const unsub = client.onMessage(handler);
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("registers state change handlers", () => {
    const client = new GatewayClient("http://localhost:4000");
    const handler = jest.fn();
    const unsub = client.onStateChange(handler);
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("unsubscribes message handlers", () => {
    const client = new GatewayClient("http://localhost:4000");
    const handler = jest.fn();
    const unsub = client.onMessage(handler);
    unsub();
    // handler should no longer be registered
  });
});
