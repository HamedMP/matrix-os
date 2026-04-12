// @vitest-environment jsdom

/**
 * Tests for useSharedDoc + useSharedKey React hooks (T045/T051/T052).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import * as Y from "yjs";
import { useSharedDoc } from "../../shell/src/hooks/useSharedDoc.js";
import { useSharedKey } from "../../shell/src/hooks/useSharedKey.js";
import type { GroupBridgeInterface, SharedInterface, GroupContextLive } from "../../shell/src/lib/group-bridge.js";

// ---------------------------------------------------------------------------
// Fake bridge for hook tests
// ---------------------------------------------------------------------------

function makeFakeBridge(): {
  bridge: GroupBridgeInterface;
  doc: Y.Doc;
  triggerChange: () => void;
} {
  const doc = new Y.Doc();
  const kvMap = doc.getMap<unknown>("kv");
  const changeListeners = new Set<() => void>();

  const shared: SharedInterface = {
    get(key: string) { return kvMap.get(key); },
    set(key: string, value: unknown) { kvMap.set(key, value); },
    delete(key: string) { kvMap.delete(key); },
    list() { return Array.from(kvMap.keys()); },
    doc() { return doc; },
    onChange(cb: () => void) {
      changeListeners.add(cb);
      return () => changeListeners.delete(cb);
    },
    onError(_cb) { return () => undefined; },
  };

  const group: GroupContextLive = {
    id: "!abc:matrix-os.com",
    slug: "fam",
    name: "Fam",
    me: { handle: "@alice:matrix-os.com", role: "owner" },
    members: [],
  };

  const bridge: GroupBridgeInterface = { shared, group };

  function triggerChange() {
    for (const cb of changeListeners) {
      try { cb(); } catch { /* ignore */ }
    }
  }

  return { bridge, doc, triggerChange };
}

// ---------------------------------------------------------------------------
// Tests for useSharedDoc
// ---------------------------------------------------------------------------

describe("useSharedDoc", () => {
  it("returns the mirror Y.Doc from the bridge", () => {
    const { bridge, doc } = makeFakeBridge();
    const { result } = renderHook(() => useSharedDoc(bridge));

    expect(result.current).toBe(doc);
    expect(result.current).toBeInstanceOf(Y.Doc);
  });

  it("re-renders when remote update arrives (onChange fires)", async () => {
    const { bridge, doc, triggerChange } = makeFakeBridge();
    let renderCount = 0;

    const { result } = renderHook(() => {
      renderCount++;
      return useSharedDoc(bridge);
    });

    const initialRenderCount = renderCount;

    act(() => {
      // Simulate remote update on the doc
      doc.getMap("kv").set("remote", "value");
      triggerChange();
    });

    expect(renderCount).toBeGreaterThan(initialRenderCount);
  });

  it("cleans up onChange subscription on unmount", () => {
    const changeListeners = new Set<() => void>();
    const doc = new Y.Doc();

    const bridgeWithSpy: GroupBridgeInterface = {
      shared: {
        get: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
        list: vi.fn().mockReturnValue([]),
        doc: () => doc,
        onChange: (cb) => {
          changeListeners.add(cb);
          return () => changeListeners.delete(cb);
        },
        onError: (_cb) => () => undefined,
      },
      group: null,
    };

    const { unmount } = renderHook(() => useSharedDoc(bridgeWithSpy));
    expect(changeListeners.size).toBe(1);

    unmount();
    expect(changeListeners.size).toBe(0);
  });

  it("returns null/undefined when bridge is null", () => {
    const { result } = renderHook(() => useSharedDoc(null));
    expect(result.current).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests for useSharedKey
// ---------------------------------------------------------------------------

describe("useSharedKey", () => {
  it("returns current value from Y.Map kv", () => {
    const { bridge, doc } = makeFakeBridge();
    doc.getMap("kv").set("mykey", "myval");

    const { result } = renderHook(() => useSharedKey(bridge, "mykey"));
    expect(result.current.value).toBe("myval");
  });

  it("setValue updates the Y.Map kv entry", () => {
    const { bridge } = makeFakeBridge();

    const { result } = renderHook(() => useSharedKey(bridge, "counter"));

    act(() => {
      result.current.setValue(42);
    });

    expect(result.current.value).toBe(42);
  });

  it("re-renders when the key changes via remote update", () => {
    const { bridge, doc, triggerChange } = makeFakeBridge();

    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount++;
      return useSharedKey(bridge, "x");
    });

    const initial = renderCount;

    act(() => {
      doc.getMap("kv").set("x", "new-value");
      triggerChange();
    });

    expect(renderCount).toBeGreaterThan(initial);
    expect(result.current.value).toBe("new-value");
  });

  it("cleans up onChange subscription on unmount", () => {
    const changeListeners = new Set<() => void>();
    const doc = new Y.Doc();

    const bridge: GroupBridgeInterface = {
      shared: {
        get: (key) => doc.getMap("kv").get(key),
        set: (key, val) => { doc.getMap("kv").set(key, val); },
        delete: (key) => { doc.getMap("kv").delete(key); },
        list: () => Array.from(doc.getMap("kv").keys()),
        doc: () => doc,
        onChange: (cb) => {
          changeListeners.add(cb);
          return () => changeListeners.delete(cb);
        },
        onError: (_cb) => () => undefined,
      },
      group: null,
    };

    const { unmount } = renderHook(() => useSharedKey(bridge, "key"));
    expect(changeListeners.size).toBe(1);

    unmount();
    expect(changeListeners.size).toBe(0);
  });
});
