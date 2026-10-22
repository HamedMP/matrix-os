import { expect, it } from "vitest";
import { hermesToolActivity, hermesActivitySummary, hermesStatusActivity, hermesToolFailed } from "../../packages/gateway/src/chat/hermes-tool-activity.js";
it("preserves safe native tool projection while keeping provider payloads out of activity", () => {
  expect(hermesToolActivity("terminal")).toEqual({ kind: "command", label: "Run command" });
  expect(hermesToolActivity("mcp__matrix_shared_browser__shared_browser")).toEqual({ kind: "mcp_tool", label: "Use connected tool" });
  expect(hermesToolActivity("<script>private")).toEqual({ kind: "dynamic_tool", label: "Use tool" });
  expect(hermesActivitySummary("command", true)).toBe("Command failed.");
  expect(hermesStatusActivity("compacting")).toEqual({ activityId: "status_compacting", kind: "phase", label: "Summarizing conversation" });
  expect(hermesStatusActivity("unsupported")).toBeUndefined();
  expect(hermesToolFailed({ exit_code: 2 })).toBe(true); expect(hermesToolFailed({ success: false })).toBe(true);
  expect(hermesToolFailed({ error: "" })).toBe(false); expect(hermesToolFailed(null)).toBe(false);
});
