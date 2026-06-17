import { describe, expect, it } from "vitest";
import { canOpenPreviewUrl } from "../../desktop/src/renderer/src/features/workspace/ArtifactsPanel";

describe("artifacts preview URLs", () => {
  it("allows local and secure HTTP preview links", () => {
    expect(canOpenPreviewUrl("http://127.0.0.1:5173")).toBe(true);
    expect(canOpenPreviewUrl("https://preview.example.com")).toBe(true);
  });

  it("rejects non-web preview links", () => {
    expect(canOpenPreviewUrl("javascript:alert(1)")).toBe(false);
    expect(canOpenPreviewUrl("file:///tmp/preview.html")).toBe(false);
    expect(canOpenPreviewUrl("/relative-preview")).toBe(false);
    expect(canOpenPreviewUrl(null)).toBe(false);
  });
});
