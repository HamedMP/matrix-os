# 066: File Sync — Bidirectional File Synchronization

## Overview

Google Drive / Dropbox-style bidirectional file sync for Matrix OS. Every device (laptop, cloud VPS, colleague's machine) is an equal peer. R2 is the storage and transport layer. The gateway coordinates sync, push notifications, and access control.

This spec covers five subsystems with the sync engine as the primary focus:

1. **Sync Engine** (deep-dive) — bidirectional file sync via R2
2. **CLI + Local Daemon** — local client that runs the sync
3. **Sharing & Collaboration** — folder-level access control
4. **Remote Access** — SSH into cloud instances
5. **Mac Menu Bar App** — native macOS sync status UI

## Motivation

The primary workflow: kick off Claude Code in a cloud tmux session, come back to the laptop and see all the work. Review files, continue locally, or SSH back in. Share project folders with colleagues so they can run their own agents on the same files.

Currently there's git-sync and S3 backup, but no real-time bidirectional sync, no local daemon, no sharing model, and no CLI for managing it all.

## Design Principles

- **Local-first**: Every copy is a full copy. Works offline, syncs when connected.
- **All peers equal**: Cloud is just the peer that never sleeps. No special status.
- **File-level sync**: Track content hashes per file. Upload/download whole files. Upgrade path to block-level chunking later.
- **Defense in depth**: Gateway auth + path validation + scoped R2 tokens.
- **Everything Is a File**: Sync config, ignore patterns, sharing metadata — all files.

---

## 1. Sync Engine Core

### Concepts

- **Peer**: Any device running a Matrix OS instance. Identified by a unique peer ID derived from device + user identity.
- **Manifest**: A JSON file in R2 (`{userId}/manifest.json`) listing every synced file with content hash, size, modification time, and last-modifying peer ID.
- **Sync cycle**: Peer compares local file state against the R2 manifest. Three outcomes per file: local newer (upload), remote newer (download), both changed (conflict).

### Manifest Structure

Stored at `matrixos-sync/{userId}/manifest.json` in R2:

```json
{
  "version": 2,
  "files": {
    "apps/calculator/index.html": {
      "hash": "sha256:abc123...",
      "size": 4096,
      "mtime": 1744540800000,
      "peerId": "hamed-macbook",
      "version": 3
    }
  }
}
```

Single file manifest. Default `.syncignore` excludes large/generated folders to keep entry count manageable (target: under 10K files for any reasonable home directory).

### Sync Cycle

1. Local daemon detects file change (chokidar)
2. Compute SHA-256 of changed file
3. Fetch current manifest from gateway (with ETag caching)
4. Compare: if file's manifest hash differs from both local-before and local-after, it's a conflict. If manifest matches local-before, it's a clean local change.
5. Request presigned upload URL from gateway (`POST /api/sync/presign`)
6. Upload file directly to R2 via presigned URL (gateway never touches file content)
7. Confirm upload to gateway (`POST /api/sync/commit`), which updates manifest + broadcasts `sync:change` via WebSocket
8. Other peers receive notification, request presigned download URL, download directly from R2

### Change Detection & Notification

- **Real-time**: WebSocket push from gateway when any peer changes a file. Instant for connected peers.
- **Catch-up**: R2 manifest polling on reconnect after offline. Peer compares all local hashes against manifest to reconcile missed changes.

### Conflict Resolution

**Detection**: Local hash != manifest hash AND local hash != previous known hash (both sides changed since last sync).

**Text files** (`.md`, `.ts`, `.json`, `.txt`, `.jsx`, `.tsx`, `.css`, `.html`, `.yaml`, `.toml`, `.xml`, `.svg`, `.sh`, `.py`, `.go`, `.rs`):
- Fetch common ancestor from R2 versioning
- Attempt 3-way merge
- If merge succeeds: write merged result, update manifest
- If merge fails: create conflict copy

**Binary files** (everything else):
- Always create conflict copy: `filename (conflict - peerId - date).ext`

**Conflict copies** are themselves synced, so all peers see them. Resolved via `matrixos sync resolve` or shell UI.

### Default .syncignore

Ships with sensible defaults:

```
node_modules/
.next/
.venv/
__pycache__/
dist/
build/
.cache/
*.sqlite
*.db
system/logs/
system/matrix.db*
.git/
.trash/
.DS_Store
Thumbs.db
```

Users can add their own patterns. Follows `.gitignore` syntax.

### Selective Sync (Per-Device)

Beyond `.syncignore` (global exclusions), each device can choose which top-level folders to sync. Configured in `~/.matrixos/config.json`:

```json
{
  "sync": {
    "folders": ["apps/", "agents/", "system/", "projects/"],
    "exclude": ["data/large-exports/"]
  }
}
```

Unselected folders exist in R2 but are not downloaded to that device.

### R2 Storage Layout

```
matrixos-sync/
  {userId}/
    manifest.json
    files/
      apps/calculator/index.html
      agents/skills/coding.md
      system/soul.md
      projects/startup/readme.md
      ...
```

No separate `shared/` prefix. Shared folders are paths within the owner's tree with scoped access grants.

### Concurrency Control

Manifest updates use ETag-based optimistic concurrency:

1. Fetch manifest with its ETag
2. Apply local changes to manifest
3. PUT manifest with `If-Match: <etag>`
4. If 412 (precondition failed): another peer updated first. Re-fetch, merge changes, retry.

Prevents two peers from clobbering each other's manifest updates.

---

## 2. Gateway Sync API

New endpoints added to the existing gateway alongside current `/api/files/*` routes.

### Sync Endpoints

The gateway never proxies file content. Clients upload/download directly to R2 via presigned URLs. The gateway handles only metadata, auth, and notifications.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/sync/manifest` | Fetch current manifest (with ETag for caching) |
| `PUT` | `/api/sync/manifest` | Update manifest (optimistic concurrency via ETag) |
| `POST` | `/api/sync/presign` | Get presigned R2 URLs for direct upload/download. Body: `{files: [{path, action: "put"\|"get", hash?}]}`. Returns `{urls: [{path, url, expiresIn}]}` |
| `POST` | `/api/sync/commit` | After direct upload completes, update manifest + notify peers. Body: `{files: [{path, hash, size}]}` |
| `GET` | `/api/sync/status` | Sync health: connected peers, last sync, pending conflicts |
| `POST` | `/api/sync/resolve-conflict` | Mark a conflict as resolved |

### Presigned URL Flow

1. Client detects local file changes, computes hashes
2. Client calls `POST /api/sync/presign` with list of changed files
3. Gateway validates auth + permissions, returns presigned R2 URLs (valid ~15 min)
4. Client uploads files directly to R2 in parallel (no gateway bottleneck)
5. Client calls `POST /api/sync/commit` to confirm uploads
6. Gateway updates manifest (ETag concurrency) and broadcasts `sync:change` to peers
7. Peers receive notification, call `POST /api/sync/presign` with `action: "get"`, download directly from R2

For batch operations: gateway returns up to 100 presigned URLs in one request, client processes them in parallel. R2 multipart upload is available for files over 100 MB.

### WebSocket Events

Added to existing `ws://gateway:4000/ws`:

| Event | Direction | Description |
|---|---|---|
| `sync:change` | server -> client | File changed by another peer. Payload: `{path, hash, peerId, action}` |
| `sync:conflict` | server -> client | Conflict detected. Payload: `{path, localHash, remoteHash, conflictPath}` |
| `sync:peer-join` | server -> client | A new peer connected |
| `sync:peer-leave` | server -> client | A peer disconnected |
| `sync:share-invite` | server -> client | Incoming share invitation |
| `sync:access-revoked` | server -> client | Share access was revoked |
| `sync:subscribe` | client -> server | Subscribe to sync events (sent after auth) |

### Security

Three layers of defense:

1. **Gateway auth**: Signed JWT validation on every request. Role checks per endpoint.
2. **Path validation**: `resolveWithinPrefix(userId, path)` prevents path traversal.
3. **Scoped R2 credentials**: Per-user R2 API tokens scoped to their prefix. Even if a gateway bug occurs, cross-user data access is blocked at the storage level.

```
R2 Token: user-hamed      -> scoped to matrixos-sync/hamed/*
R2 Token: user-colleague   -> scoped to matrixos-sync/colleague/*
R2 Token: share-xyz        -> scoped to matrixos-sync/hamed/files/projects/startup/*
```

---

## 3. CLI + Local Daemon

### New CLI Commands

| Command | Description |
|---|---|
| `matrixos login` | OAuth device flow: opens browser, stores signed JWT in `~/.matrixos/auth.json` |
| `matrixos logout` | Clear local tokens |
| `matrixos sync <path>` | Link a local folder to Matrix OS instance. Default: `~/matrixos/` |
| `matrixos sync status` | Show sync state: files pending, last sync time, connected peers |
| `matrixos sync pause` | Pause the sync daemon |
| `matrixos sync resume` | Resume the sync daemon |
| `matrixos share <path> <handle> [--role editor\|viewer\|admin]` | Share a folder with another Matrix OS user |
| `matrixos unshare <path> <handle>` | Revoke access |
| `matrixos peers` | List connected peers and their sync status |
| `matrixos keys add <pubkey>` | Add SSH public key for remote access |
| `matrixos ssh` | SSH into your cloud instance |
| `matrixos ssh <handle>` | SSH into a shared instance (if permitted) |

### Daemon Behavior

- Starts automatically after `matrixos sync <path>`
- Runs as a background process: launchd on macOS, systemd on Linux
- Watches local folder with chokidar
- On local file change: hash -> compare with cached manifest -> request presigned URL from gateway (`POST /api/sync/presign`) -> upload directly to R2 -> confirm via `POST /api/sync/commit` -> gateway updates manifest + broadcasts to peers
- On WebSocket notification from gateway: request presigned download URL (`POST /api/sync/presign` with `action: "get"`) -> download directly from R2 -> write locally -> update cached manifest
- Gateway never touches file content. REST handles metadata (presign, commit, manifest). WebSocket handles real-time notifications (lightweight event payloads only).
- On reconnect after offline: fetch manifest from R2, compare all local hashes, reconcile

### Local Directory Structure

```
~/.matrixos/
  auth.json          # OAuth JWT (signed, with expiry) + refresh token. File permissions 0600.
  config.json        # Sync preferences, gateway URL, linked folders, selective sync
  sync-state.json    # Cached manifest + last sync cursor
  logs/              # Daemon logs
```

---

## 4. Sharing & Collaboration

### Sharing Model

Sharing is an access grant on an existing path within the owner's R2 prefix. No file duplication.

### Sharing Flow

1. Owner runs `matrixos share projects/startup/ @colleague:matrix-os.com --role editor`
2. Gateway inserts row in sharing permissions table (Postgres), generates scoped R2 token
3. Colleague gets a notification (WebSocket `sync:share-invite` + shell notification)
4. Colleague accepts; their daemon adds the shared folder to their local tree at `~/matrixos/shared/hamed/projects/startup/`
5. Both peers' daemons sync that subtree bidirectionally

### Permissions Table (Postgres)

| Column | Type | Description |
|---|---|---|
| `id` | uuid | Primary key |
| `owner` | text | Owner's handle |
| `path` | text | Shared path (relative to owner's home) |
| `grantee` | text | Recipient's handle |
| `role` | enum | `viewer`, `editor`, `admin` |
| `created_at` | timestamp | When share was created |
| `expires_at` | timestamp | Optional expiry (null = permanent) |
| `accepted` | boolean | Whether grantee accepted the invite |

### Role Enforcement

| Role | Read | Write | Reshare | Delete |
|---|---|---|---|---|
| viewer | yes | no | no | no |
| editor | yes | yes | no | no |
| admin | yes | yes | yes | yes |

Enforced at the gateway level on every sync API call. Scoped R2 token is a second layer.

### Multi-Agent Collaboration

When a colleague runs their own Claude/Codex on a shared folder:
- Their agent writes files locally
- Their daemon syncs changes to R2 (through the owner's prefix, scoped token)
- Owner's gateway broadcasts `sync:change` events
- Owner sees the changes appear locally
- Conflict resolution applies normally

### Revoking Access

`matrixos unshare projects/startup/ @colleague:matrix-os.com`:
- Deletes sharing row in Postgres
- Invalidates scoped R2 token
- Sends `sync:access-revoked` WebSocket event to colleague's daemon
- Colleague's daemon stops syncing that folder
- Local copy on colleague's machine remains but no longer receives updates

### Notification Surfaces

Sync notifications (changes, conflicts, share invites, access revoked) surface everywhere:

| Surface | How |
|---|---|
| Matrix Shell (web) | Toast notifications, notification bell with unread count, file manager sync status icons per file |
| CLI | `matrixos sync status` output, daemon logs |
| Mac menu bar app | Tray icon state, dropdown activity feed, pending invites |
| Mobile (web terminal) | Same as shell: toasts + notification bell |

All surfaces consume the same WebSocket events.

---

## 5. Remote Access (SSH)

### Architecture

OpenSSH sshd running on port 2222 inside cloud Matrix OS containers. Authenticates against Matrix OS identity.

### Authentication

1. **SSH keys**: User uploads public key via shell settings or `matrixos keys add`. Stored in `~/system/authorized_keys`, synced to container's `~/.ssh/authorized_keys`.
2. **OAuth-issued short-lived certificates** (stretch goal): `matrixos ssh` generates a short-lived SSH certificate signed by the platform CA using the OAuth token. No key management needed.

### Connection Flow

```
matrixos ssh                               # connects to your cloud instance
matrixos ssh @colleague:matrix-os.com      # connects to a shared instance (if permitted)
```

Under the hood: resolves handle to container host:port via platform API, connects via SSH.

### tmux Session Sharing

Both web terminal and SSH drop into the same tmux session by default:
- Start Claude Code in the web shell
- SSH in from your phone (Termius, Blink)
- See the same session, send commands
- Disconnect, reconnect: tmux keeps it alive

### Exposure

Platform proxy routes `ssh.matrix-os.com:2222` to the correct container based on SSH certificate user identity.

---

## 6. Auth System

### Token Lifecycle

1. User runs `matrixos login`
2. CLI opens browser -> matrix-os.com OAuth consent screen (Clerk)
3. On success, platform issues a signed JWT:

```json
{
  "sub": "hamed",
  "handle": "@hamed:matrix-os.com",
  "role": "owner",
  "iat": 1744540800,
  "exp": 1744627200,
  "aud": "matrixos-sync",
  "jti": "unique-token-id"
}
```

4. Token stored in `~/.matrixos/auth.json` (file permissions `0600`)
5. CLI/daemon attach token to all API calls as `Authorization: Bearer <jwt>`
6. Auto-refresh via refresh token (longer-lived, stored alongside)

### Token Scoping

| Context | Token type | Lifetime | Scope |
|---|---|---|---|
| Interactive CLI/menu bar | Access JWT | 24h (auto-refresh) | Full user access |
| Headless agent (cloud tmux) | API key JWT | 90 days | Configurable: full or read-only |
| Shared folder access | Scoped JWT | Matches share expiry | Read or read-write on specific prefix |
| SSH certificate | Signed cert | 12h | Shell access to specific container |

### Server-Side Validation

- Gateway validates JWT signature + expiry on every request
- Checks `sub` against sharing table for shared folder access
- Rate limiting per user identity (not just IP)
- Revocation: platform maintains a short revocation list, gateway checks it (cached, refreshed every 60s)

### Migration from Current Auth

The existing `MATRIX_AUTH_TOKEN` (static bearer token) becomes a fallback for local-only instances not connected to the cloud platform. Cloud instances use the JWT system exclusively.

---

## 7. Mac Menu Bar App

Native macOS app built with **Swift/SwiftUI**.

### Architecture

The menu bar app is a thin native UI layer. The sync engine runs as the TypeScript daemon (same as CLI). The Swift app communicates with it via local HTTP or Unix socket.

### Features

- **Tray icon**: Shows sync status (synced / syncing / offline / conflict)
- **Dropdown menu**: Recent activity feed, pending conflicts, share invitations
- **Quick actions**: Pause/resume sync, open synced folder in Finder, open web shell
- **Notifications**: macOS Notification Center integration for share invites and conflicts
- **Finder extension** (stretch goal): Sync status badges on files in Finder (like Dropbox)

### Reference

Moltbot (OpenClaw) at `../moltbot` has an existing Swift menu bar app as a reference implementation.

---

## 8. Implementation Phases

| Phase | Scope | Depends on |
|---|---|---|
| **Phase 1** | Sync Engine Core: R2 integration, manifest, file-level sync, conflict resolution, gateway sync API, WebSocket events | — |
| **Phase 2** | CLI + Local Daemon: OAuth login, `matrixos sync`, background daemon, file watching, reconnect reconciliation | Phase 1 |
| **Phase 3** | Sharing & Collaboration: permissions table, `matrixos share/unshare`, scoped R2 tokens, invite notifications, shell UI | Phase 1, 2 |
| **Phase 4** | Remote Access: OpenSSH sshd in container, SSH key management, `matrixos ssh`, tmux sharing, proxy routing | Phase 2 (auth) |
| **Phase 5** | Mac Menu Bar App: Swift/SwiftUI tray app, daemon communication, Finder extension | Phase 2 |

Phase 1 is the foundation. Phases 2-5 can be partially parallelized (e.g., Phase 4 is mostly independent once auth exists).
