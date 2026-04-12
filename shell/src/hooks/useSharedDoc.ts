import { useState, useEffect } from "react";
import * as Y from "yjs";
import type { GroupBridgeInterface } from "../lib/group-bridge.js";

/**
 * Returns the mirror Y.Doc from the group bridge and re-renders on remote updates.
 * Returns null when no bridge or bridge has no group context.
 */
export function useSharedDoc(bridge: GroupBridgeInterface | null): Y.Doc | null {
  const doc = bridge?.shared.doc() ?? null;
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!bridge) return;
    const unsub = bridge.shared.onChange(() => {
      setTick((t) => t + 1);
    });
    return unsub;
  }, [bridge]);

  return doc;
}
