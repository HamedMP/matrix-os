import { describe, it, expect } from "vitest";
import { formatAccessibilityTree, type AXNode } from "../../packages/mcp-browser/src/role-snapshot.js";

describe("Role Snapshot (Accessibility Tree)", () => {
  it("formats a simple tree", () => {
    const tree: AXNode = {
      role: "document",
      name: "Test Page",
      children: [
        {
          role: "heading",
          name: "Hello World",
          level: 1,
        },
        {
          role: "paragraph",
          name: "Some text",
        },
      ],
    };

    const result = formatAccessibilityTree(tree);
    expect(result).toContain('document "Test Page"');
    expect(result).toContain('heading "Hello World" [level=1]');
    expect(result).toContain('paragraph "Some text"');
  });

  it("includes roles, names, values, and states", () => {
    const tree: AXNode = {
      role: "document",
      name: "Form Page",
      children: [
        {
          role: "textbox",
          name: "Username",
          value: "hamed",
        },
        {
          role: "checkbox",
          name: "Remember me",
          checked: true,
        },
        {
          role: "button",
          name: "Submit",
          disabled: true,
        },
      ],
    };

    const result = formatAccessibilityTree(tree);
    expect(result).toContain('textbox "Username" [value="hamed"]');
    expect(result).toContain('checkbox "Remember me" [checked]');
    expect(result).toContain('button "Submit" [disabled]');
  });

  it("handles nested structures with indentation", () => {
    const tree: AXNode = {
      role: "document",
      name: "Page",
      children: [
        {
          role: "navigation",
          name: "Main",
          children: [
            { role: "link", name: "Home" },
            { role: "link", name: "About" },
          ],
        },
      ],
    };

    const result = formatAccessibilityTree(tree);
    const lines = result.split("\n");
    expect(lines[0]).toMatch(/^document/);
    expect(lines[1]).toMatch(/^\s+navigation/);
    expect(lines[2]).toMatch(/^\s{4}link/);
  });

  it("handles empty pages", () => {
    const tree: AXNode = {
      role: "document",
      name: "",
    };

    const result = formatAccessibilityTree(tree);
    expect(result).toContain("document");
  });

  it("handles null tree", () => {
    const result = formatAccessibilityTree(null as unknown as AXNode);
    expect(result).toBe("(empty page)");
  });

  it("truncates large trees to max chars", () => {
    const children = Array.from({ length: 500 }, (_, i) => ({
      role: "listitem",
      name: `Item ${i} with some extra text to make it long enough`,
    }));
    const tree: AXNode = {
      role: "document",
      name: "Big List",
      children: [{ role: "list", name: "Items", children }],
    };

    const result = formatAccessibilityTree(tree, { maxChars: 1000 });
    expect(result.length).toBeLessThanOrEqual(1050); // small overflow for truncation message
    expect(result).toContain("[truncated]");
  });

  it("filters presentation/decorative roles", () => {
    const tree: AXNode = {
      role: "document",
      name: "Page",
      children: [
        { role: "presentation", name: "" },
        { role: "none", name: "" },
        { role: "heading", name: "Real Content" },
      ],
    };

    const result = formatAccessibilityTree(tree);
    expect(result).not.toContain("presentation");
    expect(result).not.toContain("none");
    expect(result).toContain("Real Content");
  });
});
