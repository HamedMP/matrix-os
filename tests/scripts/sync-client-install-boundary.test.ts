import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("installs the Node 20 sync-client lane without downloading an unused desktop binary", () => {
  const job = parse(readFileSync(".github/workflows/ci.yml", "utf8")).jobs["sync-client"];
  const install = job.steps.find((step: { run?: string }) => step.run === "pnpm install --frozen-lockfile");
  const root = mkdtempSync(join(tmpdir(), "matrix-sync-install-"));
  try {
    const pnpm = join(root, "pnpm");
    writeFileSync(pnpm, '#!/bin/sh\nif [ "$ELECTRON_SKIP_BINARY_DOWNLOAD" != 1 ]; then echo "Unused desktop binary download attempted" >&2; exit 73; fi\n');
    chmodSync(pnpm, 0o755);
    const env = { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "", ...install.env, PATH: `${root}:${process.env.PATH}` };
    const result = spawnSync("sh", ["-c", install.run], { env, encoding: "utf8", timeout: 5_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(job.steps.some((step: { with?: { [key: string]: unknown } }) => step.with?.["node-version"] === 20)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
