// Explicit offline build only. No installation or generation/manifest changes.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
  throw new Error("Terminal attachment entry requires Linux x64 or arm64");
}
const [destination, ...extra] = process.argv.slice(2);
if (!destination || extra.length) throw new Error("Expected one explicit output file");
const source = join(dirname(fileURLToPath(import.meta.url)), "terminal-attachment-entry.c");
const output = resolve(destination);
if (output === source || output === fileURLToPath(import.meta.url)) throw new Error("Invalid output file");
if (!statSync(dirname(output)).isDirectory()) throw new Error("Output directory unavailable");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceSha256 = hash(readFileSync(source));
const compiler = process.env.CC || "cc";
const compilerVersion = execFileSync(compiler, ["--version"], {
  timeout: 5000, maxBuffer: 16384, encoding: "utf8",
}).split("\n")[0].slice(0, 512);
const temporaryDirectory = mkdtempSync(join(dirname(output), ".attachment-entry-"));
const temporary = join(temporaryDirectory, "matrix-terminal-attachment-entry");
try {
  closeSync(openSync(temporary, "wx", 0o700));
  const compilerArgs = ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-static", source, "-o", temporary];
  execFileSync(compiler, compilerArgs, { timeout: 30000, maxBuffer: 65536 });
  if (hash(readFileSync(source)) !== sourceSha256) throw new Error("Source changed during build");
  const info = statSync(temporary);
  if (!info.isFile() || info.size < 64 || info.size > 64 * 1024 * 1024) throw new Error("Invalid ELF size");
  const bytes = readFileSync(temporary);
  if (!bytes.subarray(0, 6).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])) || bytes[6] !== 1) {
    throw new Error("Expected ELF64 little endian");
  }
  if (bytes.readUInt16LE(18) !== (process.arch === "x64" ? 62 : 183)) throw new Error("ELF target mismatch");
  const offset = bytes.readBigUInt64LE(32), width = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
  if (offset > BigInt(bytes.length) || width < 56 || count < 1 || count > 1024 ||
      offset + BigInt(width * count) > BigInt(bytes.length)) throw new Error("Invalid ELF program headers");
  for (let i = 0; i < count; i++) {
    const at = Number(offset) + width * i, kind = bytes.readUInt32LE(at);
    if (kind === 3) throw new Error("Dynamic interpreter forbidden");
    if (kind !== 2) continue;
    const start = bytes.readBigUInt64LE(at + 8), size = bytes.readBigUInt64LE(at + 32);
    if (start + size > BigInt(bytes.length) || size % 16n !== 0n) throw new Error("Invalid ELF dynamic table");
    for (let entry = Number(start); entry < Number(start + size); entry += 16) {
      const tag = bytes.readBigInt64LE(entry);
      if (tag === 1n) throw new Error("Dynamic dependency forbidden");
      if (tag === 0n) break;
    }
  }
  const outputSha256 = hash(bytes);
  chmodSync(temporary, 0o755);
  renameSync(temporary, output);
  process.stdout.write(JSON.stringify({ source, sourceSha256, output, outputSha256,
    target: process.arch, compiler, compilerVersion, compilerArgs, mode: "static" }) + "\n");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
