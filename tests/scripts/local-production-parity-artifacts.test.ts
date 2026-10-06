import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

it("keeps parity credentials and VM artifacts out of a normal git add in a fresh checkout", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "matrix-parity-ignore-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.excludesFile=/dev/null", ...args], {
    cwd: checkout,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  const artifacts = [
    ".amp/in/local-production-parity/state.json",
    ".amp/in/local-production-parity/runtime/operator_ed25519",
    ".amp/in/local-production-parity/storage-tls/key.pem",
    ".amp/in/local-production-parity/cloud-init.yaml",
    ".amp/in/local-production-parity/host-bundle/matrix-host-bundle.tar.gz",
    ".amp/in/local-production-parity/runtime/disk.qcow2",
    ".amp/in/local-production-parity/runtime/cidata.iso",
    ".amp/in/local-production-parity/ubuntu-24.04-amd64.qcow2",
  ];
  try {
    git("init", "--quiet", "--template=");
    await copyFile(join(process.cwd(), ".gitignore"), join(checkout, ".gitignore"));
    for (const path of [...artifacts, ".amp/config.json", "scripts/dev-production-parity.mjs"]) {
      await mkdir(dirname(join(checkout, path)), { recursive: true });
      await writeFile(join(checkout, path), "test-only content\n");
    }
    expect(git("check-ignore", ...artifacts).trim().split("\n")).toEqual(artifacts);
    git("add", ".");
    expect(git("diff", "--cached", "--name-only").trim().split("\n")).toEqual([
      ".amp/config.json",
      ".gitignore",
      "scripts/dev-production-parity.mjs",
    ]);
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
});
