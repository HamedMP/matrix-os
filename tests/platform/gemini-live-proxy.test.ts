import { describe, expect, it } from "vitest";
import { parseInternalGeminiLivePath } from "../../packages/platform/src/gemini-live-proxy.js";

describe("platform Gemini Live proxy", () => {
  it("accepts the internal per-container proxy path", () => {
    expect(parseInternalGeminiLivePath("/internal/containers/alice/gemini-live")).toEqual({ handle: "alice" });
  });

  it("rejects unsafe or public proxy paths", () => {
    expect(parseInternalGeminiLivePath("/api/gemini-live")).toBeNull();
    expect(parseInternalGeminiLivePath("/internal/containers/../../gemini-live")).toBeNull();
    expect(parseInternalGeminiLivePath("/internal/containers/a/gemini-live")).toBeNull();
  });
});
