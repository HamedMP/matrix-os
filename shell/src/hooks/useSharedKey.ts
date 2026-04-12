import { useState, useEffect, useCallback } from "react";
import type { GroupBridgeInterface } from "../lib/group-bridge.js";

interface UseSharedKeyResult {
  value: unknown;
  setValue: (v: unknown) => void;
}

/**
 * Read/write a Y.Map("kv") entry from the group's mirror Y.Doc.
 * Re-renders when the key's value changes via remote updates.
 */
export function useSharedKey(bridge: GroupBridgeInterface | null, key: string): UseSharedKeyResult {
  const [value, setValue] = useState<unknown>(() => bridge?.shared.get(key));

  useEffect(() => {
    if (!bridge) return;
    // Sync current value on mount/key change
    setValue(bridge.shared.get(key));

    const unsub = bridge.shared.onChange(() => {
      setValue(bridge.shared.get(key));
    });
    return unsub;
  }, [bridge, key]);

  const set = useCallback(
    (v: unknown) => {
      if (!bridge) return;
      bridge.shared.set(key, v);
      setValue(v);
    },
    [bridge, key],
  );

  return { value, setValue: set };
}
