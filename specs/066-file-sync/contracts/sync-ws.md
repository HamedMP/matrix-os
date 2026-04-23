# API Contracts: Sync WebSocket Events

All sync WebSocket events flow through the existing gateway WebSocket at `ws://gateway:4000/ws`.

## Client -> Server

### sync:subscribe

Subscribe to sync events. Sent after authentication.

```typescript
{
  type: "sync:subscribe",
  peerId: string,         // This device's peer ID
  hostname: string,       // Device hostname
  platform: "darwin" | "linux" | "win32",
  clientVersion: string,  // e.g., "0.1.0"
}
```

**Zod schema**:
```typescript
const SyncSubscribeSchema = z.object({
  type: z.literal("sync:subscribe"),
  peerId: z.string().min(1).max(128),
  hostname: z.string().max(256),
  platform: z.enum(["darwin", "linux", "win32"]),
  clientVersion: z.string().max(64),
});
```

**Server behavior**:
1. Register peer in the user's peer map (bounded Map, max 100 per user)
2. Broadcast `sync:peer-join` to other peers
3. Begin forwarding `sync:*` events to this connection

---

## Server -> Client

### sync:change

A file was changed by another peer. Sent after a successful `POST /api/sync/commit`.

```typescript
{
  type: "sync:change",
  files: Array<{
    path: string,         // Relative file path
    hash: string,         // New content hash
    size: number,
    action: "add" | "update" | "delete",
  }>,
  peerId: string,         // Peer that made the change
  manifestVersion: number, // New manifest version
}
```

**Client behavior**: Request presigned download URLs for changed files, download, write locally.

---

### sync:conflict

A conflict was detected during commit. Sent when the gateway detects both sides changed a file.

```typescript
{
  type: "sync:conflict",
  path: string,           // Original file path
  localHash: string,      // Client's hash
  remoteHash: string,     // Other peer's hash
  remotePeerId: string,   // Who made the conflicting change
  conflictPath: string,   // Path of the conflict copy (if created)
}
```

**Client behavior**: Show conflict notification. User resolves via CLI or shell UI.

---

### sync:peer-join

A new peer connected to sync events.

```typescript
{
  type: "sync:peer-join",
  peerId: string,
  hostname: string,
  platform: string,
}
```

---

### sync:peer-leave

A peer disconnected.

```typescript
{
  type: "sync:peer-leave",
  peerId: string,
}
```

---

### sync:share-invite

Incoming share invitation for the authenticated user.

```typescript
{
  type: "sync:share-invite",
  shareId: string,        // UUID — use to accept
  ownerHandle: string,    // Who is sharing
  path: string,           // What is being shared
  role: "viewer" | "editor" | "admin",
}
```

**Client behavior**: Show invitation notification. User accepts via CLI or shell UI.

---

### sync:access-revoked

A share was revoked for the authenticated user.

```typescript
{
  type: "sync:access-revoked",
  shareId: string,
  ownerHandle: string,
  path: string,
}
```

**Client behavior**: Stop syncing the shared folder. Local copy remains but no longer receives updates.

---

## Updated ws-message-schema.ts

The existing `MainWsClientMessageSchema` needs a new discriminated union member:

```typescript
export const MainWsClientMessageSchema = z.discriminatedUnion("type", [
  // ... existing members ...
  z.object({
    type: z.literal("sync:subscribe"),
    peerId: z.string().min(1).max(128),
    hostname: z.string().max(256),
    platform: z.enum(["darwin", "linux", "win32"]),
    clientVersion: z.string().max(64),
  }),
]);
```

The `ServerMessage` type union in `server.ts` needs new members:

```typescript
export type ServerMessage =
  | // ... existing members ...
  | { type: "sync:change"; files: Array<{ path: string; hash: string; size: number; action: string }>; peerId: string; manifestVersion: number }
  | { type: "sync:conflict"; path: string; localHash: string; remoteHash: string; remotePeerId: string; conflictPath: string }
  | { type: "sync:peer-join"; peerId: string; hostname: string; platform: string }
  | { type: "sync:peer-leave"; peerId: string }
  | { type: "sync:share-invite"; shareId: string; ownerHandle: string; path: string; role: string }
  | { type: "sync:access-revoked"; shareId: string; ownerHandle: string; path: string };
```

## Event Flow Diagram

```
Peer A (laptop)                     Gateway                     Peer B (cloud VPS)
    |                                  |                              |
    |-- file change detected --------->|                              |
    |-- POST /api/sync/presign ------->|                              |
    |<-- presigned PUT URLs -----------|                              |
    |-- PUT to R2 (direct) ---------> R2                              |
    |-- POST /api/sync/commit -------->|                              |
    |                                  |-- update manifest (R2) ----->|
    |                                  |-- sync:change (WS) -------->|
    |<-- 200 OK -----------------------|                              |
    |                                  |                              |-- POST /api/sync/presign
    |                                  |<-----------------------------|
    |                                  |-- presigned GET URLs ------->|
    |                                  |                              |-- GET from R2 (direct)
    |                                  |                              |-- write locally
```
