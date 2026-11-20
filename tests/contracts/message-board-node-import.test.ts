import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

// Fault detected: the packaged MCP CLI runs contracts as stripped TypeScript in plain Node,
// where a relative `./x.js` import of a `.ts` file does not resolve and the CLI fails to start.
it("loads the message board contracts in plain Node, as the packaged MCP CLI does", () => {
  const output = execFileSync(process.execPath, ["--input-type=module", "-e",
    'const m = await import("@matrix-os/contracts/message-board"); console.log(typeof m.LabelsSchema, typeof m.EventsQuerySchema, typeof m.BoardDurationSchema);'],
  { cwd: "packages/integrations-mcp", encoding: "utf8", timeout: 20_000 });
  expect(output.trim()).toBe("object object object");
});
