import { describe, expect, it } from "vitest";
import {
  lifecycleJournalCode,
  summarizeRuntimeTelemetry,
} from "../../packages/terminal-runtime/src/telemetry.js";

describe("terminal runtime telemetry", () => {
  it("emits only bounded coarse counts, pressure, and aggregate bytes", () => {
    const summary = summarizeRuntimeTelemetry({
      runtimes: [
        {
          runtimeId: "0123456789abcdef0123456789abcdef",
          lifecycleState: "live",
        },
        {
          runtimeId: "11111111111111111111111111111111",
          lifecycleState: "interrupted",
        },
      ],
      descriptorCount: 3,
      recoveryBytes: 42,
      memoryPressureEvents: 2,
      taskPressureEvents: 1,
    });

    expect(summary).toEqual({
      runtimeCount: 2,
      lifecycleCounts: {
        interrupted: 1,
        live: 1,
      },
      descriptorCount: 3,
      recoveryBytes: 42,
      memoryPressureEvents: 2,
      taskPressureEvents: 1,
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /012345|111111|displayName|prompt|provider|path|command/i,
    );
  });

  it("uses only a generic lifecycle code and a truncated runtime digest in journals", () => {
    const event = lifecycleJournalCode(
      "0123456789abcdef0123456789abcdef",
      "recovery_started",
    );
    expect(event).toEqual({
      code: "recovery_started",
      runtimeHash: expect.stringMatching(/^[0-9a-f]{12}$/),
    });
    expect(JSON.stringify(event)).not.toContain("0123456789abcdef");
    expect(() => lifecycleJournalCode(
      "0123456789abcdef0123456789abcdef",
      "private prompt" as never,
    )).toThrow();
  });
});
