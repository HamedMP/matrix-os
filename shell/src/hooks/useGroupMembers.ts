import { useState, useEffect } from "react";
import type { GroupBridgeInterface, GroupMember, PresenceInfo } from "../lib/group-bridge.js";

interface UseGroupMembersResult {
  members: GroupMember[];
  presenceByHandle: Record<string, PresenceInfo>;
}

/**
 * Returns the live member list and per-handle presence info for the current group.
 * Re-renders when members change or presence updates arrive.
 * Cleans up all subscriptions on unmount.
 */
export function useGroupMembers(bridge: GroupBridgeInterface | null): UseGroupMembersResult {
  const [members, setMembers] = useState<GroupMember[]>(() => {
    return bridge?.group?.members ? [...bridge.group.members] : [];
  });

  const [presenceByHandle, setPresenceByHandle] = useState<Record<string, PresenceInfo>>({});

  useEffect(() => {
    if (!bridge?.group) return;

    // Sync current member list
    setMembers([...bridge.group.members]);

    // Subscribe to member list changes via shared.onChange
    // (group-bridge updates liveMembers on members_changed and emits change)
    const unsubMembers = bridge.shared.onChange(() => {
      setMembers([...bridge.group!.members]);
    });

    // Subscribe to presence updates
    const unsubPresence = bridge.group.onPresence((info: PresenceInfo) => {
      setPresenceByHandle((prev) => ({
        ...prev,
        [info.handle]: info,
      }));
      // Also update members online status
      setMembers([...bridge.group!.members]);
    });

    return () => {
      unsubMembers();
      unsubPresence();
    };
  }, [bridge]);

  return { members, presenceByHandle };
}
