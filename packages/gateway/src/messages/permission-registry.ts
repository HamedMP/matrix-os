import type { HermesPermission } from "./schemas.js";

export interface PermissionReadContext {
  mentionsOwner?: boolean;
}

export interface PermissionRegistry {
  canRead(ownerId: string, roomId: string, context?: PermissionReadContext): boolean;
  canReply(ownerId: string, roomId: string): boolean;
  canAutomate(ownerId: string, roomId: string): boolean;
}

export function createPermissionRegistry(
  resolvePermission: (ownerId: string, roomId: string) => HermesPermission | null,
): PermissionRegistry {
  function get(ownerId: string, roomId: string): HermesPermission | null {
    const permission = resolvePermission(ownerId, roomId);
    if (!permission || permission.ownerId !== ownerId || permission.roomId !== roomId) return null;
    return permission;
  }

  return {
    canRead(ownerId, roomId, context = {}) {
      const permission = get(ownerId, roomId);
      if (!permission?.readEnabled) return false;
      if (permission.mentionOnly && !context.mentionsOwner) return false;
      return true;
    },
    canReply(ownerId, roomId) {
      const permission = get(ownerId, roomId);
      return Boolean(permission?.replyEnabled);
    },
    canAutomate(ownerId, roomId) {
      const permission = get(ownerId, roomId);
      return Boolean(permission?.automationEnabled);
    },
  };
}

export function canDeliverToHermes(permission: HermesPermission | null, context: PermissionReadContext = {}): boolean {
  if (!permission?.readEnabled) return false;
  if (permission.mentionOnly && !context.mentionsOwner) return false;
  return true;
}
