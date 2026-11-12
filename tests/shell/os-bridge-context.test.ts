// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { buildBridgeScript } from "../../shell/src/lib/os-bridge.js";

describe("owner collaboration participant bridge", () => {
  it("accepts parent updates without replacing the iframe or accepting another sender", () => {
    new Function(buildBridgeScript("tracker"))();
    const bridge = (window as unknown as { MatrixOS: {
      collaboration: { participant: { actorId: string; scopeId?: string } | null; onChange(listener: () => void): () => void };
    } }).MatrixOS;
    const onChange = vi.fn();
    bridge.collaboration.onChange(onChange);
    expect(bridge.collaboration.participant).toBeNull();

    const participant = {
      actorId: "user_owner",
      displayName: "Nima",
      organizationId: "org_matrix_team",
      scopeId: "10000000-0000-4000-8000-000000000001",
      shareRevision: "1",
      buildId: "b".repeat(64),
    };
    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "os:collaboration-context", participant }, source: null,
    }));
    expect(bridge.collaboration.participant).toBeNull();

    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "os:collaboration-context", participant }, source: window.parent,
    }));
    expect(bridge.collaboration.participant).toMatchObject(participant);
    expect(Object.isFrozen(bridge.collaboration.participant)).toBe(true);
    expect(onChange).toHaveBeenCalledOnce();
  });
});
