import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("contracts native Node runtime", () => {
  it("loads the public package entrypoint without TypeScript path remapping", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import("@matrix-os/contracts").then(({ OS_VIEW_MODES }) => console.log(OS_VIEW_MODES.join(",")))',
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 10_000,
      },
    );

    expect(output.trim()).toBe("desktop,canvas");
  });
});
