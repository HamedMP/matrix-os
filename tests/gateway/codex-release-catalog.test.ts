import { execFileSync } from "node:child_process";
import { copyFile, chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCodexModelCatalogSource } from "../../packages/gateway/src/chat/codex-model-catalog.js";

it("serves the release catalog on an old VPS and notices a later Terminal update", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-release-catalog-"));
  try {
    const hostBin = join(home, "host-bin");
    const prefix = join(home, "node");
    const terminal = join(prefix, "bin/codex");
    const selector = join(hostBin, "matrix-codex-chat");
    await mkdir(hostBin);
    await mkdir(join(prefix, "bin"), { recursive: true });
    const fake = async (path: string, version: string, models: string[]) => {
      await writeFile(path, `#!${process.execPath}
const { createInterface } = require("node:readline");
if (process.argv[2] === "--version") {
  console.log("codex-cli ${version}");
  process.exit(0);
}
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") console.log(JSON.stringify({ id: request.id, result: {} }));
  if (request.method === "model/list") console.log(JSON.stringify({
    id: request.id, result: { data: ${JSON.stringify(models)}.map((id, index) => ({
      id, model: id, displayName: id, hidden: false, isDefault: index === 0,
      defaultReasoningEffort: "low", supportedReasoningEfforts: [],
    })), nextCursor: null },
  }));
});
`, { mode: 0o755 });
    };
    await fake(terminal, "0.162.1", ["gpt-6.1-terra"]);
    await fake(join(hostBin, "matrix-codex"), "0.171.0", ["gpt-6.2-sol", "gpt-6.2-astra"]);
    await copyFile("distro/customer-vps/host-bin/matrix-codex-chat", selector);
    await chmod(selector, 0o755);
    const environment = { MATRIX_NODE_PREFIX: prefix, HOME: home };
    const catalog = createCodexModelCatalogSource({ executable: selector, cwd: home, environment });
    const provider = { id: "codex", kind: "codex", availability: "available" } as Parameters<typeof catalog>[0];

    const before = await catalog(provider);
    expect(before?.models.map(model => model.id)).toEqual(["gpt-6.2-sol", "gpt-6.2-astra"]);
    expect(execFileSync(terminal, ["--version"], { encoding: "utf8" }).trim()).toBe("codex-cli 0.162.1");
    await fake(join(prefix, "bin/codex-update"), "0.172.0", ["gpt-6.2-astra", "fixture-new-model"]);
    await rename(join(prefix, "bin/codex-update"), terminal);

    const after = await catalog(provider);
    expect(after?.models.map(model => model.id)).toEqual(["gpt-6.2-astra", "fixture-new-model"]);
    expect(execFileSync(selector, ["--version"], { encoding: "utf8", env: { ...process.env, ...environment } }).trim())
      .toBe("codex-cli 0.172.0");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
