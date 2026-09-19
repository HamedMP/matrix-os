import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = fileURLToPath(new URL(".", import.meta.url));
const target = mkdtempSync(join(tmpdir(), "matrix-scroll-build-"));
try {
execFileSync("cargo", ["build", "--locked", "--release", "--target", "wasm32-wasip1"], { cwd: directory, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: target } });
const output = new URL("../assets/scroll-v1.wasm", import.meta.url);
copyFileSync(join(target, "wasm32-wasip1/release/matrix-terminal-scroll.wasm"), output);
const files = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "src/main.rs", "../assets/scroll-v1.wasm"];
const hashes = Object.fromEntries(files.map((path) => [path, createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex")]));
writeFileSync(new URL("manifest.json", import.meta.url), `${JSON.stringify(hashes, null, 2)}\n`);

} finally { rmSync(target, { recursive: true, force: true }); }
