import { describe, expect, it } from "vitest";
import { formatBytes } from "@desktop/renderer/src/features/workspace/ProcessesPanel";

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
