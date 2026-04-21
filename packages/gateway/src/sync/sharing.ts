import type { PeerRegistry } from "./ws-events.js";
import type { ShareRole } from "./types.js";
import { resolveWithinPrefix } from "./path-validation.js";

// ---------------------------------------------------------------------------
// DB interface (for testability without real Postgres)
// ---------------------------------------------------------------------------

export interface ShareRow {
  id: string;
  owner_id: string;
  path: string;
  grantee_id: string;
  role: ShareRole;
  accepted: boolean;
  created_at: Date;
  expires_at: Date | null;
}

export interface SharingDb {
  insertShare(input: {
    owner_id: string;
    path: string;
    grantee_id: string;
    role: ShareRole;
    expires_at?: string;
  }): Promise<ShareRow>;
  getShare(shareId: string): Promise<ShareRow | null>;
  updateShareAccepted(shareId: string, accepted: boolean): Promise<void>;
  deleteShare(shareId: string): Promise<void>;
  listSharesByOwner(ownerId: string): Promise<ShareRow[]>;
  listSharesByGrantee(granteeId: string): Promise<ShareRow[]>;
  listSharesByGranteeAndOwner(granteeId: string, ownerId: string): Promise<ShareRow[]>;
  resolveHandle(handle: string): Promise<string | null>;
  resolveUserId(userId: string): Promise<string | null>;
  resolveUserIds(userIds: string[]): Promise<Map<string, string>>;
  runInTransaction?<T>(fn: (db: SharingDb) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface CreateShareInput {
  path: string;
  granteeHandle: string;
  role: ShareRole;
  expiresAt?: string;
}

export interface CreateShareResult {
  shareId: string;
  path: string;
  granteeHandle: string;
  role: string;
}

export interface AcceptShareResult {
  accepted: true;
  path: string;
  ownerHandle: string;
}

export interface ListSharesResult {
  owned: Array<{
    id: string;
    path: string;
    granteeHandle: string;
    role: string;
    accepted: boolean;
    createdAt: string;
    expiresAt: string | null;
  }>;
  received: Array<{
    id: string;
    path: string;
    ownerHandle: string;
    role: string;
    accepted: boolean;
    createdAt: string;
    expiresAt: string | null;
  }>;
}

export interface SharingService {
  createShare(ownerId: string, input: CreateShareInput): Promise<CreateShareResult>;
  acceptShare(callerId: string, shareId: string): Promise<AcceptShareResult>;
  revokeShare(callerId: string, shareId: string): Promise<void>;
  listShares(userId: string): Promise<ListSharesResult>;
  checkSharePermission(
    ownerId: string,
    callerId: string,
    filePath: string,
    action: "get" | "put" | "delete",
  ): Promise<null | "forbidden">;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ShareNotFoundError extends Error {
  constructor(shareId: string) {
    super(`Share not found: ${shareId}`);
    this.name = "ShareNotFoundError";
  }
}

export class ShareSelfError extends Error {
  constructor() {
    super("Cannot share with self");
    this.name = "ShareSelfError";
  }
}

export class ShareDuplicateError extends Error {
  constructor() {
    super("Share already exists for this owner, path, and grantee");
    this.name = "ShareDuplicateError";
  }
}

export class ShareInvalidPathError extends Error {
  constructor(path: string) {
    super(`Invalid share path: ${path}`);
    this.name = "ShareInvalidPathError";
  }
}

export class ShareForbiddenError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ShareForbiddenError";
  }
}

export class GranteeNotFoundError extends Error {
  constructor(handle: string) {
    super(`Grantee not found: ${handle}`);
    this.name = "GranteeNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Role permission matrix
// ---------------------------------------------------------------------------

const ROLE_PERMISSIONS: Record<ShareRole, Set<string>> = {
  viewer: new Set(["get"]),
  editor: new Set(["get", "put"]),
  admin: new Set(["get", "put", "delete"]),
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSharingService(deps: {
  db: SharingDb;
  peerRegistry: PeerRegistry;
}): SharingService {
  const { db, peerRegistry } = deps;
  const withTransaction = async <T>(fn: (txDb: SharingDb) => Promise<T>): Promise<T> => {
    if (db.runInTransaction) {
      return db.runInTransaction(fn);
    }
    return fn(db);
  };

  function normalizeSharedPath(ownerId: string, path: string): string | null {
    const checked = resolveWithinPrefix(ownerId, path);
    if (!checked.valid) {
      return null;
    }
    return checked.key.slice(`matrixos-sync/${ownerId}/files/`.length);
  }

  function shareMatchesPath(sharePath: string, filePath: string): boolean {
    const normalizedSharePath = sharePath.replace(/\/+/g, "/").replace(/\/$/, "");
    const normalizedFilePath = filePath.replace(/\/+/g, "/").replace(/\/$/, "");
    return (
      normalizedFilePath === normalizedSharePath ||
      normalizedFilePath.startsWith(`${normalizedSharePath}/`)
    );
  }

  return {
    async createShare(ownerId, input) {
      const pathCheck = resolveWithinPrefix(ownerId, input.path);
      if (!pathCheck.valid) {
        throw new ShareInvalidPathError(input.path);
      }
      const normalizedPath = input.path.replace(/\/+/g, "/").replace(/\/$/, "");

      // Resolve grantee handle to user ID
      const granteeId = await db.resolveHandle(input.granteeHandle);
      if (!granteeId) {
        throw new GranteeNotFoundError(input.granteeHandle);
      }

      // Self-share check
      if (granteeId === ownerId) {
        throw new ShareSelfError();
      }

      let row: ShareRow;
      try {
        row = await db.insertShare({
          owner_id: ownerId,
          path: normalizedPath,
          grantee_id: granteeId,
          role: input.role,
          expires_at: input.expiresAt,
        });
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && (err as any).code === "23505") {
          throw new ShareDuplicateError();
        }
        throw err;
      }

      // Broadcast invite to grantee via WS
      const ownerHandle = await db.resolveUserId(ownerId);
      peerRegistry.sendToUser(granteeId, {
        type: "sync:share-invite",
        shareId: row.id,
        ownerHandle: ownerHandle ?? ownerId,
        path: row.path,
        role: input.role,
      });

      return {
        shareId: row.id,
        path: row.path,
        granteeHandle: input.granteeHandle,
        role: row.role,
      };
    },

    async acceptShare(callerId, shareId) {
      return withTransaction(async (txDb) => {
        const share = await txDb.getShare(shareId);
        if (!share) {
          throw new ShareNotFoundError(shareId);
        }

        if (share.grantee_id !== callerId) {
          throw new ShareForbiddenError("Not the grantee of this share");
        }

        await txDb.updateShareAccepted(shareId, true);

        const ownerHandle = await txDb.resolveUserId(share.owner_id);

        return {
          accepted: true as const,
          path: share.path,
          ownerHandle: ownerHandle ?? share.owner_id,
        };
      });
    },

    async revokeShare(callerId, shareId) {
      const result = await withTransaction(async (txDb) => {
        const share = await txDb.getShare(shareId);
        if (!share) {
          throw new ShareNotFoundError(shareId);
        }

        if (share.owner_id !== callerId) {
          throw new ShareForbiddenError("Not the owner of this share");
        }

        await txDb.deleteShare(shareId);

        const ownerHandle = await txDb.resolveUserId(callerId);
        return {
          granteeId: share.grantee_id,
          ownerHandle: ownerHandle ?? callerId,
          path: share.path,
        };
      });

      // Broadcast access-revoked to grantee
      peerRegistry.sendToUser(result.granteeId, {
        type: "sync:access-revoked",
        shareId,
        ownerHandle: result.ownerHandle,
        path: result.path,
      });
    },

    async listShares(userId) {
      const [ownedRows, receivedRows] = await Promise.all([
        db.listSharesByOwner(userId),
        db.listSharesByGrantee(userId),
      ]);
      const handleMap = await db.resolveUserIds(
        Array.from(
          new Set([
            ...ownedRows.map((row) => row.grantee_id),
            ...receivedRows.map((row) => row.owner_id),
          ]),
        ),
      );

      const owned = await Promise.all(
        ownedRows.map(async (row) => {
          const granteeHandle = handleMap.get(row.grantee_id);
          return {
            id: row.id,
            path: row.path,
            granteeHandle: granteeHandle ?? row.grantee_id,
            role: row.role,
            accepted: row.accepted,
            createdAt: row.created_at.toISOString(),
            expiresAt: row.expires_at?.toISOString() ?? null,
          };
        }),
      );

      const received = await Promise.all(
        receivedRows.map(async (row) => {
          const ownerHandle = handleMap.get(row.owner_id);
          return {
            id: row.id,
            path: row.path,
            ownerHandle: ownerHandle ?? row.owner_id,
            role: row.role,
            accepted: row.accepted,
            createdAt: row.created_at.toISOString(),
            expiresAt: row.expires_at?.toISOString() ?? null,
          };
        }),
      );

      return { owned, received };
    },

    async checkSharePermission(ownerId, callerId, filePath, action) {
      // Owner always has full access
      if (callerId === ownerId) {
        return null;
      }

      const normalizedFilePath = normalizeSharedPath(ownerId, filePath);
      if (!normalizedFilePath) {
        return "forbidden";
      }

      // Look up shares granted to this caller by this owner
      const shares = await db.listSharesByGranteeAndOwner(callerId, ownerId);
      const matchingShares = shares.filter(
        (s) =>
          s.accepted &&
          (!s.expires_at || s.expires_at.getTime() > Date.now()) &&
          shareMatchesPath(s.path, normalizedFilePath),
      );

      if (matchingShares.length === 0) {
        return "forbidden";
      }

      // Use the most permissive matching share
      for (const share of matchingShares) {
        const perms = ROLE_PERMISSIONS[share.role];
        if (perms && perms.has(action)) {
          return null;
        }
      }

      return "forbidden";
    },
  };
}
