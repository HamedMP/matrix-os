import { beforeEach, afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverPiAppSdk } from "../../packages/gateway/src/app-ai/pi-sdk-discovery.js";
let prefix: string;
let root: string;
beforeEach(async () => {
  prefix = await mkdtemp(join(tmpdir(), "pi-sdk-loader-"));
  root = join(prefix, "lib/node_modules/@earendil-works/pi-coding-agent");
  await mkdir(join(root, "dist/bundle"), { recursive: true }); await mkdir(join(root, "dist/core")); await mkdir(join(prefix, "bin"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.4" }));
  await writeFile(join(root, "dist/index.js"), "export {};\n"); await writeFile(join(root, "dist/core/auth-storage.js"), "export {};\n");
  await writeFile(join(root, "dist/bundle/cli.js"), "#!/bin/sh\n[ -z \"$OPENAI_API_KEY\" ] || exit 1\n[ -z \"$NODE_OPTIONS\" ] || exit 1\necho 1.0.4\n", { mode: 0o700 });
  await symlink(join(root, "dist/bundle/cli.js"), join(prefix, "bin/pi"));
});
afterEach(async () => { await rm(prefix, { recursive: true, force: true }); });
it("pins CLI and auth backend to the verified same-package version and strips ambient secrets", async () => {
  const result = await discoverPiAppSdk({ homePath: prefix, runtimePrefix: prefix, env: { OPENAI_API_KEY: "must-strip", NODE_OPTIONS: "must-strip", PATH: "/usr/bin:/bin" } });
  expect(result.entry).toContain("dist/index.js"); expect(result.authStorageEntry).toContain("dist/core/auth-storage.js"); expect(result.env).not.toHaveProperty("OPENAI_API_KEY"); expect(result.env).not.toHaveProperty("NODE_OPTIONS");
});
it("refuses unverified runtime versions", async () => {
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.5" }));
  await expect(discoverPiAppSdk({ homePath: prefix, runtimePrefix: prefix, env: {} })).rejects.toThrow();
});
it("refuses outside-package auth loader symlinks", async () => {
  await rm(join(root, "dist/core/auth-storage.js")); await writeFile(join(prefix, "elsewhere.js"), "export {};\n");
  await symlink(join(prefix, "elsewhere.js"), join(root, "dist/core/auth-storage.js"));
  await expect(discoverPiAppSdk({ homePath: prefix, runtimePrefix: prefix, env: {} })).rejects.toThrow();
});
