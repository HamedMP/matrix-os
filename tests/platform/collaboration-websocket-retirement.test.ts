import { describe, expect, it } from "vitest";
import { isCollaborationWebSocketCandidate, parseRelaySocketPath } from "../../packages/platform/src/collaboration/relay.js";

const scopeId = "10000000-0000-4000-8000-000000000001";

describe("collaboration WebSocket route retirement", () => {
  it("accepts only the direct relay path and rejects legacy or malformed collaboration upgrades", () => {
    const direct = `/ws/collaboration/direct/scopes/${scopeId}/events?ticket=valid`;
    expect(isCollaborationWebSocketCandidate(direct)).toBe(true);
    expect(parseRelaySocketPath(direct)).toMatchObject({ scopeId, purpose: "events" });
    for (const retired of [
      `/ws/collaboration/scopes/${scopeId}/events?ticket=legacy`,
      `/ws/collaboration/scopes/${scopeId}/terminal`,
      `/ws/collaboration/direct/scopes/${scopeId}/events/extra?ticket=valid`,
    ]) {
      expect(isCollaborationWebSocketCandidate(retired)).toBe(true);
      expect(parseRelaySocketPath(retired)).toBeNull();
    }
    expect(isCollaborationWebSocketCandidate("/ws/terminal/tab?token=personal")).toBe(false);
    expect(parseRelaySocketPath("/ws/terminal/tab?token=personal")).toBeNull();
  });
});
