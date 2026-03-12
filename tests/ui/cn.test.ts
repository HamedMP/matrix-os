import { describe, it, expect } from "vitest";
import { cn } from "../../packages/ui/src/cn";

describe("cn utility", () => {
  it("joins multiple class names", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("filters out falsy values", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
  });

  it("returns empty string for no truthy inputs", () => {
    expect(cn(false, null, undefined)).toBe("");
  });

  it("handles single class", () => {
    expect(cn("only")).toBe("only");
  });

  it("handles empty call", () => {
    expect(cn()).toBe("");
  });
});
