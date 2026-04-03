# 052: Memory System

Unified memory, interaction logging, and personalization system for Matrix OS. Replaces the existing SQLite memory store, file-based conversation archive, and file-based summaries with a Postgres-backed system that enables semantic search, full interaction tracing, and LLM-powered memory extraction.

**Supersedes:** spec 045 Phases 3-4 (long-term memory, semantic search). Phases 1-2 of 045 (system prompt context, conversation continuity) are already implemented and remain as-is.

## Goals

1. **Maximal personalization** -- the agent should deeply know each user's preferences, facts, instructions, and patterns over time
2. **Full interaction logging** -- every user message, LLM response, tool call, and tool result is recorded for analysis
3. **Hybrid recall** -- combine keyword search (Postgres FTS) with semantic search (pgvector) for high-quality memory retrieval
4. **Multi-user ready** -- every table includes `user_id` for future multi-user access to a single OS instance (currently single-tenant: one user per Postgres server)
5. **Caller control** -- the API accepts `userId`, `memoryEnabled` flag, and optional `taskId` per request

## Gap Analysis: Current State

### What exists (implemented)

| Component | Location | Status |
|---|---|---|
| SQLite memory store (CRUD + FTS5) | `packages/kernel/src/memory.ts` | Working, 4 categories, dedup by exact content |
| IPC tools (remember, recall, forget, list_memories) | `packages/kernel/src/ipc-server.ts:505-574` | Working, exposed to kernel agent |
| Pattern-based extraction (`extractMemories()`) | `packages/kernel/src/memory.ts:182-200` | **Dead code** -- defined but never called |
| System prompt memory injection | `packages/kernel/src/prompt.ts:73-96` | Working, top 20 memories capped at 1000 tokens |
| Conversation archive (JSON files) | `~/system/conversations/{id}.json` | Working, brute-force substring search |
| Conversation summaries (markdown files) | `~/system/summaries/*.md` | Working, top 5 injected into prompt |
| Conversation history reader | `packages/kernel/src/conversation-history.ts` | Working, last 30 messages truncated to 500 chars |
| Memory search (FTS + summaries) | `packages/kernel/src/memory-search.ts` | Working, combines SQLite FTS with file scan |
| QMD search IPC tool | `packages/kernel/src/ipc-server.ts:982-1025` | Working, shells out to `qmd` CLI, optional |
| Postgres app data layer (Kysely + pg.Pool) | `packages/gateway/src/app-db.ts` | Working, schema-per-app model |

### What's broken or missing

| Gap | Impact |
|---|---|
| `extractMemories()` is dead code | No automatic memory extraction happens -- agent only remembers when explicitly told |
| FTS5 keyword-only recall | "what food does the user like" won't find "prefers sushi" -- no semantic understanding |
| No interaction logging | Can't analyze user behavior patterns, tool usage, or conversation trends |
| Memories loaded by insertion order, not relevance | Top 20 by insert time, not by relevance to current conversation |
| No memory confidence or decay | All memories equal weight forever, no staleness detection |
| File-based conversations don't scale | Brute-force `toLowerCase().includes()` over every JSON file |
| No per-session structure | Conversations are flat JSON blobs, no session lifecycle (start/end/summary) |
| No cost/token tracking | Can't analyze API spend per user or per session |
| SQLite FTS uses raw `sqlite.prepare()` | Bypasses Drizzle ORM, breaks project convention |
| No user_id scoping | Current system assumes single user, no isolation |

## Architecture

### Approach: Memory as a Postgres Schema

Add a `_memory` schema to the existing per-user Postgres database (same DB as app data). The gateway is the observer (logs all interactions), and the kernel is the consumer (reads memories into the prompt).

```
User message arrives (any channel)
  |
  +-- 1. Gateway creates/resumes session in _memory.sessions
  |
  +-- 2. Gateway logs interaction (type: user_message)
  |
  +-- 3. Gateway runs inline pattern extraction
  |      +-- writes to _memory.memories (source: pattern, confidence: 0.9)
  |
  +-- 4. Gateway queries relevant memories for this user
  |      +-- hybrid: FTS + vector similarity on user message
  |      +-- returns top-N, sorted by combined score
  |
  +-- 5. Gateway passes memories to buildSystemPrompt()
  |      +-- injected as "## Relevant Memories" section
  |
  +-- 6. Kernel runs (Agent SDK query)
  |      |
  |      +-- Each tool call: gateway logs (type: tool_call)
  |      +-- Each tool result: gateway logs (type: tool_result)
  |      +-- Final response: gateway logs (type: assistant_response)
  |
  +-- 7. Kernel IPC tools (same interface, Postgres backend):
  |      +-- remember(content, category) -> _memory.memories (source: manual, confidence: 1.0)
  |      +-- recall(query) -> hybrid FTS + vector search
  |      +-- forget(id) -> hard delete
  |      +-- list_memories(category?) -> query with filters
  |
  +-- 8. On session end:
         +-- Update sessions.ended_at, message_count
         +-- Generate summary via haiku -> sessions.summary
         +-- Queue async LLM extraction on full interaction log
```

### Kernel spawn interface

```typescript
interface KernelConfig {
  // existing fields...
  userId: string;           // required -- indexes all memory operations
  memoryEnabled?: boolean;  // default true, caller can disable per-request
  taskId?: string;          // optional -- groups related interactions
  sessionId?: string;       // resume existing session (existing field)
}
```

## Postgres Schema

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS _memory;

-- Sessions (replaces ~/system/conversations/*.json and ~/system/summaries/*.md)
CREATE TABLE _memory.sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL,
  channel       text,
  summary       text,
  message_count integer DEFAULT 0,
  started_at    timestamptz DEFAULT now(),
  ended_at      timestamptz,
  metadata      jsonb DEFAULT '{}'
);
CREATE INDEX idx_sessions_user ON _memory.sessions (user_id, started_at DESC);

-- Interactions (full trace log)
CREATE TABLE _memory.interactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES _memory.sessions(id) ON DELETE CASCADE,
  user_id       text NOT NULL,
  task_id       text,
  seq           integer NOT NULL,
  type          text NOT NULL,
  content       text NOT NULL,
  tool_name     text,
  token_count   integer,
  cost_estimate real,
  latency_ms    integer,
  metadata      jsonb DEFAULT '{}',
  created_at    timestamptz DEFAULT now()
);
CREATE INDEX idx_interactions_session ON _memory.interactions (session_id, seq);
CREATE INDEX idx_interactions_user ON _memory.interactions (user_id, created_at DESC);
CREATE INDEX idx_interactions_task ON _memory.interactions (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_interactions_tool ON _memory.interactions (user_id, tool_name) WHERE tool_name IS NOT NULL;

-- Memories (extracted facts, preferences, instructions)
CREATE TABLE _memory.memories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text NOT NULL,
  content         text NOT NULL,
  category        text NOT NULL DEFAULT 'fact',
  source          text NOT NULL DEFAULT 'manual',
  confidence      real DEFAULT 1.0,
  embedding       vector(1536),
  source_session  uuid REFERENCES _memory.sessions(id) ON DELETE SET NULL,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  last_accessed   timestamptz,
  access_count    integer DEFAULT 0,
  UNIQUE (user_id, content)
);
CREATE INDEX idx_memories_user ON _memory.memories (user_id, updated_at DESC);
CREATE INDEX idx_memories_category ON _memory.memories (user_id, category);
CREATE INDEX idx_memories_embedding ON _memory.memories
  USING hnsw (embedding vector_cosine_ops);
ALTER TABLE _memory.memories ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;
CREATE INDEX idx_memories_fts ON _memory.memories USING gin(tsv);
```

### Schema design notes

- **`user_id` on every table**: single-tenant today (one user per Postgres server), but ready for future multi-user access to an OS instance
- **`seq` on interactions**: monotonic per session, guarantees ordering even when two events share the same millisecond timestamp
- **`UNIQUE (user_id, content)` on memories**: prevents duplicate memories, enables upsert on conflict
- **`confidence` on memories**: manual = 1.0, pattern-extracted = 0.9, LLM-extracted = varies (0.5-0.9 based on model certainty)
- **`access_count` + `last_accessed`**: enables memory decay and promotion strategies later
- **HNSW index** (not ivfflat): works on empty tables, no training data needed, better recall for small-to-medium datasets
- **`'simple'` tokenizer** for FTS: language-agnostic, works for English, Swedish, and any other language
- **`ON DELETE CASCADE`** on interactions: deleting a session removes its interactions
- **`ON DELETE SET NULL`** on memory source_session: deleting a session preserves memories but unlinks them
- **Partial indexes** on `task_id` and `tool_name`: only indexed where not null, saves space

### Interaction types

| Type | Content | Metadata |
|---|---|---|
| `user_message` | Raw user text | `{channel, attachments}` |
| `assistant_response` | Full assistant response | `{model, stop_reason}` |
| `tool_call` | Tool input (JSON stringified) | `{tool_name}` in metadata too for rich queries |
| `tool_result` | Tool output (truncated to 50KB) | `{success, error}` |

## Memory Extraction

### Inline pattern extraction (real-time)

Runs on every user message before kernel dispatch. Zero latency cost (regex only).

Patterns:
- "I prefer X" / "I always want X" / "my preference is X" -> `preference`
- "my name is X" / "I'm from X" / "I work as X" -> `fact`
- "remember that X" / "don't forget X" / "keep in mind X" -> `instruction`
- "always X" / "never X" -> `instruction`

Source: `pattern`, confidence: `0.9`.

### Async LLM extraction (post-session)

Runs after session ends. Analyzes the full interaction log (all types) to extract implicit preferences and patterns the user never explicitly stated.

Prompt structure:
```
Given this conversation between a user and their AI assistant, extract
facts, preferences, and instructions about the user. Focus on implicit
patterns -- things the user didn't explicitly say but their behavior reveals.

Examples of what to extract:
- User always asks for TypeScript, never Python -> preference: "prefers TypeScript over Python"
- User corrected the agent's tone twice -> instruction: "use casual, direct tone"
- User mentioned a deadline -> fact: "project deadline is March 30"

Return JSON: [{content, category, confidence}]

Conversation:
[... full interaction log ...]
```

Model: haiku (cheap, ~$0.01 per session). Source: `llm_extracted`, confidence: from model output (0.5-0.9).

## Hybrid Recall

When the gateway needs relevant memories (step 4 in the flow), or when the kernel calls the `recall` IPC tool, the system runs a combined FTS + vector similarity query.

Score weighting: **70% vector similarity, 30% keyword match**. Semantic understanding dominates, but exact keyword matches still boost relevance. Access stats (`last_accessed`, `access_count`) are updated on each recall to enable future decay/promotion strategies.

**Graceful degradation**: if no embedding API key is configured, memories are stored without embeddings. Recall falls back to FTS-only (same quality as current system, but on Postgres instead of SQLite). See the "Graceful Degradation" section below for the full implementation.

## Embedding Provider

**Provider**: OpenAI `text-embedding-3-small` (1536 dimensions, $0.02/1M tokens).

**Configuration**: API key in `~/system/config.json` under `memory.embeddingApiKey`, falling back to `OPENAI_API_KEY` env var.

**Cost**: a typical memory is ~30 tokens. 1000 memories = 30K tokens = $0.0006. Embedding is essentially free. The expensive part is the haiku extraction call (~$0.01 per session).

**Swappable**: the embedding service is a thin interface (`embed(text) -> Float32Array`, `embedBatch(texts) -> Float32Array[]`). Can swap to Voyage, Cohere, or local models later without changing the memory store.

## What Gets Replaced

| Current (file/SQLite) | New (Postgres) |
|---|---|
| `~/system/conversations/*.json` | `_memory.sessions` + `_memory.interactions` |
| `~/system/summaries/*.md` | `_memory.sessions.summary` |
| SQLite `memories` table + FTS5 | `_memory.memories` + pgvector + GIN |
| `packages/kernel/src/memory.ts` (createMemoryStore) | New Postgres-backed `memory-store.ts` in gateway |
| `packages/kernel/src/memory-search.ts` | Replaced by hybrid recall |
| `packages/kernel/src/conversation-history.ts` | Replaced by sessions/interactions queries |
| `search_conversations` IPC tool (file scan) | Replaced by Postgres query on `_memory.interactions` |

## What Stays

| Component | Reason |
|---|---|
| SOUL / identity / user files (`~/system/`) | Core identity, loaded into prompt registers -- not user memory |
| Knowledge files (`~/agents/knowledge/`) | Reference docs, demand-paged -- not personalization data |
| Skills files (`~/agents/skills/`) | Agent capabilities, demand-paged -- not user data |
| `qmd_search` IPC tool | Separate concern: searches knowledge files/specs/docs, not user memory |
| IPC tool interface (remember/recall/forget/list_memories) | Same API, new Postgres backend -- kernel doesn't know the difference |
| `buildSystemPrompt()` structure | Same section layout, memory injection point unchanged |

## Migration Path

1. **Phase 1**: Build Postgres memory store alongside existing SQLite. Gateway detects which backend is available.
2. **Phase 2**: Migration script reads SQLite `memories` table + `~/system/conversations/*.json` + `~/system/summaries/*.md`, writes to Postgres. Generates embeddings for existing memories.
3. **Phase 3**: Remove SQLite memory code, remove file-based conversation storage.

## Security

| Concern | Mitigation |
|---|---|
| User isolation | Every query includes `WHERE user_id = $1` |
| Content size | `interactions.content` truncated to 50KB at write time |
| Memory injection | Memories in prompt prefixed with `[memory]` category tag |
| Embedding API key | In config.json (file permissions), never logged, never in error messages |
| Memory cap | Max 1000 memories per user (soft limit, oldest low-confidence evicted) |
| SQL injection | All queries via Kysely parameterized, no string interpolation |
| Rate limiting | Max 50 `remember` calls per session to prevent abuse |

## Auth Matrix

| Endpoint / Operation | Auth |
|---|---|
| IPC tools (remember/recall/forget/list_memories) | Kernel-internal only (no HTTP exposure) |
| Interaction logging | Gateway-internal (automatic, no API) |
| Session lifecycle | Gateway-internal (automatic, no API) |
| Async extraction | Gateway-internal (post-session job) |
| Memory in system prompt | Gateway reads at dispatch time |

No new HTTP endpoints are exposed. All memory operations happen either through kernel IPC tools (agent-initiated) or gateway-internal logic (automatic logging/extraction).

## Session Lifecycle

A session starts when the first message arrives for a given `sessionId` (or a new UUID is generated if none provided). A session ends when any of these occur:

1. **WebSocket disconnect** -- the web shell client disconnects (immediate)
2. **Idle timeout** -- no new messages for 30 minutes (configurable in config.json under `memory.sessionIdleTimeoutMs`)
3. **Channel inactivity** -- for stateless channels (Telegram, WhatsApp), each message is its own session unless the caller provides a `sessionId` to continue
4. **Explicit close** -- caller sends a session-end signal (future API)

On session end, three things happen sequentially:
1. `sessions.ended_at` and `sessions.message_count` are updated
2. Summary generation runs (haiku, ~$0.01) and writes to `sessions.summary`
3. Async LLM extraction job is queued (can run after response is sent)

If the summary or extraction fails, the session is still marked as ended. Failures are logged but don't block the user.

## Interaction Logging: How the Gateway Captures Events

The dispatcher already yields `KernelEvent` objects from `spawnKernel()`. The gateway's dispatch loop processes these events for the WebSocket/channel response. We intercept the same stream to log interactions:

```typescript
// In dispatcher, wrapping the existing kernel event loop:
let seq = 0;

// Log the user message (before kernel runs)
await logInteraction(sessionId, userId, taskId, ++seq, 'user_message', message);

for await (const event of spawnKernel(message, config)) {
  // Existing: forward to WebSocket/channel
  yield event;

  // New: log to Postgres
  if (event.type === 'tool_use') {
    await logInteraction(sessionId, userId, taskId, ++seq, 'tool_call',
      JSON.stringify(event.input), { toolName: event.name });
  } else if (event.type === 'tool_result') {
    await logInteraction(sessionId, userId, taskId, ++seq, 'tool_result',
      truncate(event.content, 50_000), { toolName: event.name });
  } else if (event.type === 'text' && event.final) {
    await logInteraction(sessionId, userId, taskId, ++seq, 'assistant_response',
      event.content);
  }
}
```

Logging is fire-and-forget (non-blocking). If a log write fails, the user's conversation continues unaffected.

## Memory Supersession

Inspired by Zep/Graphiti's temporal model: when new information contradicts an existing memory, the old memory should be updated rather than duplicated.

The UNIQUE constraint on `(user_id, content)` handles exact duplicates. For semantic conflicts (e.g., "works at Acme" vs "works at Bolt"), the LLM extraction prompt includes existing memories as context:

```
Existing memories for this user:
- [fact] Works at Acme Corp
- [preference] Prefers dark mode
- ...

Given this conversation, extract NEW or UPDATED facts. If a new fact
contradicts an existing one, output it with action: "update" and the
ID of the memory to replace. If it's genuinely new, use action: "add".

Return JSON: [{content, category, confidence, action, replaceId?}]
```

When `action: "update"`, the gateway updates the existing memory's content, recomputes the embedding, and bumps `updated_at`. This gives us temporal accuracy without a full knowledge graph.

## Graceful Degradation: Recall Without Embeddings

The `recallMemories()` function must handle memories with NULL embeddings (no API key configured):

```typescript
async function recallMemories(userId: string, query: string, limit = 10): Promise<Memory[]> {
  const embedding = embeddings.available ? await embeddings.embed(query) : null;

  if (embedding) {
    // Full hybrid: FTS + vector
    return await sql`
      SELECT *,
        ts_rank(tsv, plainto_tsquery('simple', ${query})) AS fts_score,
        CASE WHEN embedding IS NOT NULL
          THEN 1 - (embedding <=> ${embedding}::vector)
          ELSE 0
        END AS vec_score
      FROM _memory.memories
      WHERE user_id = ${userId}
        AND (
          tsv @@ plainto_tsquery('simple', ${query})
          OR (embedding IS NOT NULL AND embedding <=> ${embedding}::vector < 0.5)
        )
      ORDER BY (
        COALESCE(ts_rank(tsv, plainto_tsquery('simple', ${query})), 0) * 0.3 +
        CASE WHEN embedding IS NOT NULL
          THEN (1 - (embedding <=> ${embedding}::vector)) * 0.7
          ELSE 0
        END
      ) DESC
      LIMIT ${limit}
    `;
  } else {
    // FTS-only fallback
    return await sql`
      SELECT *, ts_rank(tsv, plainto_tsquery('simple', ${query})) AS fts_score
      FROM _memory.memories
      WHERE user_id = ${userId} AND tsv @@ plainto_tsquery('simple', ${query})
      ORDER BY fts_score DESC
      LIMIT ${limit}
    `;
  }
}
```

## Competitive Landscape

We evaluated existing AI memory solutions before designing this system. Summary:

| Solution | Model | Language | Self-hosted | Verdict |
|---|---|---|---|---|
| **Mem0** (51K stars, $24M Series A) | LLM fact extraction + conflict resolution + vector search. Graph memory (entity/relationship) paywalled at $249/mo. 24+ vector backends, 19+ LLM providers. | Python | Yes (Docker + Qdrant + Neo4j for graph) | Best extraction pipeline. But Python, no conversation history, graph memory is Pro-only. Key pattern borrowed: LLM conflict resolution (ADD/UPDATE/DELETE actions). |
| **OpenMemory MCP** (by Mem0) | MCP server wrapping Mem0. 5 tools (add/search/list/delete). SSE + Streamable HTTP. Dashboard included. | Python | Yes (Docker Compose: FastAPI + Qdrant + Next.js) | Ready-made MCP integration, but 3-container stack for a memory layer is heavy. No conversation storage. |
| **Zep / Graphiti** | Temporal knowledge graph | Python | Graphiti only (needs Neo4j) | Temporal model worth borrowing. Graph DB dependency too heavy. |
| **Letta (MemGPT)** | OS-inspired memory tiers, agent self-manages | Python | Yes (Docker + Postgres) | Closest philosophy to Matrix OS. But it's a full framework, not a memory layer. |
| **Supermemory** | Hybrid vector + graph | TypeScript | Cloud only (enterprise for self-host) | Best benchmarks, TypeScript native. But closed-source engine is a dealbreaker. |
| **LangMem** | Hot path + background extraction | Python only | Yes (library) | Lightweight but Python-only, tightly coupled to LangGraph, low activity. |
| **Cognee** | ECL pipeline (extract, cognify, load) | Python | Yes (Docker, pgvector support) | Most flexible. Could be a future sidecar. But adds Python runtime. |
| **Pinecone** | Managed vector DB | N/A (API) | Cloud only | Not a memory solution, just storage. Cloud-only contradicts self-hosted principle. |

**Decision: build our own.** Reasons:
1. All viable solutions are Python -- Matrix OS is TypeScript. A sidecar adds deployment complexity.
2. None understand the "Everything Is a File" principle or the Agent SDK kernel model.
3. The core algorithms (LLM extraction, hybrid FTS+vector recall) are straightforward to implement.
4. We already have Postgres + Kysely. Adding pgvector is one `CREATE EXTENSION`.
5. Key ideas borrowed: temporal supersession (Zep), ECL pipeline pattern (Cognee), memory tiers (Letta), user profiles (Supermemory).
