#!/usr/bin/env node
// Local preparation only. No credentials, network calls, or source mutations.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const PART_BYTES = 8 * 1024 * 1024;
const excluded = new Set([".git", ".codex", ".claude", ".ssh", ".aws", ".wrangler", ".vercel", ".next", ".turbo", "node_modules", "dist", "build", "coverage", "target", ".DS_Store"]);
const secret = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|auth\.json|credentials(?:\.json)?|settings\.local\.json|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?)$|\.(?:pem|key|p12|pfx|der|jks|kdbx)$/i;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const run = (command, args, cwd) => execute(command, args, { cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });

async function optionalGit(root, args) {
  try { return (await run("git", ["-C", root, ...args])).stdout.trim(); }
  catch (error) {
    // A folder need not be a Git repository; operational failures are not absence.
    if (error.code === 128 && String(error.stderr).includes("not a git repository")) return null;
    throw error;
  }
}

async function snapshot(rootInput, brief) {
  const root = await realpath(resolve(rootInput));
  if (!(await lstat(root)).isDirectory()) throw new Error("Select a project directory");
  try { await lstat(join(root, ".matrix-move")); throw new Error(".matrix-move is reserved; choose a source without existing transfer metadata"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const gitRoot = await optionalGit(root, ["rev-parse", "--show-toplevel"]);
  if (gitRoot && await realpath(gitRoot) !== root) throw new Error("Select the repository root, not a subdirectory");
  const git = gitRoot ? {
    branch: await optionalGit(root, ["branch", "--show-current"]),
    // Unborn repositories still have a working tree worth transferring.
    head: (await run("git", ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD"]).catch(error => {
      if (error.code === 1) return { stdout: "" }; throw error;
    })).stdout.trim() || null,
    status: await optionalGit(root, ["status", "--porcelain=v1"]),
  } : null;
  let tracked = null;
  const selectedDirectories = new Set(); // Bounded by the selected-file/entry limit.
  if (git) {
    const result = await run("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
    const paths = result.stdout.split("\0").filter(Boolean);
    if (paths.length > MAX_ENTRIES) throw new Error("Project exceeds 20000 entries");
    tracked = new Set(paths);
    for (const path of paths) {
      const segments = path.split("/"); segments.pop();
      while (segments.length) {
        selectedDirectories.add(segments.join("/")); segments.pop();
        if (selectedDirectories.size > MAX_ENTRIES) throw new Error("Project exceeds 20000 entries");
      }
    }
  }
  const directory = await mkdtemp(join(tmpdir(), "matrix-move-"));
  await chmod(directory, 0o700);
  try {
    const stage = join(directory, "stage"); await mkdir(stage);
    const files = [], skipped = [];
    let total = 0, entries = 0;
    async function walk(path = "", depth = 0) {
      if (depth > 64) throw new Error("Project nesting exceeds 64 levels");
      for (const entry of (await readdir(join(root, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
        if (++entries > MAX_ENTRIES) throw new Error("Project exceeds 20000 entries");
        const name = path ? `${path}/${entry.name}` : entry.name;
        if (/[\u0000-\u001f\u007f\\]/.test(name)) throw new Error("Unsupported project filename");
        if (excluded.has(entry.name) || secret.test(entry.name)) { skipped.push({ path: name, reason: "excluded" }); continue; }
        if (entry.isSymbolicLink()) { skipped.push({ path: name, reason: "symlink" }); continue; }
        if (entry.isDirectory()) {
          if (!tracked || selectedDirectories.has(name)) await walk(name, depth + 1);
          continue;
        }
        if (!entry.isFile()) { skipped.push({ path: name, reason: "special" }); continue; }
        if (tracked && !tracked.has(name)) continue;
        const source = join(root, name);
        const resolved = await realpath(source);
        if (!resolved.startsWith(root + sep)) throw new Error("Source escaped project directory");
        const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = await input.stat();
          if (!before.isFile() || total + before.size > MAX_BYTES) throw new Error("Project exceeds 512 MiB or contains a special file");
          // Read at most the captured size; growth cannot cause unbounded buffering.
          const bytes = Buffer.alloc(before.size);
          let offset = 0;
          while (offset < bytes.length) {
            const read = await input.read(bytes, offset, bytes.length - offset, offset);
            if (!read.bytesRead) break;
            offset += read.bytesRead;
          }
          const after = await input.stat();
          if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Source changed while preparing; retry the snapshot");
          const destination = join(stage, name); await mkdir(dirname(destination), { recursive: true });
          const mode = before.mode & 0o111 ? 0o755 : 0o644;
          await writeFile(destination, bytes, { flag: "wx", mode });
          await chmod(destination, mode); // Match the manifest even under a private umask.
          files.push({ path: name, bytes: bytes.length, sha256: hash(bytes), mode }); total += bytes.length;
        } finally { await input.close(); }
      }
    }
    await walk();
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const id = randomUUID();
    const slug = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "project";
    const projectPath = `projects/${slug}-${id}`;
    const manifest = { version: 1, id, projectPath, git, files, skipped, bytes: total, briefIncluded: Boolean(brief),
      limitations: ["Git object history and index are excluded", "Ignored files, credentials, dependencies, build output and symlinks are excluded", "Chat transcripts are imported separately", "Filename exclusions cannot detect secrets inside ordinary source files"] };
    const metadata = join(stage, ".matrix-move"); await mkdir(metadata);
    if (brief) {
      const input = await open(brief, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await input.stat();
        if (!info.isFile() || info.size > 256 * 1024) throw new Error("Brief must be a regular file no larger than 256 KiB");
        const bytes = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < bytes.length) {
          const result = await input.read(bytes, offset, bytes.length - offset, offset);
          if (!result.bytesRead) break; offset += result.bytesRead;
        }
        const after = await input.stat();
        if (offset !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error("Brief changed while preparing");
        manifest.brief = { bytes: bytes.length, sha256: hash(bytes) };
        await writeFile(join(metadata, "continuation.md"), bytes, { flag: "wx", mode: 0o600 });
      } finally { await input.close(); }
    }
    const manifestPath = join(metadata, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const archive = join(directory, "snapshot.tar.gz");
    await execute("tar", ["-czf", archive, "-C", stage, "."], { timeout: 120_000, maxBuffer: 1024 * 1024 });
    const archiveInfo = await lstat(archive);
    if (archiveInfo.size > MAX_BYTES + 8 * 1024 * 1024) throw new Error("Compressed project exceeds transfer limit");
    const input = await open(archive, "r"); const digest = createHash("sha256"); const parts = [];
    try {
      for (let offset = 0; offset < archiveInfo.size; offset += PART_BYTES) {
        const buffer = Buffer.alloc(Math.min(PART_BYTES, archiveInfo.size - offset));
        let read = 0;
        while (read < buffer.length) {
          const result = await input.read(buffer, read, buffer.length - read, offset + read);
          if (!result.bytesRead) throw new Error("Prepared archive became unreadable"); read += result.bytesRead;
        }
        digest.update(buffer);
        const part = join(directory, `part-${String(parts.length).padStart(4, "0")}`);
        await writeFile(part, buffer, { flag: "wx", mode: 0o600 }); parts.push(part);
      }
    } finally { await input.close(); }
    await rm(archive); // Parts are the only upload source.
    return { directory, manifest: manifestPath, projectPath, id, parts, sha256: digest.digest("hex"), bytes: total, fileCount: files.length, skipped: skipped.length,
      cleanup: "Delete this exact temporary directory after verification or cancellation; abandoned previews should be removed within 24 hours" };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

const [root, ...options] = process.argv.slice(2);
if (!root || options.length && (options.length !== 2 || options[0] !== "--brief")) {
  console.error("Usage: node snapshot.mjs /absolute/project [--brief /absolute/brief.md]"); process.exitCode = 2;
} else {
  try { console.log(JSON.stringify(await snapshot(root, options[1]), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
