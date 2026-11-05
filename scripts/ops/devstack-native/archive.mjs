import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { join } from "node:path";
import { assert } from "./control.mjs";
const MAX_BYTES = 512 * 1024 * 1024, MAX_FILES = 4096;
export async function digestFile(path, algorithm = "sha256") {
  const hash = createHash(algorithm); let size = 0;
  for await (const chunk of createReadStream(path)) { size += chunk.length; assert(size <= MAX_BYTES, "package_bytes_exceeded"); hash.update(chunk); }
  return { size, digest: hash.digest(algorithm === "sha512" ? "base64" : "hex") };
}
function octal(bytes) {
  const text = bytes.toString("ascii").replaceAll("\0", "").trim();
  assert(/^[0-7]{1,12}$/.test(text), "archive_number_invalid"); return Number.parseInt(text, 8);
}
function memberPath(value) {
  assert(value.startsWith("package/") && value.length <= 512 && !value.includes("\\") && !value.includes("\0"), "archive_path_invalid");
  const path = value.slice(8).replace(/\/$/, "");
  assert(path.length > 0 && /^[A-Za-z0-9@._+/-]+$/.test(path)
    && path.split("/").every(part => part && part !== "." && part !== ".."), "archive_path_invalid"); return path;
}
function paxPath(buffer) {
  const text = buffer.toString("utf8"); let offset = 0, path;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset); assert(space > offset, "archive_pax_invalid");
    const length = Number(text.slice(offset, space)); assert(Number.isInteger(length) && length > 3 && offset + length <= text.length, "archive_pax_invalid");
    const record = text.slice(space + 1, offset + length); assert(record.endsWith("\n"), "archive_pax_invalid");
    const equals = record.indexOf("="); assert(equals > 0, "archive_pax_invalid");
    const key = record.slice(0, equals), value = record.slice(equals + 1, -1);
    assert(["path", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname", "SCHILY.dev", "SCHILY.ino", "SCHILY.nlink"].includes(key), "archive_pax_key_unsupported");
    if (key === "path") path = value; offset += length;
  }
  return path;
}
export async function archiveMembers(path, sri) {
  assert(/^sha512-[A-Za-z0-9+/]{86}==$/.test(sri), "package_integrity_invalid");
  const compressed = await digestFile(path, "sha512"); assert(`sha512-${compressed.digest}` === sri, "package_integrity_mismatch");
  // No parser sees archive bytes until their frozen-graph integrity is verified.
  const members = Object.create(null); let headers = 0; let pending = Buffer.alloc(0), current, padding = 0, total = 0, ended = false, nextPath;
  const finish = () => {
    if (current.pax) nextPath = paxPath(Buffer.concat(current.chunks));
    else { assert(Object.keys(members).length < MAX_FILES && !Object.hasOwn(members, current.path), "archive_member_capacity");
      members[current.path] = { size: current.size, sha256: current.hash.digest("hex"), executable: current.executable }; }
    padding = (512 - current.size % 512) % 512; current = undefined;
  };
  const input = createReadStream(path); const gzip = createGunzip(); input.on("error", error => gzip.destroy(error)); input.pipe(gzip);
  try { for await (const chunk of gzip) {
    total += chunk.length; assert(total <= MAX_BYTES, "archive_bytes_exceeded"); pending = Buffer.concat([pending, chunk]);
    while (pending.length) {
      if (ended) { assert(pending.every(byte => byte === 0), "archive_trailing_data"); pending = Buffer.alloc(0); break; }
      if (padding) { const take = Math.min(padding, pending.length); pending = pending.subarray(take); padding -= take; continue; }
      if (current) {
        const take = Math.min(current.remaining, pending.length), bytes = pending.subarray(0, take);
        if (current.pax) current.chunks.push(bytes); else current.hash.update(bytes);
        pending = pending.subarray(take); current.remaining -= take; if (!current.remaining) finish(); continue;
      }
      if (pending.length < 512) break;
      const header = pending.subarray(0, 512); pending = pending.subarray(512);
      if (header.every(byte => byte === 0)) { ended = true; continue; }
      assert(++headers <= MAX_FILES * 2, "archive_header_capacity");
      const checksum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
      assert(checksum === octal(header.subarray(148, 156)), "archive_checksum_invalid");
      const text = bytes => bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)).toString("utf8");
      const prefix = text(header.subarray(345, 500)), name = text(header.subarray(0, 100));
      const size = octal(header.subarray(124, 136)), type = header[156]; assert(size <= MAX_BYTES, "archive_member_size");
      if (type === 120) { assert(size <= 65536, "archive_pax_capacity"); current = { pax: true, size, remaining: size, chunks: [] }; }
      else if (type === 53) { const directory = `${prefix ? `${prefix}/` : ""}${name}`; if (directory !== "package/") memberPath(directory); assert(size === 0, "archive_directory_invalid"); continue; }
      else {
        assert(type === 0 || type === 48, "archive_member_type_unsupported");
        const path = memberPath(nextPath ?? `${prefix ? `${prefix}/` : ""}${name}`); nextPath = undefined;
        current = { path, size, remaining: size, hash: createHash("sha256"), executable: (octal(header.subarray(100, 108)) & 0o111) !== 0 };
      }
      if (current.remaining === 0) finish();
    }
  } } finally { input.destroy(); gzip.destroy(); }
  assert(ended && !current && !padding && Object.keys(members).length > 0, "archive_incomplete");
  return { sri, compressedBytes: compressed.size, members };
}
export async function verifyInstalledMembers(root, expected) {
  const observed = Object.create(null); let count = 0, total = 0;
  const walk = async (path, prefix = "") => {
    const directory = await opendir(path);
    for await (const entry of directory) {
      assert(++count <= MAX_FILES * 2 && !entry.isSymbolicLink(), "installed_package_member_invalid");
      const name = prefix ? `${prefix}/${entry.name}` : entry.name; const file = join(path, entry.name); const metadata = await lstat(file);
      assert((metadata.uid === 0 || metadata.uid === process.getuid()) && (metadata.mode & 0o022) === 0, "installed_package_unprotected");
      if (metadata.isDirectory()) { await walk(file, name); continue; }
      assert(metadata.isFile() && Object.hasOwn(expected, name), "installed_package_extra_member");
      total += metadata.size; assert(total <= MAX_BYTES, "installed_package_bytes_exceeded");
      const digest = await digestFile(file); const want = expected[name];
      assert(digest.size === want.size && digest.digest === want.sha256 && ((metadata.mode & 0o111) !== 0) === want.executable, "installed_package_digest_mismatch");
      observed[name] = digest.digest;
    }
  };
  await walk(root); assert(Object.keys(observed).length === Object.keys(expected).length, "installed_package_missing_member");
  return { memberCount: Object.keys(observed).length, bytes: total, members: observed };
}
