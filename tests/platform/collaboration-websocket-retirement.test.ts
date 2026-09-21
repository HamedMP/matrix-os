import { describe, expect, it } from "vitest";
import { classifyCollaborationWebSocketPath } from "../../packages/platform/src/platform-websocket-upgrade.js";

const scopeId = "10000000-0000-4000-8000-000000000001";

describe("collaboration WebSocket route retirement", () => {
  it("accepts only the direct relay path and rejects legacy or malformed collaboration upgrades", () => {
    expect(classifyCollaborationWebSocketPath(`/ws/collaboration/direct/scopes/${scopeId}/events?ticket=valid`)).toBe("direct");
    expect(classifyCollaborationWebSocketPath(`/ws/collaboration/scopes/${scopeId}/events?ticket=legacy`)).toBe("retired");
    expect(classifyCollaborationWebSocketPath(`/ws/collaboration/scopes/${scopeId}/terminal`)).toBe("retired");
    expect(classifyCollaborationWebSocketPath(`/ws/collaboration/direct/scopes/${scopeId}/events/extra?ticket=valid`)).toBe("retired");
    expect(classifyCollaborationWebSocketPath(`/ws/terminal/tab?token=personal`)).toBe("other");
  });
});
