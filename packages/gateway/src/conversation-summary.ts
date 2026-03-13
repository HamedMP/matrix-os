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

const MAX_SUMMARY_LENGTH = 300;

export function summarizeConversation(conv: ConversationForSummary): string {
  if (conv.messages.length === 0) return "";

  const userMessages = conv.messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.slice(0, 200));

  const assistantMessages = conv.messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.content.slice(0, 200));

  const parts: string[] = [];

  if (userMessages.length > 0) {
    parts.push(`User: ${userMessages[0]}`);
    if (userMessages.length > 1) {
      parts.push(`Also: ${userMessages[userMessages.length - 1]}`);
    }
  }

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

    const tsMatch = content.match(/^timestamp:\s*(.+)$/m);
    const timestamp = tsMatch?.[1] ?? new Date(f.mtime).toISOString();

    const body = content.replace(/^---[\s\S]*?---\n*/m, "").trim();

    return { sessionId, summary: body, timestamp };
  });
}
