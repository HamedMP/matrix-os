import { expect, it } from "vitest";
import type { BotRoutineCenterItem } from "@matrix-os/contracts";
import { routineNextRun } from "../../../packages/ui/src/chat-agents/bots/routine-presentation.js";

it("refreshes next-run presentation after the device timezone changes without reloading the module", () => {
  const previous = process.env.TZ;
  const routine = {status: "active", targetAvailable: true, sourceAvailable: true, requiresReview: false,
    nextFireAt: "2026-11-02T00:00:00.000Z"} as BotRoutineCenterItem;
  try {
    process.env.TZ = "UTC";
    const utc = routineNextRun(routine);
    process.env.TZ = "Asia/Tokyo";
    const tokyo = routineNextRun(routine);
    expect(utc).toContain("(UTC)");
    expect(tokyo).toContain("(Asia/Tokyo)");
    expect(tokyo).not.toBe(utc);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
