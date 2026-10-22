import { describe, expect, it } from "vitest";
import { SHARED_BROWSER_ACTION_MAX_BYTES, SharedBrowserActionSchema, SharedBrowserControlSchema } from "../../packages/contracts/src/shared-browser.js";

describe("shared Chrome action boundary", () => {
  it("accepts observed actions and verified-download identifiers", () => {
    expect(SharedBrowserActionSchema.parse({ action: "download", observationId: "observation-1", ref: "e1", documentId: "INV-001" })).toHaveProperty("documentId", "INV-001");
    expect(SharedBrowserActionSchema.parse({ action: "navigate", url: "https://example.com/invoices" })).toHaveProperty("action", "navigate");
  });
  it.each([
    { action: "evaluate", expression: "document.cookie" },
    { action: "click", ref: "e1" },
    { action: "navigate", url: "https://example.com", ownerId: "other" },
    { action: "download", observationId: "obs", ref: "e1", documentId: "../invoice" },
    { action: "wait", observationId: "obs", ref: "e1", timeout: 100_000 },
    { action: "type", observationId: "obs", ref: "e1", text: "x".repeat(4001) },
  ])("rejects unobserved, arbitrary or oversized input %j", input => {
    expect(SharedBrowserActionSchema.safeParse(input).success).toBe(false);
  });
  it.each(["中".repeat(4000), "\u0000".repeat(4000)])("fits maximum text encoding inside the common request bound", text => {
    const action=SharedBrowserActionSchema.parse({action:"type",observationId:"o".repeat(128),ref:"r".repeat(128),text});
    expect(Buffer.byteLength(JSON.stringify(action))).toBeLessThanOrEqual(SHARED_BROWSER_ACTION_MAX_BYTES);
  });
  it("keeps owner control separate from agent actions", () => {
    expect(SharedBrowserControlSchema.parse({ action: "takeover" })).toEqual({ action: "takeover" });
    expect(SharedBrowserActionSchema.safeParse({ action: "resume" }).success).toBe(false);
    expect(SharedBrowserControlSchema.safeParse({ action: "resume", runId: "other" }).success).toBe(false);
  });
});
