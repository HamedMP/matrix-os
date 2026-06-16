# Data Model: Electron macOS Shell (Operator)

Client-side models only — the server source of truth is unchanged (owner Postgres + Matrix home
files via existing gateway routes). Field names mirror the wire contract verified in
[contracts/gateway-contract.md](./contracts/gateway-contract.md).

## Trusted core (main process)

### ConnectionProfile (local JSON store)
| Field | Type | Notes |
|---|---|---|
| handle | string | user handle |
| platformHost | string | e.g. `https://app.matrix-os.com` |
| runtimeSlot | string | `"primary"` default; appended as `?runtime=` when not primary |
| userId | string | from device-token response |

### PrincipalCredential (safeStorage blob, never crosses IPC)
| Field | Type | Notes |
|---|---|---|
| accessToken | string | bearer; injected at network layer only |
| expiresAt | number | epoch ms; expiry decisions also trust server 401s (clock-skew edge) |

### LocalUiState (local JSON store, atomic writes)
| Field | Type | Notes |
|---|---|---|
| windowBounds | {x,y,width,height} | restore on launch |
| lastProjectSlug | string \| null | board boot target |
| panelLayouts | Record<taskKey, PanelLayoutEntry> | bounded: prune entries whose `lastSeenAt` is older than 90d |
| appearance | {theme: "dark"\|"light"\|"system"} | |

## Renderer stores (Zustand, one per domain — L13)

### Project
`{ slug, name, mode, createdAt }` — from `GET /api/workspace/projects`.

### Card (task)
`{ id, projectSlug, title, description, status, priority, order, parentTaskId,
linkedSessionId, linkedWorktreeId, previewIds[], tags[], updatedAt, revision }`
- status ∈ `todo | running | waiting | blocked | complete | archived` (archived hidden)
- priority ∈ `low | normal | high | urgent`
- Column order: `[todo, running, waiting, blocked, complete]`; sort by `order` then `id`.
- Mutations: serial per task; on suspected stale write → refetch (no silent overwrite, FR-011).

### WorkspaceSession (merged attachable — L6)
`{ name, attachName, status: "active"|"exited", source: "zellij"|"workspace" }`
- attachName = zellij name (zellij list) or `runtime.zellijSession` (workspace records).
- aliasMap: `Record<orchestratorId, attachName>` resolves `Card.linkedSessionId`.
- Invariant: entries without a real attachName never exist in this store.

### TerminalAttachment (attach manager)
| Field | Type | Notes |
|---|---|---|
| sessionName | string | zellij name |
| state | `connecting \| attached \| reconnecting \| ended \| fatal` | `fatal` = session_not_found etc., shows recreate CTA, zero retries |
| lastSeq | number | resume at lastSeq+1; fresh attach uses live-tail sentinel |
| generation | number | open-request guard (L9): stale responses discarded |
| buffer | serialized xterm state | snapshot on detach; ring cap 5,000 lines |
- Invariant: at most ONE attachment with a live socket app-wide per sessionName (L4).
- Detached buffer cache: LRU, cap 8 (FR-045/resource budget).

### AgentThread
| Field | Type | Notes |
|---|---|---|
| id | string | client id |
| requestId | string | routes kernel events |
| sessionId | string \| null | bound from `kernel:init` / `session:switched` |
| taskId | string \| null | originating card |
| status | `running \| needs-attention \| done \| failed \| aborted` | |
| transcript | ChatMessage[] | reduceChat output; cap 500, drop oldest |
| unread | boolean | drives badge + notification coalescing |

### ChatMessage (ported reducer)
`{ id, role: "user"|"assistant"|"system", content, tool?, toolInput?, requestId?, timestamp }`
- Reduction rules: delta accumulation onto last assistant bubble of same requestId; tool_start
  inserts activity entry; post-tool text starts a fresh bubble (tool-split).

### PanelLayoutEntry (per task)
`{ layout: PanelLayout, lastSeenAt: number }`
- `lastSeenAt` is epoch ms updated whenever the task layout is loaded, focused, or persisted.
- Local-store pruning deletes entries with `lastSeenAt < now - 90d`; entries without a valid
  timestamp fail schema validation and are discarded during recovery.

### PanelLayout
`{ order: PanelKind[], visible: Record<PanelKind, boolean>, sizes: Record<PanelKind, number> }`
- PanelKind ∈ `terminal | editor | git | browser | artifacts | processes`
- sizes are percentages; per-panel minimums enforced at drag time; persisted per task.

### WorkspaceEntry (open task)
`{ taskId, panelLayout, lastFocusedAt, live: boolean }`
- LRU: beyond cap (target 8) least-recently-focused entry releases sockets/heavy views but
  keeps restorable state (FR-045, SC-006).

### EditorFile
`{ path, content, dirtyBaseline, loadedMtime }`
- Save guard: stat-before-PUT; `serverMtime ≠ loadedMtime` → conflict warning (R5).

### MatrixApp / LaunchToken
`{ slug, name, icon, category }`; token cache `{ launchUrl, expiresAt }` per slug, TTL
`expiresAt - 30s`, bounded LRU (FR-063).

### AppError (one mapper)
`unauthorized | offline | timeout | notFound | server | misconfigured | fatalSession`
- Display boundary allowlist: generic copy per category; reject raw strings >300 chars or
  containing path/db/provider markers (092 rule, FR-080).

## State transitions

### Terminal attachment
```
idle → connecting → attached → (detach) → cached-buffer
              ↘ error(fatal) → fatal [recreate CTA, no retry]
attached → socket-drop → reconnecting (backoff 0.5s×2^n, cap 30s, jitter 0.5)
reconnecting → attached (resume fromSeq=lastSeq+1)
replay-evicted → clear buffer → attach at live tail → gap marker
```

### Agent thread
```
composing → running → done | failed | aborted
running → needs-attention (approval:request / error requiring input)
unfocused transition to done/failed/needs-attention ⇒ native notification (coalesced)
```

### Hosted-shell embed auth
```
load → handoff(cookie pair verified) → ready
handoff failure → retry once → inline sign-in (embed-scoped) [native principal untouched]
```
