import { describe, expect, it } from "vitest";
import { utilityCatalog } from "../../home/apps/utilities/src/catalog-adapter";
import { toolAvailability, availableToolCount } from "../../home/apps/utilities/src/tool-availability";

describe("Utilities Matrix platform availability", () => {
  it("fails closed for worker/model, PDF worker and microphone paths", () => {
    for (const slug of ["blur-faces", "protect-pdf", "unlock-pdf", "compress-pdf", "verify-pdf", "pdf-workspace", "speech-to-text", "audio-trimmer", "remove-background", "text-summarizer", "pdf-podcast", "check-pdf-signature", "pdf-to-image", "video-call", "code-workspace"]) {
      const result = toolAvailability(utilityCatalog.find((tool) => tool.slug === slug)!);
      expect(result.available, slug).toBe(false);
      expect(result.websiteUrl).toBe(`https://matrix-os.com/tools/${slug}`);
      expect(result.reason).toMatch(/Matrix view/);
    }
  });
  it("keeps supported device-only task paths available", () => {
    for (const slug of ["word-counter", "qr-code-generator", "compress-image", "merge-pdfs", "csv-to-pdf", "json-to-csv", "find-replace", "transcription-player"]) {
      const tool = utilityCatalog.find((candidate) => candidate.slug === slug);
      expect(tool, slug).toBeTruthy();
      expect(toolAvailability(tool!).available, slug).toBe(true);
    }
    expect(availableToolCount(utilityCatalog)).toBeGreaterThan(70);
    expect(availableToolCount(utilityCatalog)).toBeLessThan(104);
  });
});
