import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");

/**
 * The integrations MCP server and the published CLI run under plain `node`,
 * with no TypeScript loader. Vitest rewrites `./x.js` to `./x.ts`, so only a
 * real child process shows whether a contract module resolves there.
 */
async function plainNode(cwd: string, script: string, env: Record<string, string> = {}) {
  const { stdout } = await run(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: resolve(root, cwd),
    // No NODE_OPTIONS: the child must not inherit a loader from the test runner.
    env: { PATH: process.env.PATH ?? "", ...env },
    timeout: 30_000,
  });
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "null") as unknown;
}

describe("office contracts under plain node", () => {
  // Fault detected: a relative `./x.js` import between contract sources, which only a TypeScript loader can resolve.
  it.each(["app-files", "office-open-with", "office-documents"])("loads @matrix-os/contracts/%s without a loader", async (subpath) => {
    const exported = await plainNode("packages/kernel", `
      const module = await import("@matrix-os/contracts/${subpath}");
      console.log(JSON.stringify(Object.keys(module).length));
    `);
    expect(exported).toBeGreaterThan(0);
  });

  // Fault detected: the production MCP launcher (`node dist/cli.js`) registers no document tools.
  it("registers the eleven proposal tools from the built integrations MCP server", async () => {
    await access(resolve(root, "packages/integrations-mcp/dist/documents.js"));
    const names = await plainNode("packages/integrations-mcp", `
      const { registerDocumentTools } = await import("./dist/documents.js");
      const names = [];
      registerDocumentTools({ registerTool: (name) => { names.push(name); } }, async () => { throw new Error("not called"); });
      console.log(JSON.stringify(names));
    `, { MATRIX_AUTH_TOKEN: "owner-test-token-0123456789" });
    expect(names).toEqual([
      "document_describe", "document_read_text", "document_propose_edits", "document_list_revisions",
      "document_add_comment", "document_compare", "document_create", "sheet_describe", "sheet_read_range",
      "sheet_propose_edits", "sheet_list_changes",
    ]);
  });
});
