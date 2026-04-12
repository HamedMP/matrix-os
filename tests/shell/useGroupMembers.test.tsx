// @vitest-environment jsdom

/**
 * Tests for useGroupMembers React hook (T077).
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGroupMembers } from "../../shell/src/hooks/useGroupMembers.js";
import type { GroupBridgeInterface, GroupMember, PresenceInfo, GroupContextLive } from "../../shell/src/lib/group-bridge.js";

// ---------------------------------------------------------------------------
// Fake bridge helpers
// ---------------------------------------------------------------------------

interface FakeMembersState {
  members: GroupMember[];
  presenceListeners: Set<(info: PresenceInfo) => void>;
  membersListeners: Set<() => void>;
}

function makeFakeBridgeWithMembers(initialMembers: GroupMember[] = []): {
  bridge: GroupBridgeInterface;
  state: FakeMembersState;
  triggerMembersChanged: (members: GroupMember[]) => void;
  triggerPresenceChanged: (info: PresenceInfo) => void;
} {
  const state: FakeMembersState = {
    members: [...initialMembers],
    presenceListeners: new Set(),
    membersListeners: new Set(),
  };

  const group: GroupContextLive = {
    id: "!abc:matrix-os.com",
    slug: "fam",
    name: "Fam",
    me: { handle: "@alice:matrix-os.com", role: "owner" },
    get members() { return state.members; },
    onPresence(cb: (info: PresenceInfo) => void): () => void {
      state.presenceListeners.add(cb);
      return () => state.presenceListeners.delete(cb);
    },
  };

  const bridge: GroupBridgeInterface = {
    shared: {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      doc: vi.fn(),
      onChange: (cb) => {
        state.membersListeners.add(cb);
        return () => state.membersListeners.delete(cb);
      },
      onError: () => () => undefined,
    },
    group,
  };

  function triggerMembersChanged(newMembers: GroupMember[]) {
    state.members.length = 0;
    state.members.push(...newMembers);
    // Notify via onChange (members update goes through same channel)
    for (const cb of state.membersListeners) {
      try { cb(); } catch { /* ignore */ }
    }
  }

  function triggerPresenceChanged(info: PresenceInfo) {
    for (const cb of state.presenceListeners) {
      try { cb(info); } catch { /* ignore */ }
    }
  }

  return { bridge, state, triggerMembersChanged, triggerPresenceChanged };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useGroupMembers", () => {
  it("returns empty members and empty presenceByHandle when bridge is null", () => {
    const { result } = renderHook(() => useGroupMembers(null));
    expect(result.current.members).toEqual([]);
    expect(result.current.presenceByHandle).toEqual({});
  });

  it("returns empty members when group is null", () => {
    const bridge: GroupBridgeInterface = {
      shared: {
        get: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
        list: vi.fn().mockReturnValue([]),
        doc: vi.fn(),
        onChange: () => () => undefined,
        onError: () => () => undefined,
      },
      group: null,
    };

    const { result } = renderHook(() => useGroupMembers(bridge));
    expect(result.current.members).toEqual([]);
  });

  it("returns initial members from group.members", () => {
    const initialMembers: GroupMember[] = [
      { handle: "@alice:matrix-os.com", role: "owner", online: true },
      { handle: "@bob:matrix-os.com", role: "editor", online: false },
    ];
    const { bridge } = makeFakeBridgeWithMembers(initialMembers);

    const { result } = renderHook(() => useGroupMembers(bridge));
    expect(result.current.members).toHaveLength(2);
    expect(result.current.members[0]!.handle).toBe("@alice:matrix-os.com");
  });

  it("re-renders when members list changes", () => {
    const { bridge, triggerMembersChanged } = makeFakeBridgeWithMembers([
      { handle: "@alice:matrix-os.com", role: "owner", online: true },
    ]);

    const { result } = renderHook(() => useGroupMembers(bridge));
    expect(result.current.members).toHaveLength(1);

    act(() => {
      triggerMembersChanged([
        { handle: "@alice:matrix-os.com", role: "owner", online: true },
        { handle: "@carol:matrix-os.com", role: "viewer", online: true },
      ]);
    });

    expect(result.current.members).toHaveLength(2);
  });

  it("updates presenceByHandle when presence_changed fires", () => {
    const { bridge, triggerPresenceChanged } = makeFakeBridgeWithMembers([
      { handle: "@alice:matrix-os.com", role: "owner", online: true },
    ]);

    const { result } = renderHook(() => useGroupMembers(bridge));

    act(() => {
      triggerPresenceChanged({
        handle: "@alice:matrix-os.com",
        status: "offline",
        last_active_ago: 5000,
      });
    });

    expect(result.current.presenceByHandle["@alice:matrix-os.com"]).toMatchObject({
      status: "offline",
      last_active_ago: 5000,
    });
  });

  it("re-renders when presence changes", () => {
    const { bridge, triggerPresenceChanged } = makeFakeBridgeWithMembers([
      { handle: "@alice:matrix-os.com", role: "owner", online: true },
    ]);

    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount++;
      return useGroupMembers(bridge);
    });

    const before = renderCount;

    act(() => {
      triggerPresenceChanged({
        handle: "@alice:matrix-os.com",
        status: "offline",
        last_active_ago: 1000,
      });
    });

    expect(renderCount).toBeGreaterThan(before);
  });

  it("cleans up subscriptions on unmount", () => {
    const { bridge, state } = makeFakeBridgeWithMembers([]);

    const { unmount } = renderHook(() => useGroupMembers(bridge));

    // Both onChange (for members) and onPresence subscriptions active
    expect(state.membersListeners.size).toBe(1);
    expect(state.presenceListeners.size).toBe(1);

    unmount();

    expect(state.membersListeners.size).toBe(0);
    expect(state.presenceListeners.size).toBe(0);
  });
});
