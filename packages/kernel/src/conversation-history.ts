import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface SummaryListEntry {
  session: string;
  date: string;
  summary: string;
}

export interface TruncatedMessage {
  role: string;
  content: string;
}

export function listConversationSummaries(
  homePath: string,
  limit?: number,
): SummaryListEntry[] {
  const summariesDir = join(homePath, "system", "summaries");
  if (!existsSync(summariesDir)) return [];

  const maxResults = limit ?? 10;

  const files = readdirSync(summariesDir).filter((f) => f.endsWith(".md"));

  const entries: SummaryListEntry[] = [];
  for (const f of files) {
    try {
      const content = readFileSync(join(summariesDir, f), "utf-8");
      const body = content.replace(/^---[\s\S]*?---\n*/m, "").trim();
      const dateMatch = content.match(/^date:\s*(.+)$/m);
      entries.push({
        session: f.replace(".md", ""),
        date: dateMatch?.[1] ?? "",
        summary: body,
      });
    } catch {
      // skip unreadable files
    }
  }

  entries.sort((a, b) => b.date.localeCompare(a.date));
  return entries.slice(0, maxResults);
}

export function getConversationMessages(
  homePath: string,
  sessionId: string,
): TruncatedMessage[] | null {
  const convPath = join(homePath, "system", "conversations", `${sessionId}.json`);
  if (!existsSync(convPath)) return null;

  try {
    const raw = readFileSync(convPath, "utf-8");
    const conv = JSON.parse(raw);
    const messages: Array<{ role: string; content: string }> = conv.messages ?? [];

    return messages.slice(-30).map((m) => ({
      role: m.role,
      content:
        m.content.length > 500 ? m.content.slice(0, 500) + "..." : m.content,
    }));
  } catch {
    return null;
  }
}
