import { describe, expect, it, vi } from "vitest";
import { createChatSendTimer, recordCodexCatalogTiming } from "../../packages/gateway/src/chat/send-timing.js";

describe("Chat send timings", () => {
  it("correlates concurrent catalog reads without logging request IDs or content", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "info").mockImplementation((...args) => logged.push(args.join(" ")));
    try {
      const first = createChatSendTimer("private-first-request");
      const second = createChatSendTimer("private-second-request");
      await Promise.all([
        first.run(async () => { await Promise.resolve(); recordCodexCatalogTiming("stale_hit", 2); }),
        second.run(async () => { await Promise.resolve(); recordCodexCatalogTiming("lookup", 9); }),
      ]);
      expect(logged).toHaveLength(2);
      const events = logged.map((line) => JSON.parse(line.slice(line.indexOf("{") )) as {
        traceId: string; stage: string; result: string; durationMs: number;
      });
      expect(events.map((event) => event.result).sort()).toEqual(["lookup", "stale_hit"]);
      expect(events[0]?.traceId).not.toBe(events[1]?.traceId);
      expect(logged.join(" ")).not.toMatch(/private-(first|second)-request/);
      expect(events.every((event) => event.stage === "codex_catalog" && event.durationMs >= 0)).toBe(true);
    } finally { spy.mockRestore(); }
  });
});
