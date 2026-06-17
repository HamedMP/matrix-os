import { describe, expect, it } from "vitest";
import { formatBytes, portList } from "@desktop/renderer/src/features/workspace/process-format";

describe("formatBytes", () => {
  it("scales through byte units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatBytes(2.5 * 1024 ** 3)).toBe("2.5 GB");
  });

  it("rounds large mantissas and renders a dash for invalid input", () => {
    expect(formatBytes(15.7 * 1024 * 1024)).toBe("16 MB");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("portList", () => {
  it("renders numeric, string, and object port values", () => {
    expect(portList([3000, "5173", { port: "8080/tcp" }, { port: 9229 }])).toBe(
      "3000, 5173, 8080/tcp, 9229",
    );
  });

  it("skips invalid and empty port values", () => {
    expect(portList([Number.NaN, "", "  ", { port: null }, { name: "api" }])).toBe("");
  });
});
