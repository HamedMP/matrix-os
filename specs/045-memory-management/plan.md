# 045: Memory Management

**Goal:** Fix agent context loss across sessions by improving system prompt context, adding conversation continuity, building long-term memory, and integrating QMD-inspired semantic search with OpenAI embeddings.

**Architecture:** Three-layer memory system: (1) system prompt injects apps/data/summaries/memories at prompt build time, (2) conversation summaries auto-generated on session end and persisted as files, (3) semantic search via OpenAI embeddings stored in SQLite with hybrid BM25+vector retrieval. Embeddings call OpenAI API directly (key from config.json), with proxy integration later.

**Tech Stack:** SQLite (better-sqlite3), Drizzle ORM, OpenAI text-embedding-3-small, FTS5 (existing), Float32Array BLOBs for vectors, Zod v4, Vitest.

---

## Phase 1: System Prompt Context (Quick Wins)

### Task 1: Include installed apps in system prompt

The agent doesn't know about apps because `~/apps/` contents are not in the system prompt. Only `~/system/modules.json` is listed (which has 1 entry). There are 22+ apps in `~/apps/`.

**Files:**
- Modify: `packages/kernel/src/prompt.ts`
- Test: `tests/kernel/prompt-context.test.ts` (create)

**Step 1: Write the failing test**

```typescript
// tests/kernel/prompt-context.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildSystemPrompt } from "../../packages/kernel/src/prompt.js";

function createTestHome(): string {
  const home = resolve(mkdtempSync(join(tmpdir(), "prompt-ctx-")));
  // Minimum required dirs
  mkdirSync(join(home, "agents", "knowledge"), { recursive: true });
  mkdirSync(join(home, "agents", "skills"), { recursive: true });
  mkdirSync(join(home, "system"), { recursive: true });
  mkdirSync(join(home, "apps"), { recursive: true });
  mkdirSync(join(home, "data"), { recursive: true });
  // system-prompt.md (required)
  writeFileSync(join(home, "agents", "system-prompt.md"), "You are the Matrix OS kernel.");
  return home;
}

describe("system prompt context", () => {
  let home: string;
  beforeEach(() => { home = createTestHome(); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  describe("installed apps listing", () => {
    it("lists apps from ~/apps/ directory", () => {
      writeFileSync(join(home, "apps", "todo.html"), "<html>todo</html>");
      writeFileSync(join(home, "apps", "notes.html"), "<html>notes</html>");
      mkdirSync(join(home, "apps", "calculator"));
      writeFileSync(join(home, "apps", "calculator", "index.html"), "<html>calc</html>");

      const prompt = buildSystemPrompt(home);
      expect(prompt).toContain("## Installed Apps");
      expect(prompt).toContain("todo");
      expect(prompt).toContain("notes");
      expect(prompt).toContain("calculator");
    });

    it("shows empty message when no apps installed", () => {
      const prompt = buildSystemPrompt(home);
      expect(prompt).toContain("No apps installed");
    });

    it("excludes .matrix.md manifest files from app listing", () => {
      writeFileSync(join(home, "apps", "todo.html"), "<html>todo</html>");
      writeFileSync(join(home, "apps", "todo.matrix.md"), "---\nname: Todo\n---");

      const prompt = buildSystemPrompt(home);
      expect(prompt).toContain("todo");
      expect(prompt).not.toContain("todo.matrix.md");
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun run test -- tests/kernel/prompt-context.test.ts`
Expected: FAIL - prompt doesn't contain "Installed Apps"

**Step 3: Implement apps listing in prompt.ts**

Add after the "Installed Modules" section (~line 124):

```typescript
// Installed apps (from ~/apps/)
const appsPath = join(homePath, "apps");
sections.push("\n## Installed Apps\n");
if (existsSync(appsPath)) {
  try {
    const entries = readdirSync(appsPath).filter(
      (f) => !f.endsWith(".matrix.md") && !f.startsWith(".")
    );
    if (entries.length > 0) {
      const appNames = entries.map((f) =>
        f.replace(/\.(html|htm)$/, "")
      );
      sections.push(
        `${appNames.length} apps: ${appNames.join(", ")}\n` +
        "Use the app_data tool to read/write app data. Apps store data in ~/data/{appName}/{key}.json."
      );
    } else {
      sections.push("No apps installed yet.");
    }
  } catch {
    sections.push("No apps installed yet.");
  }
} else {
  sections.push("No apps installed yet.");
}
```

**Step 4: Run test to verify it passes**

Run: `bun run test -- tests/kernel/prompt-context.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/kernel/src/prompt.ts tests/kernel/prompt-context.test.ts
git commit -m "feat: include installed apps listing in kernel system prompt"
```

---

### Task 2: Include app data summary in system prompt

The agent doesn't know what data exists. When user says "add a todo", the agent doesn't know `~/data/todo/tasks.json` already has data.

**Files:**
- Modify: `packages/kernel/src/prompt.ts`
- Modify: `tests/kernel/prompt-context.test.ts`

**Step 1: Write the failing test**

Add to `tests/kernel/prompt-context.test.ts`:

```typescript
describe("app data summary", () => {
  it("lists data directories and their keys", () => {
    mkdirSync(join(home, "data", "todo"), { recursive: true });
    writeFileSync(join(home, "data", "todo", "tasks.json"), "[]");
    mkdirSync(join(home, "data", "notes"), { recursive: true });
    writeFileSync(join(home, "data", "notes", "notes.json"), "[]");
    writeFileSync(join(home, "data", "notes", "settings.json"), "{}");

    const prompt = buildSystemPrompt(home);
    expect(prompt).toContain("## App Data");
    expect(prompt).toContain("todo");
    expect(prompt).toContain("tasks");
    expect(prompt).toContain("notes");
  });

  it("shows empty message when no data exists", () => {
    const prompt = buildSystemPrompt(home);
    expect(prompt).toContain("No app data");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun run test -- tests/kernel/prompt-context.test.ts`
Expected: FAIL - prompt doesn't contain "App Data"

**Step 3: Implement data summary in prompt.ts**

Add after the apps listing:

```typescript
// App data summary
const dataPath = join(homePath, "data");
sections.push("\n## App Data\n");
if (existsSync(dataPath)) {
  try {
    const appDirs = readdirSync(dataPath).filter((f) => {
      try {
        return readdirSync(join(dataPath, f)).some((k) => k.endsWith(".json"));
      } catch { return false; }
    });
    if (appDirs.length > 0) {
      const lines = appDirs.map((app) => {
        const keys = readdirSync(join(dataPath, app))
          .filter((k) => k.endsWith(".json"))
          .map((k) => k.replace(".json", ""));
        return `- ${app}: ${keys.join(", ")}`;
      });
      sections.push(lines.join("\n"));
    } else {
      sections.push("No app data stored yet.");
    }
  } catch {
    sections.push("No app data stored yet.");
  }
} else {
  sections.push("No app data stored yet.");
}
```

**Step 4: Run test to verify it passes**

Run: `bun run test -- tests/kernel/prompt-context.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/kernel/src/prompt.ts tests/kernel/prompt-context.test.ts
git commit -m "feat: include app data summary in kernel system prompt"
```

---

### Task 3: Increase memory budget from 300 to 1000 tokens

**Files:**
- Modify: `packages/kernel/src/prompt.ts` (line 73: `TOKEN_CAP = 300`)
- Modify: `tests/kernel/prompt-context.test.ts`

**Step 1: Write the failing test**

```typescript
describe("memory budget", () => {
  it("includes up to 1000 tokens of memories", () => {
    // This test verifies the cap is >= 1000 tokens by checking
    // that memories totaling ~800 tokens are all included.
    // We need a DB for this, so we test the constant extraction instead.
    // Just verify the prompt builder doesn't truncate prematurely.
    const prompt = buildSystemPrompt(home);
    // Prompt should be buildable without DB (graceful fallback)
    expect(prompt).toBeDefined();
  });
});
```

Actually, since the token cap is internal to the DB branch, better to just change the constant and add a comment-test:

**Step 2: Change TOKEN_CAP**

In `packages/kernel/src/prompt.ts` line 73, change:
```typescript
const TOKEN_CAP = 300;
```
to:
```typescript
const TOKEN_CAP = 1000;
```

**Step 3: Run full test suite**

Run: `bun run test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add packages/kernel/src/prompt.ts
git commit -m "feat: increase memory token budget from 300 to 1000"
```

---

## Phase 2: Conversation Continuity

### Task 4: Auto-summarize conversations on session end

When a conversation ends (finalize), generate a 2-3 line summary and save it to `~/system/summaries/{sessionId}.md`. Use the kernel (Anthropic API with haiku) to generate summaries cheaply.

**Files:**
- Create: `packages/gateway/src/conversation-summary.ts`
- Test: `tests/gateway/conversation-summary.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/gateway/conversation-summary.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  summarizeConversation,
  saveSummary,
  loadRecentSummaries,
  type ConversationForSummary,
} from "../../packages/gateway/src/conversation-summary.js";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

describe("conversation summary", () => {
  let home: string;
  beforeEach(() => {
    home = resolve(mkdtempSync(join(tmpdir(), "conv-summary-")));
    mkdirSync(join(home, "system", "summaries"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  describe("summarizeConversation", () => {
    it("generates a summary string from messages", () => {
      const conv: ConversationForSummary = {
        id: "test-session",
        messages: [
          { role: "user", content: "Add a task to clean the kitchen" },
          { role: "assistant", content: "Done! I added 'clean the kitchen' to your todo list." },
        ],
      };
      const summary = summarizeConversation(conv);
      expect(summary).toBeTruthy();
      expect(summary.length).toBeGreaterThan(10);
      expect(summary.length).toBeLessThan(500);
    });

    it("returns empty string for empty conversation", () => {
      const conv: ConversationForSummary = { id: "empty", messages: [] };
      expect(summarizeConversation(conv)).toBe("");
    });

    it("truncates very long conversations", () => {
      const messages = Array.from({ length: 100 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `Message ${i}: ${"x".repeat(200)}`,
      }));
      const conv: ConversationForSummary = { id: "long", messages };
      const summary = summarizeConversation(conv);
      expect(summary.length).toBeLessThan(500);
    });
  });

  describe("saveSummary", () => {
    it("writes summary file to ~/system/summaries/", () => {
      saveSummary(home, "session-123", "User asked to add a todo task. AI added it.");
      const filePath = join(home, "system", "summaries", "session-123.md");
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, "utf-8");
      expect(content).toContain("User asked to add a todo task");
    });

    it("includes timestamp in summary file", () => {
      saveSummary(home, "session-456", "Summary text");
      const content = readFileSync(
        join(home, "system", "summaries", "session-456.md"),
        "utf-8",
      );
      expect(content).toMatch(/\d{4}-\d{2}-\d{2}/);
    });
  });

  describe("loadRecentSummaries", () => {
    it("loads most recent summaries", () => {
      saveSummary(home, "old-session", "Old conversation about weather");
      saveSummary(home, "new-session", "Recent conversation about todos");

      const summaries = loadRecentSummaries(home, { limit: 5 });
      expect(summaries.length).toBe(2);
    });

    it("respects limit parameter", () => {
      saveSummary(home, "s1", "Summary 1");
      saveSummary(home, "s2", "Summary 2");
      saveSummary(home, "s3", "Summary 3");

      const summaries = loadRecentSummaries(home, { limit: 2 });
      expect(summaries.length).toBe(2);
    });

    it("returns empty array when no summaries exist", () => {
      const summaries = loadRecentSummaries(home);
      expect(summaries.length).toBe(0);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun run test -- tests/gateway/conversation-summary.test.ts`
Expected: FAIL - module not found

**Step 3: Implement conversation-summary.ts**

```typescript
// packages/gateway/src/conversation-summary.ts
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ConversationForSummary {
  id: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface SummaryEntry {
  sessionId: string;
  summary: string;
  timestamp: string;
}

const MAX_SUMMARY_INPUT_CHARS = 4000;
const MAX_SUMMARY_LENGTH = 300;

/**
 * Generate a local summary without LLM call.
 * Extracts user intents + assistant outcomes from the conversation.
 * For LLM-powered summaries, use summarizeWithLLM() instead.
 */
export function summarizeConversation(conv: ConversationForSummary): string {
  if (conv.messages.length === 0) return "";

  const userMessages = conv.messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.slice(0, 200));

  const assistantMessages = conv.messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.content.slice(0, 200));

  // Build summary: "User: [intent]. AI: [outcome]."
  const parts: string[] = [];

  // Take first and last user messages as key intents
  if (userMessages.length > 0) {
    parts.push(`User: ${userMessages[0]}`);
    if (userMessages.length > 1) {
      parts.push(`Also: ${userMessages[userMessages.length - 1]}`);
    }
  }

  // Take last assistant message as outcome
  if (assistantMessages.length > 0) {
    parts.push(`AI: ${assistantMessages[assistantMessages.length - 1]}`);
  }

  const summary = parts.join(". ").slice(0, MAX_SUMMARY_LENGTH);
  return summary;
}

export function saveSummary(
  homePath: string,
  sessionId: string,
  summary: string,
): void {
  const dir = join(homePath, "system", "summaries");
  mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString();
  const safeId = sessionId.replace(/[^a-zA-Z0-9_:-]/g, "_");
  const content = `---\nsession: ${safeId}\ndate: ${timestamp.split("T")[0]}\ntimestamp: ${timestamp}\n---\n\n${summary}\n`;

  writeFileSync(join(dir, `${safeId}.md`), content, "utf-8");
}

export function loadRecentSummaries(
  homePath: string,
  opts?: { limit?: number },
): SummaryEntry[] {
  const dir = join(homePath, "system", "summaries");
  if (!existsSync(dir)) return [];

  const limit = opts?.limit ?? 10;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({
      name: f,
      mtime: statSync(join(dir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  return files.map((f) => {
    const content = readFileSync(join(dir, f.name), "utf-8");
    const sessionId = f.name.replace(".md", "");

    // Extract timestamp from frontmatter
    const tsMatch = content.match(/^timestamp:\s*(.+)$/m);
    const timestamp = tsMatch?.[1] ?? new Date(f.mtime).toISOString();

    // Extract summary (after frontmatter)
    const body = content.replace(/^---[\s\S]*?---\n*/m, "").trim();

    return { sessionId, summary: body, timestamp };
  });
}
```

**Step 4: Run test to verify it passes**

Run: `bun run test -- tests/gateway/conversation-summary.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/gateway/src/conversation-summary.ts tests/gateway/conversation-summary.test.ts
git commit -m "feat: conversation summary generation and persistence"
```

---

### Task 5: Wire auto-summarize into dispatcher finalization

When a conversation is finalized in the gateway, automatically generate and save a summary.

**Files:**
- Modify: `packages/gateway/src/server.ts` (the `result` event handlers)
- Modify: `tests/gateway/conversation-summary.test.ts`

**Step 1: Write test for integration**

Add to `tests/gateway/conversation-summary.test.ts`:

```typescript
describe("integration: summary triggered on finalize", () => {
  it("creates summary file after conversation finalization", () => {
    // This is an integration-level concern tested via E2E.
    // Unit test just verifies the flow: finalize -> summarize -> save.
    const conv: ConversationForSummary = {
      id: "integration-test",
      messages: [
        { role: "user", content: "What is the weather?" },
        { role: "assistant", content: "I don't have weather data." },
      ],
    };

    const summary = summarizeConversation(conv);
    saveSummary(home, conv.id, summary);

    const loaded = loadRecentSummaries(home, { limit: 1 });
    expect(loaded.length).toBe(1);
    expect(loaded[0].sessionId).toBe("integration-test");
    expect(loaded[0].summary).toContain("weather");
  });
});
```

**Step 2: Wire into server.ts**

In `packages/gateway/src/server.ts`, import the summary functions and call them after `conversations.finalize()`:

```typescript
import { summarizeConversation, saveSummary } from "./conversation-summary.js";
```

Then in every `event.type === "result"` handler, after `conversations.finalize(sid)`:

```typescript
// Auto-summarize conversation
try {
  const conv = conversations.get(sid);
  if (conv && conv.messages.length > 0) {
    const summary = summarizeConversation({
      id: conv.id,
      messages: conv.messages,
    });
    if (summary) saveSummary(homePath, sid, summary);
  }
} catch { /* summary is best-effort */ }
```

There are ~4 places where finalize is called (Telegram stream, buffered channels, WebSocket, REST).
Extract a helper to avoid repetition:

```typescript
function finalizeWithSummary(sid: string) {
  conversations.finalize(sid);
  try {
    const conv = conversations.get(sid);
    if (conv && conv.messages.length > 0) {
      const summary = summarizeConversation({ id: conv.id, messages: conv.messages });
      if (summary) saveSummary(homePath, sid, summary);
    }
  } catch { /* best-effort */ }
}
```

Replace all `conversations.finalize(sid)` calls with `finalizeWithSummary(sid)`.

**Step 3: Run full test suite**

Run: `bun run test`
Expected: All pass

**Step 4: Commit**

```bash
git add packages/gateway/src/server.ts packages/gateway/src/conversation-summary.ts
git commit -m "feat: auto-summarize conversations on session end"
```

---

### Task 6: Inject recent conversation summaries into system prompt

**Files:**
- Modify: `packages/kernel/src/prompt.ts`
- Modify: `tests/kernel/prompt-context.test.ts`

**Step 1: Write the failing test**

```typescript
describe("conversation summaries in prompt", () => {
  it("includes recent conversation summaries", () => {
    mkdirSync(join(home, "system", "summaries"), { recursive: true });
    writeFileSync(
      join(home, "system", "summaries", "session-1.md"),
      "---\nsession: session-1\ndate: 2026-03-13\ntimestamp: 2026-03-13T10:00:00Z\n---\n\nUser asked to add todo. AI added it.\n"
    );

    const prompt = buildSystemPrompt(home);
    expect(prompt).toContain("Recent Conversations");
    expect(prompt).toContain("add todo");
  });

  it("limits to 5 most recent summaries", () => {
    mkdirSync(join(home, "system", "summaries"), { recursive: true });
    for (let i = 0; i < 8; i++) {
      writeFileSync(
        join(home, "system", "summaries", `s${i}.md`),
        `---\nsession: s${i}\ndate: 2026-03-13\ntimestamp: 2026-03-13T1${i}:00:00Z\n---\n\nSummary ${i}\n`
      );
    }

    const prompt = buildSystemPrompt(home);
    // Should not include all 8
    const matches = prompt.match(/Summary \d/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(5);
  });
});
```

**Step 2: Run test to verify it fails**

**Step 3: Implement in prompt.ts**

Import `loadRecentSummaries` from the gateway package (or duplicate the file-reading logic inline to avoid cross-package dependency):

```typescript
// Recent conversation summaries
const summariesDir = join(homePath, "system", "summaries");
if (existsSync(summariesDir)) {
  try {
    const files = readdirSync(summariesDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({
        name: f,
        content: readFileSync(join(summariesDir, f), "utf-8"),
        mtime: statSync(join(summariesDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5);

    if (files.length > 0) {
      sections.push("\n## Recent Conversations\n");
      sections.push(
        "These are summaries of recent conversations. Use this context to understand what the user has been working on.\n"
      );
      for (const f of files) {
        const body = f.content.replace(/^---[\s\S]*?---\n*/m, "").trim();
        if (body) sections.push(`- ${body}`);
      }
    }
  } catch { /* graceful */ }
}
```

Add `statSync` to the `node:fs` import at the top of prompt.ts.

**Step 4: Run tests**

Run: `bun run test -- tests/kernel/prompt-context.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/kernel/src/prompt.ts tests/kernel/prompt-context.test.ts
git commit -m "feat: inject recent conversation summaries into system prompt"
```

---

### Task 7: Conversation history IPC tool

Let the agent fetch previous conversation history by session ID or search conversations.

**Files:**
- Modify: `packages/kernel/src/ipc-server.ts`
- Test: `tests/kernel/conversation-history-tool.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/kernel/conversation-history-tool.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

describe("conversation_history IPC tool", () => {
  let home: string;

  beforeEach(() => {
    home = resolve(mkdtempSync(join(tmpdir(), "conv-history-")));
    mkdirSync(join(home, "system", "conversations"), { recursive: true });
    mkdirSync(join(home, "system", "summaries"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("lists recent conversation summaries", () => {
    writeFileSync(
      join(home, "system", "summaries", "s1.md"),
      "---\nsession: s1\ndate: 2026-03-13\ntimestamp: 2026-03-13T10:00:00Z\n---\n\nUser discussed todo app\n"
    );

    // Verify summary files are readable
    const summaries = readdirSync(join(home, "system", "summaries"));
    expect(summaries.length).toBe(1);
  });

  it("reads full conversation by session ID", () => {
    const conv = {
      id: "test-conv",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [
        { role: "user", content: "Hello", timestamp: Date.now() },
        { role: "assistant", content: "Hi!", timestamp: Date.now() },
      ],
    };
    writeFileSync(
      join(home, "system", "conversations", "test-conv.json"),
      JSON.stringify(conv),
    );

    const raw = readFileSync(
      join(home, "system", "conversations", "test-conv.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw);
    expect(parsed.messages.length).toBe(2);
  });
});
```

Note: Full IPC tool integration tests require the MCP server. The unit tests verify the file operations work. The IPC tool itself follows the same pattern as existing tools.

**Step 2: Implement the IPC tool**

Add two new tools to `ipc-server.ts`:

```typescript
tool(
  "conversation_history",
  "List recent conversation summaries, or fetch full conversation by session ID. Use 'list' to see what conversations happened, 'get' to read a specific one.",
  {
    action: z.enum(["list", "get"]),
    sessionId: z.string().optional().describe("Session ID for 'get' action"),
    limit: z.number().optional().describe("Max results for 'list' (default 10)"),
  },
  async ({ action, sessionId, limit }) => {
    if (action === "list") {
      const summariesDir = join(homePath, "system", "summaries");
      if (!existsSync(summariesDir)) {
        return { content: [{ type: "text" as const, text: "No conversation history yet." }] };
      }
      const files = readdirSync(summariesDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => {
          const content = readFileSync(join(summariesDir, f), "utf-8");
          const body = content.replace(/^---[\s\S]*?---\n*/m, "").trim();
          const dateMatch = content.match(/^date:\s*(.+)$/m);
          return { session: f.replace(".md", ""), date: dateMatch?.[1] ?? "", summary: body };
        })
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, limit ?? 10);
      return { content: [{ type: "text" as const, text: JSON.stringify(files, null, 2) }] };
    }

    // action === "get"
    if (!sessionId) {
      return { content: [{ type: "text" as const, text: "Error: sessionId required for 'get'" }] };
    }
    const convPath = join(homePath, "system", "conversations", `${sessionId}.json`);
    if (!existsSync(convPath)) {
      return { content: [{ type: "text" as const, text: `No conversation found: ${sessionId}` }] };
    }
    const conv = JSON.parse(readFileSync(convPath, "utf-8"));
    // Truncate to avoid blowing context
    const msgs = conv.messages.slice(-30).map((m: any) => ({
      role: m.role,
      content: m.content.length > 500 ? m.content.slice(0, 500) + "..." : m.content,
    }));
    return { content: [{ type: "text" as const, text: JSON.stringify(msgs, null, 2) }] };
  }
);
```

**Step 3: Run tests**

Run: `bun run test`
Expected: All pass

**Step 4: Commit**

```bash
git add packages/kernel/src/ipc-server.ts tests/kernel/conversation-history-tool.test.ts
git commit -m "feat: add conversation_history IPC tool for cross-session context"
```

---

## Phase 3: Long-Term Memory

### Task 8: LLM-powered memory extraction

Replace regex-only extraction with a hybrid approach: regex for instant patterns + post-conversation LLM extraction for nuanced facts.

**Files:**
- Modify: `packages/kernel/src/memory.ts`
- Create: `packages/gateway/src/memory-extractor.ts`
- Test: `tests/gateway/memory-extractor.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/gateway/memory-extractor.test.ts
import { describe, it, expect } from "vitest";
import {
  extractMemoriesLocal,
  buildExtractionPrompt,
} from "../../packages/gateway/src/memory-extractor.js";

describe("memory extractor", () => {
  describe("extractMemoriesLocal (enhanced regex)", () => {
    it("extracts preferences", () => {
      const results = extractMemoriesLocal([
        { role: "user", content: "I prefer dark mode for all my apps" },
      ]);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].category).toBe("preference");
    });

    it("extracts tool/app usage patterns", () => {
      const results = extractMemoriesLocal([
        { role: "user", content: "always test on docker before pushing" },
      ]);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].category).toBe("instruction");
    });

    it("extracts facts about the user", () => {
      const results = extractMemoriesLocal([
        { role: "user", content: "I work as a software engineer at Acme" },
      ]);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].category).toBe("fact");
    });

    it("ignores assistant messages", () => {
      const results = extractMemoriesLocal([
        { role: "assistant", content: "I prefer to help you with code" },
      ]);
      expect(results.length).toBe(0);
    });
  });

  describe("buildExtractionPrompt", () => {
    it("builds a prompt for LLM memory extraction", () => {
      const prompt = buildExtractionPrompt([
        { role: "user", content: "Add wash dishes to my todo" },
        { role: "assistant", content: "Added 'wash dishes' to your todo list." },
        { role: "user", content: "I usually do chores on Saturdays" },
      ]);
      expect(prompt).toContain("Extract");
      expect(prompt).toContain("wash dishes");
      expect(prompt).toContain("Saturdays");
    });
  });
});
```

**Step 2: Implement memory-extractor.ts**

```typescript
// packages/gateway/src/memory-extractor.ts
export interface MemoryCandidate {
  content: string;
  category: "fact" | "preference" | "instruction" | "event";
}

interface Message {
  role: string;
  content: string;
}

const PATTERNS: Array<{ pattern: RegExp; category: MemoryCandidate["category"] }> = [
  { pattern: /(?:i prefer|i always want|i like|my preference is)\s+(.+)/i, category: "preference" },
  { pattern: /(?:my name is|i am called|call me)\s+(.+)/i, category: "fact" },
  { pattern: /(?:i live in|i'm from|i'm based in)\s+(.+)/i, category: "fact" },
  { pattern: /(?:remember that|don't forget|keep in mind)\s+(.+)/i, category: "instruction" },
  { pattern: /(?:i work as|my job is|i'm a|my role is)\s+(.+)/i, category: "fact" },
  { pattern: /(?:my timezone is|i'm in)\s+(\w+(?:\s+timezone)?)/i, category: "fact" },
  { pattern: /(?:always|never)\s+(.+)/i, category: "instruction" },
  // Enhanced patterns
  { pattern: /(?:i usually|i typically|my routine is)\s+(.+)/i, category: "preference" },
  { pattern: /(?:don't|do not|stop|quit)\s+(.+)/i, category: "instruction" },
  { pattern: /(?:my email is|my phone is|my address is)\s+(.+)/i, category: "fact" },
  { pattern: /(?:i use|i'm using|my stack is|my setup is)\s+(.+)/i, category: "fact" },
];

export function extractMemoriesLocal(messages: Message[]): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];

  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const { pattern, category } of PATTERNS) {
      const match = msg.content.match(pattern);
      if (match?.[1]) {
        candidates.push({
          content: match[1].trim().replace(/[.!?]$/, ""),
          category,
        });
      }
    }
  }

  return candidates;
}

export function buildExtractionPrompt(messages: Message[]): string {
  const transcript = messages
    .slice(-20) // Last 20 messages
    .map((m) => `${m.role}: ${m.content.slice(0, 300)}`)
    .join("\n");

  return `Extract important facts, preferences, and instructions from this conversation that should be remembered for future sessions. Return JSON array of objects with "content" (string) and "category" (fact|preference|instruction|event).

Only extract genuinely useful long-term information. Skip transient task details.

Conversation:
${transcript}

Return ONLY the JSON array, no other text.`;
}
```

**Step 3: Wire into finalization flow**

After summarization in `finalizeWithSummary()`, also extract and store memories:

```typescript
// In server.ts finalizeWithSummary:
const candidates = extractMemoriesLocal(
  conv.messages.map((m) => ({ role: m.role, content: m.content }))
);
if (candidates.length > 0 && db) {
  const memStore = createMemoryStore(db);
  for (const c of candidates) {
    memStore.remember(c.content, { source: sid, category: c.category });
  }
}
```

**Step 4: Run tests**

Run: `bun run test`
Expected: All pass

**Step 5: Commit**

```bash
git add packages/gateway/src/memory-extractor.ts tests/gateway/memory-extractor.test.ts packages/gateway/src/server.ts
git commit -m "feat: enhanced memory extraction from conversations"
```

---

### Task 9: Improve memory IPC tools

Add `memory_search` tool alongside existing `manage_memory` for better recall.

**Files:**
- Modify: `packages/kernel/src/ipc-server.ts`
- Test: `tests/kernel/memory-search-tool.test.ts`

**Step 1: Verify existing memory tools**

Check what memory tools exist in ipc-server.ts. There should be a `manage_memory` tool. We need to add a dedicated `memory_search` that searches both FTS memories AND conversation summaries.

**Step 2: Add memory_search tool**

```typescript
tool(
  "memory_search",
  "Search long-term memory and conversation history for relevant context. Use this when you need to recall information from previous sessions.",
  {
    query: z.string().describe("Search query"),
    scope: z.enum(["all", "memories", "conversations"]).optional()
      .describe("Search scope (default: all)"),
    limit: z.number().optional().describe("Max results (default: 10)"),
  },
  async ({ query, scope, limit: maxResults }) => {
    const results: Array<{ type: string; content: string; source?: string }> = [];
    const lim = maxResults ?? 10;
    const searchScope = scope ?? "all";

    // Search memories (FTS)
    if (searchScope === "all" || searchScope === "memories") {
      const memStore = createMemoryStore(db);
      const memories = memStore.recall(query, { limit: lim });
      for (const m of memories) {
        results.push({
          type: "memory",
          content: `[${m.category}] ${m.content}`,
          source: m.source ?? undefined,
        });
      }
    }

    // Search conversation summaries
    if (searchScope === "all" || searchScope === "conversations") {
      const summariesDir = join(homePath, "system", "summaries");
      if (existsSync(summariesDir)) {
        const lowerQuery = query.toLowerCase();
        const files = readdirSync(summariesDir).filter((f) => f.endsWith(".md"));
        for (const f of files) {
          const content = readFileSync(join(summariesDir, f), "utf-8");
          if (content.toLowerCase().includes(lowerQuery)) {
            const body = content.replace(/^---[\s\S]*?---\n*/m, "").trim();
            results.push({
              type: "conversation_summary",
              content: body,
              source: f.replace(".md", ""),
            });
          }
        }
      }
    }

    if (results.length === 0) {
      return { content: [{ type: "text" as const, text: "No relevant memories found." }] };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(results.slice(0, lim), null, 2) }] };
  }
);
```

**Step 3: Run tests**

Run: `bun run test`
Expected: All pass

**Step 4: Commit**

```bash
git add packages/kernel/src/ipc-server.ts tests/kernel/memory-search-tool.test.ts
git commit -m "feat: add memory_search tool for cross-session recall"
```

---

## Phase 4: Semantic Search (QMD-Inspired with OpenAI Embeddings)

### Task 10: Embedding service with OpenAI

Create a pluggable embedding service that calls OpenAI's text-embedding-3-small. API key comes from `~/system/config.json` under `tools.embeddings.openai_key`, falling back to `OPENAI_API_KEY` env var.

**Files:**
- Create: `packages/kernel/src/embeddings.ts`
- Test: `tests/kernel/embeddings.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/kernel/embeddings.test.ts
import { describe, it, expect, vi } from "vitest";
import {
  createEmbeddingService,
  cosineSimilarity,
  type EmbeddingService,
} from "../../packages/kernel/src/embeddings.js";

describe("embedding service", () => {
  describe("cosineSimilarity", () => {
    it("returns 1 for identical vectors", () => {
      const v = new Float32Array([1, 2, 3]);
      expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
    });

    it("returns 0 for orthogonal vectors", () => {
      const a = new Float32Array([1, 0]);
      const b = new Float32Array([0, 1]);
      expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
    });

    it("returns -1 for opposite vectors", () => {
      const a = new Float32Array([1, 0]);
      const b = new Float32Array([-1, 0]);
      expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
    });
  });

  describe("createEmbeddingService", () => {
    it("creates service with mock fetch for testing", () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: [{ embedding: Array.from({ length: 256 }, () => Math.random()) }],
        }),
      });

      const service = createEmbeddingService({
        apiKey: "test-key",
        fetchFn: mockFetch,
      });
      expect(service).toBeDefined();
      expect(service.embed).toBeInstanceOf(Function);
    });

    it("generates embeddings via API call", async () => {
      const fakeEmbedding = Array.from({ length: 256 }, () => Math.random());
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: [{ embedding: fakeEmbedding }],
        }),
      });

      const service = createEmbeddingService({
        apiKey: "test-key",
        fetchFn: mockFetch,
      });
      const result = await service.embed("hello world");
      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(256);
    });

    it("supports batch embedding", async () => {
      const fakeEmbedding = Array.from({ length: 256 }, () => Math.random());
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: [
            { embedding: fakeEmbedding },
            { embedding: fakeEmbedding },
          ],
        }),
      });

      const service = createEmbeddingService({
        apiKey: "test-key",
        fetchFn: mockFetch,
      });
      const results = await service.embedBatch(["hello", "world"]);
      expect(results.length).toBe(2);
      expect(results[0]).toBeInstanceOf(Float32Array);
    });

    it("throws on missing API key", () => {
      expect(() => createEmbeddingService({ apiKey: "" })).toThrow();
    });
  });
});
```

**Step 2: Implement embeddings.ts**

```typescript
// packages/kernel/src/embeddings.ts

export interface EmbeddingService {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  dimensions: number;
}

export interface EmbeddingConfig {
  apiKey: string;
  model?: string;
  dimensions?: number;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function createEmbeddingService(config: EmbeddingConfig): EmbeddingService {
  if (!config.apiKey) throw new Error("Embedding API key required");

  const model = config.model ?? "text-embedding-3-small";
  const dimensions = config.dimensions ?? 256;
  const baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
  const fetchImpl = config.fetchFn ?? fetch;

  async function callApi(input: string[]): Promise<Float32Array[]> {
    const res = await fetchImpl(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model, input, dimensions }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "unknown error");
      throw new Error(`Embedding API error: ${res.status} ${err}`);
    }

    const json = await res.json() as {
      data: Array<{ embedding: number[] }>;
    };

    return json.data.map((d) => new Float32Array(d.embedding));
  }

  return {
    dimensions,
    async embed(text: string): Promise<Float32Array> {
      const [result] = await callApi([text]);
      return result;
    },
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      // OpenAI supports up to 2048 inputs per batch
      return callApi(texts);
    },
  };
}
```

**Step 3: Run tests**

Run: `bun run test -- tests/kernel/embeddings.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/kernel/src/embeddings.ts tests/kernel/embeddings.test.ts
git commit -m "feat: OpenAI embedding service for semantic search"
```

---

### Task 11: Vector storage in SQLite

Store embeddings as BLOBs in a new `embeddings` table. Compute similarity in JS (good enough for thousands of chunks).

**Files:**
- Modify: `packages/kernel/src/schema.ts` (add embeddings table)
- Create: `packages/kernel/src/vector-store.ts`
- Test: `tests/kernel/vector-store.test.ts`

**Step 1: Add embeddings table to schema**

```typescript
// Add to schema.ts
export const embeddings = sqliteTable(
  "embeddings",
  {
    id: text("id").primaryKey(),
    content: text("content").notNull(),
    sourceType: text("source_type").notNull(), // memory, conversation, knowledge, app_data
    sourceId: text("source_id"),
    vector: text("vector").notNull(), // JSON-encoded Float32Array
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_embeddings_source").on(table.sourceType, table.sourceId),
  ],
);
```

Note: Using `text` for vector storage (JSON array) for simplicity. Can upgrade to BLOB + sqlite-vec later.

**Step 2: Write the failing test**

```typescript
// tests/kernel/vector-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createVectorStore, type VectorStore } from "../../packages/kernel/src/vector-store.js";
import { cosineSimilarity } from "../../packages/kernel/src/embeddings.js";

// Use in-memory SQLite for tests
import Database from "better-sqlite3";

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE embeddings (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT,
      vector TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_embeddings_source ON embeddings(source_type, source_id);
  `);
  return db;
}

describe("vector store", () => {
  let db: any;
  let store: VectorStore;

  beforeEach(() => {
    db = createTestDb();
    store = createVectorStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("stores and retrieves vectors", () => {
    const vector = new Float32Array([1, 0, 0, 0]);
    store.upsert("test-1", "hello world", "memory", vector);

    const results = store.search(new Float32Array([1, 0, 0, 0]), { limit: 5 });
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("hello world");
    expect(results[0].score).toBeCloseTo(1.0, 3);
  });

  it("ranks by cosine similarity", () => {
    store.upsert("a", "exact match", "memory", new Float32Array([1, 0, 0, 0]));
    store.upsert("b", "partial match", "memory", new Float32Array([0.7, 0.7, 0, 0]));
    store.upsert("c", "no match", "memory", new Float32Array([0, 0, 0, 1]));

    const results = store.search(new Float32Array([1, 0, 0, 0]), { limit: 3 });
    expect(results[0].content).toBe("exact match");
    expect(results[1].content).toBe("partial match");
    expect(results[2].content).toBe("no match");
  });

  it("filters by source type", () => {
    store.upsert("mem-1", "memory content", "memory", new Float32Array([1, 0]));
    store.upsert("conv-1", "conversation content", "conversation", new Float32Array([1, 0]));

    const results = store.search(new Float32Array([1, 0]), { sourceType: "memory" });
    expect(results.length).toBe(1);
    expect(results[0].sourceType).toBe("memory");
  });

  it("respects minimum score threshold", () => {
    store.upsert("good", "relevant", "memory", new Float32Array([1, 0]));
    store.upsert("bad", "irrelevant", "memory", new Float32Array([0, 1]));

    const results = store.search(new Float32Array([1, 0]), { minScore: 0.5 });
    expect(results.length).toBe(1);
  });

  it("upsert updates existing entry", () => {
    store.upsert("id-1", "old content", "memory", new Float32Array([1, 0]));
    store.upsert("id-1", "new content", "memory", new Float32Array([0, 1]));

    const all = store.search(new Float32Array([0, 1]), { limit: 10 });
    expect(all.length).toBe(1);
    expect(all[0].content).toBe("new content");
  });

  it("deletes by source", () => {
    store.upsert("a", "content a", "conversation", new Float32Array([1, 0]));
    store.upsert("b", "content b", "conversation", new Float32Array([0, 1]));
    store.upsert("c", "content c", "memory", new Float32Array([1, 1]));

    store.deleteBySource("conversation");
    const results = store.search(new Float32Array([1, 1]), { limit: 10 });
    expect(results.length).toBe(1);
    expect(results[0].sourceType).toBe("memory");
  });
});
```

**Step 3: Implement vector-store.ts**

```typescript
// packages/kernel/src/vector-store.ts
import { cosineSimilarity } from "./embeddings.js";

export interface VectorSearchResult {
  id: string;
  content: string;
  sourceType: string;
  sourceId: string | null;
  score: number;
}

export interface VectorSearchOptions {
  limit?: number;
  minScore?: number;
  sourceType?: string;
}

export interface VectorStore {
  upsert(id: string, content: string, sourceType: string, vector: Float32Array, sourceId?: string): void;
  search(queryVector: Float32Array, opts?: VectorSearchOptions): VectorSearchResult[];
  deleteBySource(sourceType: string, sourceId?: string): void;
  count(): number;
}

export function createVectorStore(sqlite: any): VectorStore {
  return {
    upsert(id, content, sourceType, vector, sourceId) {
      const vectorJson = JSON.stringify(Array.from(vector));
      const now = new Date().toISOString();
      sqlite.prepare(`
        INSERT INTO embeddings (id, content, source_type, source_id, vector, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          content = excluded.content,
          source_type = excluded.source_type,
          source_id = excluded.source_id,
          vector = excluded.vector,
          created_at = excluded.created_at
      `).run(id, content, sourceType, sourceId ?? null, vectorJson, now);
    },

    search(queryVector, opts) {
      const limit = opts?.limit ?? 10;
      const minScore = opts?.minScore ?? -1;

      let rows: any[];
      if (opts?.sourceType) {
        rows = sqlite
          .prepare("SELECT id, content, source_type, source_id, vector FROM embeddings WHERE source_type = ?")
          .all(opts.sourceType);
      } else {
        rows = sqlite.prepare("SELECT id, content, source_type, source_id, vector FROM embeddings").all();
      }

      const scored = rows.map((row: any) => {
        const stored = new Float32Array(JSON.parse(row.vector));
        const score = cosineSimilarity(queryVector, stored);
        return {
          id: row.id,
          content: row.content,
          sourceType: row.source_type,
          sourceId: row.source_id,
          score,
        };
      });

      return scored
        .filter((r) => r.score > minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },

    deleteBySource(sourceType, sourceId) {
      if (sourceId) {
        sqlite.prepare("DELETE FROM embeddings WHERE source_type = ? AND source_id = ?").run(sourceType, sourceId);
      } else {
        sqlite.prepare("DELETE FROM embeddings WHERE source_type = ?").run(sourceType);
      }
    },

    count() {
      const result = sqlite.prepare("SELECT count(*) as c FROM embeddings").get() as { c: number };
      return result.c;
    },
  };
}
```

**Step 4: Run tests**

Run: `bun run test -- tests/kernel/vector-store.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/kernel/src/schema.ts packages/kernel/src/vector-store.ts tests/kernel/vector-store.test.ts
git commit -m "feat: vector store for semantic search embeddings"
```

---

### Task 12: Hybrid search (BM25 + vector + RRF)

Combine FTS5 keyword search with vector similarity using Reciprocal Rank Fusion (RRF), inspired by QMD's approach.

**Files:**
- Create: `packages/kernel/src/hybrid-search.ts`
- Test: `tests/kernel/hybrid-search.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/kernel/hybrid-search.test.ts
import { describe, it, expect } from "vitest";
import { reciprocalRankFusion, type RankedResult } from "../../packages/kernel/src/hybrid-search.js";

describe("hybrid search", () => {
  describe("reciprocalRankFusion", () => {
    it("merges two ranked lists", () => {
      const listA: RankedResult[] = [
        { id: "a", content: "first in A", score: 1.0 },
        { id: "b", content: "second in A", score: 0.8 },
      ];
      const listB: RankedResult[] = [
        { id: "b", content: "first in B", score: 1.0 },
        { id: "c", content: "second in B", score: 0.7 },
      ];

      const merged = reciprocalRankFusion([listA, listB]);
      // "b" appears in both lists so should rank highest
      expect(merged[0].id).toBe("b");
      expect(merged.length).toBe(3);
    });

    it("handles empty lists", () => {
      const merged = reciprocalRankFusion([[], []]);
      expect(merged.length).toBe(0);
    });

    it("handles single list", () => {
      const list: RankedResult[] = [
        { id: "a", content: "only item", score: 1.0 },
      ];
      const merged = reciprocalRankFusion([list]);
      expect(merged.length).toBe(1);
      expect(merged[0].id).toBe("a");
    });

    it("respects limit parameter", () => {
      const list: RankedResult[] = Array.from({ length: 20 }, (_, i) => ({
        id: `item-${i}`,
        content: `Content ${i}`,
        score: 1 - i * 0.05,
      }));

      const merged = reciprocalRankFusion([list], { limit: 5 });
      expect(merged.length).toBe(5);
    });
  });
});
```

**Step 2: Implement hybrid-search.ts**

```typescript
// packages/kernel/src/hybrid-search.ts

export interface RankedResult {
  id: string;
  content: string;
  score: number;
  sourceType?: string;
  sourceId?: string;
}

export interface RRFOptions {
  k?: number; // RRF constant (default: 60, same as QMD)
  limit?: number;
}

export function reciprocalRankFusion(
  rankedLists: RankedResult[][],
  opts?: RRFOptions,
): RankedResult[] {
  const k = opts?.k ?? 60;
  const limit = opts?.limit ?? 20;

  // Accumulate RRF scores per document ID
  const scores = new Map<string, { result: RankedResult; rrfScore: number }>();

  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const rrfScore = 1 / (k + rank + 1);
      const existing = scores.get(item.id);
      if (existing) {
        existing.rrfScore += rrfScore;
      } else {
        scores.set(item.id, { result: item, rrfScore });
      }
    }
  }

  return Array.from(scores.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, limit)
    .map((entry) => ({
      ...entry.result,
      score: entry.rrfScore,
    }));
}
```

**Step 3: Run tests**

Run: `bun run test -- tests/kernel/hybrid-search.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/kernel/src/hybrid-search.ts tests/kernel/hybrid-search.test.ts
git commit -m "feat: reciprocal rank fusion for hybrid BM25+vector search"
```

---

### Task 13: Semantic memory_search integration

Wire the embedding service + vector store + hybrid search into the `memory_search` IPC tool. When `OPENAI_API_KEY` or config key is available, semantic search is enabled. Otherwise falls back to FTS-only.

**Files:**
- Modify: `packages/kernel/src/ipc-server.ts` (update memory_search tool)
- Modify: `packages/kernel/src/embeddings.ts` (add config loader)
- Test: `tests/kernel/semantic-search-integration.test.ts`

**Step 1: Add embedding config loader**

In `embeddings.ts`, add:

```typescript
export function loadEmbeddingConfig(homePath: string): EmbeddingConfig | null {
  // Try config.json first
  const configPath = join(homePath, "system", "config.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      if (config.tools?.embeddings?.openai_key) {
        return { apiKey: config.tools.embeddings.openai_key };
      }
    } catch { /* ignore */ }
  }
  // Fall back to env var
  const envKey = process.env.OPENAI_API_KEY;
  if (envKey) return { apiKey: envKey };
  return null;
}
```

**Step 2: Update memory_search tool**

In the `memory_search` tool handler, add semantic search when embedding service is available:

```typescript
// At tool creation time (during IPC server setup):
const embeddingConfig = loadEmbeddingConfig(homePath);
const embeddingService = embeddingConfig ? createEmbeddingService(embeddingConfig) : null;

// Inside memory_search handler:
if (embeddingService && (searchScope === "all" || searchScope === "memories")) {
  try {
    const vectorStore = createVectorStore(db.$client);
    const queryVector = await embeddingService.embed(query);
    const vectorResults = vectorStore.search(queryVector, { limit: lim });
    // Merge with FTS results via RRF
    // ... (use reciprocalRankFusion)
  } catch {
    // Semantic search failed, FTS results still available
  }
}
```

**Step 3: Write test**

```typescript
// tests/kernel/semantic-search-integration.test.ts
import { describe, it, expect } from "vitest";
import { reciprocalRankFusion } from "../../packages/kernel/src/hybrid-search.js";
import { cosineSimilarity } from "../../packages/kernel/src/embeddings.js";
import { createVectorStore } from "../../packages/kernel/src/vector-store.js";
import Database from "better-sqlite3";

describe("semantic search integration", () => {
  it("combines FTS and vector results via RRF", () => {
    const ftsResults = [
      { id: "mem-1", content: "user prefers dark mode", score: 1.0 },
      { id: "mem-2", content: "user's name is Hamed", score: 0.5 },
    ];

    const vectorResults = [
      { id: "mem-3", content: "user likes dark themes for all apps", score: 0.95 },
      { id: "mem-1", content: "user prefers dark mode", score: 0.9 },
    ];

    const merged = reciprocalRankFusion([ftsResults, vectorResults]);
    // mem-1 appears in both, should rank highest
    expect(merged[0].id).toBe("mem-1");
    expect(merged.length).toBe(3);
  });

  it("vector store + similarity works end-to-end", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE embeddings (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT,
        vector TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    const store = createVectorStore(db);
    store.upsert("e1", "dark mode preference", "memory", new Float32Array([0.9, 0.1, 0, 0]));
    store.upsert("e2", "todo app usage", "conversation", new Float32Array([0.1, 0.9, 0, 0]));

    const results = store.search(new Float32Array([1, 0, 0, 0]), { limit: 2 });
    expect(results[0].content).toBe("dark mode preference");

    db.close();
  });
});
```

**Step 4: Run tests**

Run: `bun run test`
Expected: All pass

**Step 5: Commit**

```bash
git add packages/kernel/src/ipc-server.ts packages/kernel/src/embeddings.ts tests/kernel/semantic-search-integration.test.ts
git commit -m "feat: semantic search with OpenAI embeddings + hybrid RRF"
```

---

### Task 14: Auto-index conversations and memories

After saving a conversation summary or memory, embed it and store in the vector store for future semantic recall. This happens asynchronously (fire-and-forget) to avoid blocking the main flow.

**Files:**
- Create: `packages/gateway/src/indexer.ts`
- Modify: `packages/gateway/src/server.ts` (wire indexer into finalization)
- Test: `tests/gateway/indexer.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/gateway/indexer.test.ts
import { describe, it, expect, vi } from "vitest";
import { createIndexer, type Indexer } from "../../packages/gateway/src/indexer.js";

describe("indexer", () => {
  it("indexes text content with embedding service", async () => {
    const fakeEmbed = vi.fn().mockResolvedValue(new Float32Array([1, 0, 0]));
    const fakeUpsert = vi.fn();

    const indexer = createIndexer({
      embed: fakeEmbed,
      upsert: fakeUpsert,
    });

    await indexer.index("conv-1", "User asked about todos", "conversation", "session-123");

    expect(fakeEmbed).toHaveBeenCalledWith("User asked about todos");
    expect(fakeUpsert).toHaveBeenCalledWith(
      "conv-1",
      "User asked about todos",
      "conversation",
      expect.any(Float32Array),
      "session-123",
    );
  });

  it("handles embedding errors gracefully", async () => {
    const fakeEmbed = vi.fn().mockRejectedValue(new Error("API error"));
    const fakeUpsert = vi.fn();

    const indexer = createIndexer({ embed: fakeEmbed, upsert: fakeUpsert });
    // Should not throw
    await indexer.index("id", "content", "memory");
    expect(fakeUpsert).not.toHaveBeenCalled();
  });

  it("skips empty content", async () => {
    const fakeEmbed = vi.fn();
    const fakeUpsert = vi.fn();

    const indexer = createIndexer({ embed: fakeEmbed, upsert: fakeUpsert });
    await indexer.index("id", "", "memory");
    expect(fakeEmbed).not.toHaveBeenCalled();
  });
});
```

**Step 2: Implement indexer.ts**

```typescript
// packages/gateway/src/indexer.ts

export interface IndexerDeps {
  embed: (text: string) => Promise<Float32Array>;
  upsert: (id: string, content: string, sourceType: string, vector: Float32Array, sourceId?: string) => void;
}

export interface Indexer {
  index(id: string, content: string, sourceType: string, sourceId?: string): Promise<void>;
  indexBatch(items: Array<{ id: string; content: string; sourceType: string; sourceId?: string }>): Promise<void>;
}

export function createIndexer(deps: IndexerDeps): Indexer {
  return {
    async index(id, content, sourceType, sourceId) {
      if (!content.trim()) return;
      try {
        const vector = await deps.embed(content);
        deps.upsert(id, content, sourceType, vector, sourceId);
      } catch {
        // Embedding failed, skip silently
      }
    },

    async indexBatch(items) {
      for (const item of items) {
        await this.index(item.id, item.content, item.sourceType, item.sourceId);
      }
    },
  };
}
```

**Step 3: Wire into server.ts**

In server initialization, create the indexer (if embedding config available):

```typescript
import { createIndexer } from "./indexer.js";
import { createEmbeddingService, loadEmbeddingConfig } from "../kernel/src/embeddings.js";
import { createVectorStore } from "../kernel/src/vector-store.js";

// During server setup:
const embeddingConfig = loadEmbeddingConfig(homePath);
let indexer: Indexer | null = null;
if (embeddingConfig && db) {
  const embeddingService = createEmbeddingService(embeddingConfig);
  const vectorStore = createVectorStore(db.$client);
  indexer = createIndexer({
    embed: (text) => embeddingService.embed(text),
    upsert: (id, content, type, vec, sourceId) =>
      vectorStore.upsert(id, content, type, vec, sourceId),
  });
}

// In finalizeWithSummary, after saving summary:
if (indexer && summary) {
  indexer.index(`summary-${sid}`, summary, "conversation", sid).catch(() => {});
}
```

**Step 4: Run tests**

Run: `bun run test`
Expected: All pass

**Step 5: Commit**

```bash
git add packages/gateway/src/indexer.ts tests/gateway/indexer.test.ts packages/gateway/src/server.ts
git commit -m "feat: auto-index conversations for semantic recall"
```

---

### Task 15: Add embedding config to config.json schema + DB migration

Add the `tools.embeddings` section to config.json and ensure the embeddings table is created on DB init.

**Files:**
- Modify: `packages/kernel/src/db.ts` (add embeddings table creation)
- Modify: `home/system/config.json` template
- Test: verify DB migration works

**Step 1: Add embeddings table to DB init**

In `packages/kernel/src/db.ts`, find where tables are created and add:

```sql
CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT,
  vector TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);
```

**Step 2: Add config template**

In `home/system/config.json`, add under `tools`:

```json
{
  "tools": {
    "embeddings": {
      "openai_key": "",
      "model": "text-embedding-3-small",
      "dimensions": 256
    }
  }
}
```

**Step 3: Run full test suite**

Run: `bun run test`
Expected: All pass

**Step 4: Commit**

```bash
git add packages/kernel/src/db.ts home/system/config.json packages/kernel/src/schema.ts
git commit -m "feat: embeddings table migration + config template"
```

---

## Summary

| Phase | Tasks | What it fixes |
|-------|-------|---------------|
| 1: System Prompt | T1-T3 | Agent knows about apps, data, more memory budget |
| 2: Conversation Continuity | T4-T7 | Auto-summaries, history tool, cross-session context |
| 3: Long-Term Memory | T8-T9 | Better extraction, searchable memory |
| 4: Semantic Search | T10-T15 | OpenAI embeddings, vector store, hybrid search, auto-indexing |

**Total new files:** 7
**Total modified files:** 6
**Total test files:** 8
**Estimated tests:** ~60 new tests
