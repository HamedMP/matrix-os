import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  createSharingService,
  type SharingService,
  type SharingDb,
  type ShareRow,
} from "../../../packages/gateway/src/sync/sharing.js";

function makeShareRow(overrides: Partial<ShareRow> = {}): ShareRow {
  return {
    id: "share-uuid-1",
    owner_id: "owner1",
    path: "projects/startup/",
    grantee_id: "grantee1",
    role: "editor",
    accepted: false,
    created_at: new Date("2026-04-14"),
    expires_at: null,
    ...overrides,
  };
}

function createMockDb(): SharingDb {
  return {
    insertShare: vi.fn(),
    getShare: vi.fn(),
    updateShareAccepted: vi.fn(),
    deleteShare: vi.fn(),
    listSharesByOwner: vi.fn(),
    listSharesByGrantee: vi.fn(),
    resolveHandle: vi.fn(),
    resolveUserId: vi.fn(),
  };
}

function createMockPeerRegistry() {
  return {
    sendToUser: vi.fn(),
    broadcastChange: vi.fn(),
    getPeers: vi.fn().mockReturnValue([]),
    registerPeer: vi.fn(),
    removePeer: vi.fn(),
  };
}

describe("SharingService", () => {
  let db: SharingDb;
  let peerRegistry: ReturnType<typeof createMockPeerRegistry>;
  let service: SharingService;

  beforeEach(() => {
    db = createMockDb();
    peerRegistry = createMockPeerRegistry();
    service = createSharingService({ db, peerRegistry });
  });

  // -----------------------------------------------------------------------
  // createShare
  // -----------------------------------------------------------------------
  describe("createShare", () => {
    it("inserts a share and broadcasts sync:share-invite to grantee", async () => {
      (db.resolveHandle as ReturnType<typeof vi.fn>).mockResolvedValue("grantee1");
      (db.resolveUserId as ReturnType<typeof vi.fn>).mockResolvedValue("@owner:matrix-os.com");
      (db.insertShare as ReturnType<typeof vi.fn>).mockResolvedValue(makeShareRow());

      const result = await service.createShare("owner1", {
        path: "projects/startup/",
        granteeHandle: "@colleague:matrix-os.com",
        role: "editor",
      });

      expect(result.shareId).toBe("share-uuid-1");
      expect(result.path).toBe("projects/startup/");
      expect(result.role).toBe("editor");

      expect(db.insertShare).toHaveBeenCalledWith({
        owner_id: "owner1",
        path: "projects/startup/",
        grantee_id: "grantee1",
        role: "editor",
        expires_at: undefined,
      });

      expect(peerRegistry.sendToUser).toHaveBeenCalledWith("grantee1", {
        type: "sync:share-invite",
        shareId: "share-uuid-1",
        ownerHandle: "@owner:matrix-os.com",
        path: "projects/startup/",
        role: "editor",
      });
    });

    it("rejects self-share", async () => {
      (db.resolveHandle as ReturnType<typeof vi.fn>).mockResolvedValue("owner1");

      await expect(
        service.createShare("owner1", {
          path: "projects/",
          granteeHandle: "@me:matrix-os.com",
          role: "viewer",
        }),
      ).rejects.toThrow(/self/i);
    });

    it("returns 404 error when grantee handle is not found", async () => {
      (db.resolveHandle as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(
        service.createShare("owner1", {
          path: "projects/",
          granteeHandle: "@nobody:matrix-os.com",
          role: "viewer",
        }),
      ).rejects.toThrow(/not found/i);
    });

    it("returns 409 error on duplicate share", async () => {
      (db.resolveHandle as ReturnType<typeof vi.fn>).mockResolvedValue("grantee1");
      (db.insertShare as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error("unique constraint"), { code: "23505" }),
      );

      await expect(
        service.createShare("owner1", {
          path: "projects/startup/",
          granteeHandle: "@colleague:matrix-os.com",
          role: "editor",
        }),
      ).rejects.toThrow(/already exists/i);
    });

    it("passes expiresAt when provided", async () => {
      (db.resolveHandle as ReturnType<typeof vi.fn>).mockResolvedValue("grantee1");
      (db.resolveUserId as ReturnType<typeof vi.fn>).mockResolvedValue("@owner:matrix-os.com");
      (db.insertShare as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeShareRow({ expires_at: new Date("2027-01-01") }),
      );

      await service.createShare("owner1", {
        path: "projects/",
        granteeHandle: "@colleague:matrix-os.com",
        role: "viewer",
        expiresAt: "2027-01-01T00:00:00Z",
      });

      expect(db.insertShare).toHaveBeenCalledWith(
        expect.objectContaining({ expires_at: "2027-01-01T00:00:00Z" }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // acceptShare
  // -----------------------------------------------------------------------
  describe("acceptShare", () => {
    it("marks the share as accepted and returns details", async () => {
      (db.getShare as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeShareRow({ grantee_id: "grantee1" }),
      );
      (db.updateShareAccepted as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (db.resolveUserId as ReturnType<typeof vi.fn>).mockResolvedValue("@owner:matrix-os.com");

      const result = await service.acceptShare("grantee1", "share-uuid-1");

      expect(result.accepted).toBe(true);
      expect(result.path).toBe("projects/startup/");
      expect(result.ownerHandle).toBe("@owner:matrix-os.com");
      expect(db.updateShareAccepted).toHaveBeenCalledWith("share-uuid-1", true);
    });

    it("rejects if the share does not exist", async () => {
      (db.getShare as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(
        service.acceptShare("grantee1", "nonexistent-uuid"),
      ).rejects.toThrow(/not found/i);
    });

    it("rejects if the caller is not the grantee", async () => {
      (db.getShare as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeShareRow({ grantee_id: "someone-else" }),
      );

      await expect(
        service.acceptShare("grantee1", "share-uuid-1"),
      ).rejects.toThrow(/permission|forbidden|not the grantee/i);
    });
  });

  // -----------------------------------------------------------------------
  // revokeShare
  // -----------------------------------------------------------------------
  describe("revokeShare", () => {
    it("deletes the share and broadcasts sync:access-revoked", async () => {
      (db.getShare as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeShareRow({ owner_id: "owner1" }),
      );
      (db.deleteShare as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (db.resolveUserId as ReturnType<typeof vi.fn>).mockResolvedValue("@owner:matrix-os.com");

      await service.revokeShare("owner1", "share-uuid-1");

      expect(db.deleteShare).toHaveBeenCalledWith("share-uuid-1");
      expect(peerRegistry.sendToUser).toHaveBeenCalledWith("grantee1", {
        type: "sync:access-revoked",
        shareId: "share-uuid-1",
        ownerHandle: "@owner:matrix-os.com",
        path: "projects/startup/",
      });
    });

    it("rejects if the share does not exist", async () => {
      (db.getShare as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(
        service.revokeShare("owner1", "nonexistent"),
      ).rejects.toThrow(/not found/i);
    });

    it("rejects if the caller is not the owner", async () => {
      (db.getShare as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeShareRow({ owner_id: "someone-else" }),
      );

      await expect(
        service.revokeShare("owner1", "share-uuid-1"),
      ).rejects.toThrow(/permission|forbidden|not the owner/i);
    });
  });

  // -----------------------------------------------------------------------
  // listShares
  // -----------------------------------------------------------------------
  describe("listShares", () => {
    it("returns owned and received shares", async () => {
      const owned = [makeShareRow({ id: "s1", owner_id: "user1", grantee_id: "g1" })];
      const received = [makeShareRow({ id: "s2", owner_id: "o1", grantee_id: "user1" })];

      (db.listSharesByOwner as ReturnType<typeof vi.fn>).mockResolvedValue(owned);
      (db.listSharesByGrantee as ReturnType<typeof vi.fn>).mockResolvedValue(received);
      (db.resolveUserId as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce("@g1:matrix-os.com")
        .mockResolvedValueOnce("@o1:matrix-os.com");

      const result = await service.listShares("user1");

      expect(result.owned).toHaveLength(1);
      expect(result.owned[0]!.id).toBe("s1");
      expect(result.owned[0]!.granteeHandle).toBe("@g1:matrix-os.com");

      expect(result.received).toHaveLength(1);
      expect(result.received[0]!.id).toBe("s2");
      expect(result.received[0]!.ownerHandle).toBe("@o1:matrix-os.com");
    });

    it("returns empty arrays when no shares exist", async () => {
      (db.listSharesByOwner as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (db.listSharesByGrantee as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await service.listShares("user1");

      expect(result.owned).toEqual([]);
      expect(result.received).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // checkSharePermission
  // -----------------------------------------------------------------------
  describe("checkSharePermission", () => {
    it("returns null for the owner (full access)", async () => {
      const result = await service.checkSharePermission("owner1", "owner1", "any/path", "put");
      expect(result).toBeNull();
    });

    it("viewer can GET but not PUT", async () => {
      (db.listSharesByGrantee as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeShareRow({
          owner_id: "owner1",
          grantee_id: "viewer1",
          path: "projects/",
          role: "viewer",
          accepted: true,
        }),
      ]);

      const getResult = await service.checkSharePermission("owner1", "viewer1", "projects/readme.md", "get");
      expect(getResult).toBeNull(); // allowed

      const putResult = await service.checkSharePermission("owner1", "viewer1", "projects/readme.md", "put");
      expect(putResult).toBe("forbidden"); // denied
    });

    it("editor can GET and PUT", async () => {
      (db.listSharesByGrantee as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeShareRow({
          owner_id: "owner1",
          grantee_id: "editor1",
          path: "projects/",
          role: "editor",
          accepted: true,
        }),
      ]);

      const getResult = await service.checkSharePermission("owner1", "editor1", "projects/file.ts", "get");
      expect(getResult).toBeNull();

      const putResult = await service.checkSharePermission("owner1", "editor1", "projects/file.ts", "put");
      expect(putResult).toBeNull();
    });

    it("admin can GET, PUT, and delete", async () => {
      (db.listSharesByGrantee as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeShareRow({
          owner_id: "owner1",
          grantee_id: "admin1",
          path: "projects/",
          role: "admin",
          accepted: true,
        }),
      ]);

      const getResult = await service.checkSharePermission("owner1", "admin1", "projects/file.ts", "get");
      expect(getResult).toBeNull();

      const putResult = await service.checkSharePermission("owner1", "admin1", "projects/file.ts", "put");
      expect(putResult).toBeNull();

      const deleteResult = await service.checkSharePermission("owner1", "admin1", "projects/file.ts", "delete");
      expect(deleteResult).toBeNull();
    });

    it("denies access for paths outside the shared prefix", async () => {
      (db.listSharesByGrantee as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeShareRow({
          owner_id: "owner1",
          grantee_id: "grantee1",
          path: "projects/startup/",
          role: "editor",
          accepted: true,
        }),
      ]);

      const result = await service.checkSharePermission("owner1", "grantee1", "private/secrets.md", "get");
      expect(result).toBe("forbidden");
    });

    it("denies access for unaccepted shares", async () => {
      (db.listSharesByGrantee as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeShareRow({
          owner_id: "owner1",
          grantee_id: "grantee1",
          path: "projects/",
          role: "editor",
          accepted: false,
        }),
      ]);

      const result = await service.checkSharePermission("owner1", "grantee1", "projects/readme.md", "get");
      expect(result).toBe("forbidden");
    });

    it("denies access when no shares exist for the user", async () => {
      (db.listSharesByGrantee as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await service.checkSharePermission("owner1", "stranger", "projects/readme.md", "get");
      expect(result).toBe("forbidden");
    });
  });
});
