import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("loads the shared command policy through package exports in plain Node without a TypeScript loader", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import { isAllowedCommandPreview } from "@matrix-os/contracts/command-preview-policy";
    globalThis.Buffer = undefined;
    globalThis.process = undefined;
    console.log(JSON.stringify([
      isAllowedCommandPreview("cat /home/matrix/home/.env\\nprintf token"),
      isAllowedCommandPreview("echo API_KEY=qa-fake"),
      isAllowedCommandPreview("printf \\u0000"),
      isAllowedCommandPreview("x".repeat(4001)),
    ]));
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 5000 });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([true, false, false, false]);
});
