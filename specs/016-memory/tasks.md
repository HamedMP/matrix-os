# Tasks: Memory / RAG System

**Task range**: T640-T652
**Parallel**: YES -- independent module. New files only. Touches ipc-server.ts (add tools) and prompt.ts (inject memories).
**Deps**: None. SQLite infrastructure already exists (Drizzle ORM, better-sqlite3).

## User Story

- **US-MEM1**: "The OS remembers things about me across conversations -- preferences, facts, context -- without me repeating myself"

## Architecture

File-based + SQLite approach (no external vector DB):

1. **Storage**: SQLite table with FTS5 virtual table for full-text search. Alternative: `sqlite-vec` extension if available, but FTS5 is built-in and sufficient for personal-scale data.
2. **Memory entries**: `{ id, content, source, category, createdAt, updatedAt }`. Source tracks where memory came from (conversation ID, manual). Category: `preference`, `fact`, `context`, `instruction`.
3. **File export**: Memories also written to `~/system/memory/` as .md files for transparency (Everything Is a File). SQLite is the query engine, files are the backup/export.
4. **Injection**: Top-N relevant memories injected into system prompt before conversation, within token budget.

Key files:
- `packages/kernel/src/memory.ts` (new -- memory store)
- `packages/kernel/src/db.ts` (add memories table + FTS5)
- `packages/kernel/src/ipc-server.ts` (add remember/recall/forget tools)
- `packages/kernel/src/prompt.ts` (inject relevant memories)
- `home/system/memory/` (file export directory)

## Tests (TDD -- write FIRST)

- [ ] T640a [P] [US-MEM1] Write `tests/kernel/memory.test.ts`:
  - `createMemoryStore(db)` initializes FTS5 table
  - `remember(content, opts)` inserts memory entry
  - `recall(query, limit)` returns relevant memories ranked by FTS5 score
  - `forget(id)` removes memory entry
  - `listAll()` returns all memories
  - Duplicate detection: remembering the same content twice updates instead of duplicating
  - Category filtering: `recall(query, { category: "preference" })` only searches preferences
  - Memory export: writes .md file to memory directory

- [ ] T640b [P] [US-MEM1] Write `tests/kernel/prompt-memory.test.ts`:
  - `buildSystemPrompt()` includes relevant memories section when memories exist
  - Memory section stays within token budget (doesn't crowd out other sections)
  - Empty memories = no memory section in prompt

## Implementation

### Schema

- [ ] T641 [US-MEM1] Add memory table to `packages/kernel/src/db.ts`:
  - Table: `memories` -- `id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT, category TEXT DEFAULT 'fact', created_at TEXT, updated_at TEXT`
  - FTS5 virtual table: `memories_fts` on `content` column
  - Migration: create table + FTS5 on DB init (same pattern as tasks table)

### Memory Store

- [ ] T642 [US-MEM1] Implement `createMemoryStore(db)` in `packages/kernel/src/memory.ts`:
  - `remember(content, opts?: { source?, category? })`: insert into memories + FTS5. Check for duplicates (same content within edit distance). Returns memory ID.
  - `recall(query, opts?: { limit?, category? })`: FTS5 MATCH query, return ranked results. Default limit: 10.
  - `forget(id)`: delete from memories + FTS5.
  - `listAll(opts?: { category?, limit? })`: list all memories, optionally filtered.
  - `exportToFiles(memoryDir)`: write each memory as `{id}.md` with frontmatter (category, source, dates). Overwrite existing files, remove files for deleted memories.
  - `count()`: total memory count.

### IPC Tools

- [ ] T643 [US-MEM1] Add memory IPC tools to `ipc-server.ts`:
  - `remember` -- `{ content: string, category?: string }`. Stores a memory. Use when user says "remember that...", "I prefer...", "my X is Y".
  - `recall` -- `{ query: string, limit?: number, category?: string }`. Searches memories. Use when kernel needs context that might have been stored before.
  - `forget` -- `{ id: string }`. Removes a specific memory. Use when user says "forget that", "that's no longer true".
  - `list_memories` -- `{ category?: string }`. Lists all stored memories. Use when user asks "what do you remember about me?"

### Auto-Extraction (Optional, Configurable)

- [ ] T644 [US-MEM1] Auto-memory extraction in `packages/kernel/src/memory.ts`:
  - `extractMemories(conversation: ConversationMessage[])`: analyze conversation for memorable facts.
  - Pattern matching for: "I prefer X", "My name is X", "I always want X", "Remember that X", explicit instructions.
  - Returns `{ content, category }[]` candidates.
  - Called after conversation finalize (gateway integration point).
  - Gated by config: `config.json` -> `"memory": { "autoExtract": true }`.

### System Prompt Integration

- [ ] T645 [US-MEM1] Inject memories into system prompt in `packages/kernel/src/prompt.ts`:
  - Before conversation starts, call `recall(userMessage, { limit: 5 })` with the user's latest message.
  - Format as section: `## Relevant Memories\n- [preference] User prefers dark themes\n- [fact] User's timezone is CET`.
  - Budget: max 300 tokens for memory section (within existing 7K budget).
  - If no relevant memories, omit section entirely.

### File Export

- [ ] T646 [US-MEM1] Memory directory in home template:
  - Add `home/system/memory/` directory (empty, with .gitkeep).
  - `exportToFiles()` called periodically (on gateway shutdown, or after N new memories).
  - Each file: `{category}-{id-prefix}.md` with frontmatter.

## Implications

- FTS5 is built into SQLite (no extra native dependencies). This is critical -- no `sqlite-vec` compilation issues.
- Memory injection adds to system prompt token count. T100j token budgeting must account for this. The 300-token cap is a safeguard.
- Auto-extraction (T644) is optional and configurable. Start with manual `remember` tool only, add auto-extraction as enhancement.
- `recall` during prompt building adds a DB query per message. For personal-scale data (<10K memories), this is <1ms. Not a concern.
- File export (T646) ensures Everything Is a File principle. User can edit/delete memory .md files directly, and they'll be respected on next load.
- Future: when sqlite-vec is stable and easy to install, could add embedding-based search alongside FTS5 for better semantic matching.

## Checkpoint

- [ ] User says "Remember that I prefer dark themes" -- kernel stores memory.
- [ ] New conversation: ask "What theme do I like?" -- kernel recalls memory and answers correctly.
- [ ] "Forget that preference" -- memory deleted.
- [ ] `~/system/memory/` contains .md files matching stored memories.
- [ ] `bun run test` passes.
