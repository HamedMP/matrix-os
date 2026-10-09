import { describe, expect, it } from "vitest";
import { utilityCatalog } from "../../home/apps/utilities/src/catalog-adapter";
import { filterTools, workspaceKind, needsModelDownload, processingNotice, navigationReducer, initialNavigation } from "../../home/apps/utilities/src/utilities-model";

const tool = (slug: string, mode = "text", category = "Developer") => ({ slug, mode, category, title: slug, description: "Useful local utility", example: "demo", howTo: "Try it", limitations: "Review results" });

describe("Utilities folder model", () => {
  it("projects temporary audio sessions without claiming durable recovery", () => {
    const audio = utilityCatalog.find((tool) => tool.slug === "audio-workspace")!;
    expect(audio.description).toMatch(/temporary/);
    expect(audio.description).not.toMatch(/recovery/);
    expect(audio.limitations).not.toMatch(/saved session/);
  });
  it("matches names, descriptions and categories without interpreting queries", () => {
    const tools = [tool("json-formatter"), tool("word-counter", "text", "Writing")];
    expect(filterTools(tools, " JSON ", "All")).toEqual([tools[0]]);
    expect(filterTools(tools, "writing", "All")).toEqual([tools[1]]);
    expect(filterTools(tools, "", "Writing")).toEqual([tools[1]]);
    expect(filterTools(tools, "[.*", "All")).toEqual([]);
    expect(filterTools(tools, "x".repeat(1000), "All")).toEqual([]);
  });
  it("resolves every site mode and its two specialized PDF renderers", () => {
    for (const mode of ["text", "pdf", "image", "audio", "extra", "editor", "collaboration", "workflow", "local-ai"]) expect(workspaceKind(tool("example", mode))).toBe(mode);
    expect(workspaceKind(tool("pdf-podcast", "pdf"))).toBe("pdf-podcast");
    expect(workspaceKind(tool("check-pdf-signature", "pdf"))).toBe("pdf-signature");
    expect(workspaceKind(tool("unknown", "invalid"))).toBeNull();
  });
  it("distinguishes model downloads and peer metadata from local processing", () => {
    expect(processingNotice(tool("word-counter"))).toMatch(/device/);
    expect(needsModelDownload(tool("word-counter"))).toBe(false);
    expect(needsModelDownload(tool("text-summarizer", "local-ai"))).toBe(true);
    const ocr = utilityCatalog.find((tool) => tool.slug === "image-ocr");
    expect(ocr).toBeDefined();
    expect(needsModelDownload(ocr!)).toBe(true);
    expect(processingNotice(ocr!)).toContain("First use downloads a model or browser runtime.");
    expect(processingNotice(tool("text-summarizer", "local-ai"))).toMatch(/download/i);
    expect(processingNotice(tool("file-share", "collaboration"))).toMatch(/STUN/);
    expect(processingNotice(tool("pdf-podcast", "pdf"))).toMatch(/download/i);
    expect(processingNotice(tool("workflows", "workflow", "Collaboration"))).not.toMatch(/STUN/);
  });
  it("keeps dirty work mounted until explicit discard and clears pending navigation on cancel", () => {
    let state = navigationReducer(initialNavigation, { type: "open", slug: "word-counter" });
    state = navigationReducer(state, { type: "dirty" });
    const pending = navigationReducer(state, { type: "open", slug: "json-formatter" });
    expect(pending.active).toBe("word-counter");
    expect(pending.pending).toBe("json-formatter");
    expect(navigationReducer(pending, { type: "cancel" })).toEqual(state);
    expect(navigationReducer(pending, { type: "discard" })).toEqual({ active: "json-formatter", dirty: false, pending: undefined });
    const back = navigationReducer(state, { type: "open", slug: null });
    expect(back.pending).toBeNull();
    expect(navigationReducer(back, { type: "discard" }).active).toBeNull();
    expect(navigationReducer(state, { type: "open", slug: "word-counter" })).toEqual(state);
  });
});
