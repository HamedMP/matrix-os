import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readClaudeAccountHistory } from "../../scripts/ai-usage/account-history";
it("recovers account activity across years without inventing token totals or returning content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-account-"));
  try {
    const path = join(dir, "conversations.json");
    await writeFile(
      path,
      JSON.stringify([
        {
          uuid: "chat",
          name: "PRIVATE TITLE",
          created_at: "2024-05-16T12:00:00Z",
          chat_messages: [
            { text: "PRIVATE CONTENT", created_at: "2024-05-16T12:00:00Z" },
            { text: "PRIVATE", created_at: "2026-01-01T12:00:00Z" },
          ],
        },
      ]),
    );
    const activity = await readClaudeAccountHistory(path);
    expect(activity).toMatchObject({
      conversations: 1,
      messages: 2,
      first: "2024-05-16T12:00:00.000Z",
      last: "2026-01-01T12:00:00.000Z",
      tokenCountersAvailable: false,
      years: [
        { year: "2024", conversations: 1, messages: 1 },
        { year: "2026", conversations: 0, messages: 1 },
      ],
    });
    expect(JSON.stringify(activity)).not.toContain("PRIVATE");
    expect(activity).not.toHaveProperty("tokens");
  } finally {
    await rm(dir, { recursive: true });
  }
});
