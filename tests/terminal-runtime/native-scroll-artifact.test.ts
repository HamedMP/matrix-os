import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("verifies the native scroll artifact and all pinned build inputs", async () => {
  const base = new URL("../../packages/terminal-runtime/native-scroll/", import.meta.url);
  const manifest: Record<string, string> = JSON.parse(await readFile(new URL("manifest.json", base), "utf8"));
  expect(Object.keys(manifest).sort()).toEqual([
    "../assets/scroll-v1.wasm", "Cargo.lock", "Cargo.toml", "rust-toolchain.toml", "src/main.rs",
  ]);
  for (const [path, hash] of Object.entries(manifest)) {
    expect(createHash("sha256").update(await readFile(new URL(path, base))).digest("hex"), path).toBe(hash);
  }
});
