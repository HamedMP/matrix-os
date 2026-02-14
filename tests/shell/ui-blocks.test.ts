import { describe, it, expect } from "vitest";
import { parseContentSegments } from "../../shell/src/lib/ui-blocks";

describe("parseContentSegments", () => {
  it("returns single markdown segment for plain text", () => {
    const result = parseContentSegments("Hello world");
    expect(result).toEqual([{ type: "markdown", content: "Hello world" }]);
  });

  it("parses ui:cards block", () => {
    const input = '```ui:cards\n[{"title":"Student","emoji":"grad","description":"School"}]\n```';
    const result = parseContentSegments(input);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("ui:cards");
    if (result[0].type === "ui:cards") {
      expect(result[0].data).toEqual([
        { title: "Student", emoji: "grad", description: "School" },
      ]);
    }
  });

  it("parses ui:options block", () => {
    const input = '```ui:options\n[{"label":"Yes"},{"label":"No","value":"nope"}]\n```';
    const result = parseContentSegments(input);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("ui:options");
    if (result[0].type === "ui:options") {
      expect(result[0].data).toHaveLength(2);
      expect(result[0].data[1].value).toBe("nope");
    }
  });

  it("parses ui:status block", () => {
    const input = '```ui:status\n{"level":"success","message":"Done!"}\n```';
    const result = parseContentSegments(input);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("ui:status");
    if (result[0].type === "ui:status") {
      expect(result[0].data.level).toBe("success");
      expect(result[0].data.message).toBe("Done!");
    }
  });

  it("splits mixed markdown + UI blocks correctly", () => {
    const input = 'Before text\n\n```ui:cards\n[{"title":"A"}]\n```\n\nAfter text';
    const result = parseContentSegments(input);
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe("markdown");
    expect(result[1].type).toBe("ui:cards");
    expect(result[2].type).toBe("markdown");
  });

  it("falls back to markdown on invalid JSON", () => {
    const input = '```ui:cards\nnot valid json\n```';
    const result = parseContentSegments(input);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("markdown");
    if (result[0].type === "markdown") {
      expect(result[0].content).toContain("not valid json");
    }
  });

  it("handles incomplete streaming blocks as markdown", () => {
    const input = 'Hello\n\n```ui:cards\n[{"title":"A"}';
    const result = parseContentSegments(input);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("markdown");
  });

  it("handles empty content", () => {
    const result = parseContentSegments("");
    expect(result).toEqual([]);
  });

  it("handles multiple UI blocks in sequence", () => {
    const input =
      '```ui:cards\n[{"title":"A"}]\n```\n\n```ui:options\n[{"label":"Go"}]\n```';
    const result = parseContentSegments(input);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("ui:cards");
    expect(result[1].type).toBe("ui:options");
  });

  it("falls back when cards block contains non-array JSON", () => {
    const input = '```ui:cards\n{"title":"A"}\n```';
    const result = parseContentSegments(input);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("markdown");
  });

  it("falls back when options block contains non-array JSON", () => {
    const input = '```ui:options\n{"label":"A"}\n```';
    const result = parseContentSegments(input);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("markdown");
  });

  it("preserves whitespace in surrounding markdown", () => {
    const input = 'Line 1\n\nLine 2\n\n```ui:status\n{"level":"info","message":"hi"}\n```\n\nLine 3';
    const result = parseContentSegments(input);
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe("markdown");
    expect(result[1].type).toBe("ui:status");
    expect(result[2].type).toBe("markdown");
  });
});
