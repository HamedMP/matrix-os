#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const SAFE_ID = /^[a-z0-9][a-z0-9._/-]{0,191}$/;
const APPROVAL_TOKEN = /^(\d{12})\.([a-f0-9]{64})$/;

const EXCLUDED_SEGMENTS = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

const EXCLUDED_BASENAMES = new Set([
  ".DS_Store",
  "auth.json",
  "credentials.json",
  "settings.local.json",
]);

const SECRET_EXTENSIONS = new Set([
  ".der",
  ".jks",
  ".key",
  ".p12",
  ".pfx",
  ".pem",
]);

function usageError(message) {
  return Object.assign(new Error(message), { showUsage: true });
}

function debug(message, error) {
  if (process.env.MATRIX_HANDOFF_DEBUG !== "1") return;
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`[matrix-handoff] ${message}: ${detail}`);
}

function isMissingPathError(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function parseHandoffArgs(argv) {
  const parsed = {
    agent: "codex",
    includeHistory: true,
    confirmed: false,
    attach: false,
    approvalToken: undefined,
    briefPath: undefined,
    historyPath: undefined,
    profile: undefined,
    projectName: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--yes" || arg === "-y") {
      throw usageError("--yes is unsafe without a scope token; use --approve TOKEN from the preview");
    }
    else if (arg === "--attach") parsed.attach = true;
    else if (arg === "--no-history") parsed.includeHistory = false;
    else if (arg === "--include-history") parsed.includeHistory = true;
    else if (["--agent", "--approve", "--brief", "--history-file", "--profile", "--project-name"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw usageError(`${arg} requires a value`);
      index += 1;
      if (arg === "--agent") parsed.agent = value;
      else if (arg === "--approve") {
        parsed.approvalToken = value;
        parsed.confirmed = true;
      }
      else if (arg === "--brief") parsed.briefPath = value;
      else if (arg === "--history-file") parsed.historyPath = value;
      else if (arg === "--profile") parsed.profile = value;
      else parsed.projectName = value;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw usageError(`Unknown option: ${arg}`);
    }
  }
  if (parsed.agent !== "codex" && parsed.agent !== "claude") {
    throw usageError("--agent must be codex or claude");
  }
  if (parsed.approvalToken && !APPROVAL_TOKEN.test(parsed.approvalToken)) {
    throw usageError("--approve must use the token printed by the preview");
  }
  return parsed;
}

export function isSafeHandoffPath(inputPath) {
  const normalized = inputPath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) return false;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || EXCLUDED_SEGMENTS.has(segment))) return false;
  const name = segments.at(-1) ?? "";
  const lower = name.toLowerCase();
  if (EXCLUDED_BASENAMES.has(name)) return false;
  if (lower === ".env" || lower.startsWith(".env.")) return false;
  if (lower === "id_rsa" || lower === "id_ed25519" || lower.endsWith(".kdbx")) return false;
  const dot = lower.lastIndexOf(".");
  if (dot >= 0 && SECRET_EXTENSIONS.has(lower.slice(dot))) return false;
  return true;
}

export function encodeClaudeProjectPath(repositoryPath) {
  return resolve(repositoryPath).replaceAll(sep, "-").replaceAll(" ", "-");
}

function objectContainsCwd(value, expected, depth = 0) {
  if (depth > 5 || value === null || typeof value !== "object") return false;
  if ("cwd" in value && typeof value.cwd === "string" && resolve(value.cwd) === expected) return true;
  return Object.values(value).some((nested) => objectContainsCwd(nested, expected, depth + 1));
}

export function transcriptContainsCwd(jsonl, repositoryPath) {
  const expected = resolve(repositoryPath);
  for (const line of jsonl.split("\n").slice(0, 80)) {
    if (!line.trim()) continue;
    try {
      if (objectContainsCwd(JSON.parse(line), expected)) return true;
    } catch (error) {
      // A partially-written final JSONL line is normal for an active transcript.
      if (!(error instanceof SyntaxError)) debug("transcript metadata parse failed", error);
    }
  }
  return false;
}

function assertSafeGeneratedPath(value) {
  if (!SAFE_ID.test(value) || value.includes("..") || value.startsWith("/")) {
    throw new Error("Expected a safe handoff identifier");
  }
}

export function buildRemoteExtractScript({ uploadId, projectDir }) {
  assertSafeGeneratedPath(uploadId);
  assertSafeGeneratedPath(projectDir);
  return [
    "set -eu",
    `upload_dir="$HOME/.matrix-handoff/${uploadId}"`,
    `destination="$HOME/${projectDir}"`,
    'if [ -e "$destination" ]; then printf "%s\\n" "Matrix project already exists: $destination. Choose another --project-name." >&2; exit 73; fi',
    'mkdir -p "$destination"',
    'cat "$upload_dir"/bundle.part-* | tar -xzf - -C "$destination"',
    'rm -f "$upload_dir"/bundle.part-*',
    'rmdir "$upload_dir"',
    'printf "%s\\n" "$destination"',
  ].join("; ");
}

function printUsage() {
  console.log(`Usage: matrix-handoff [options]

Safely package this repository, upload it to your Matrix computer, and start
a continuing Codex or Claude session. Without --approve, this only previews.

Options:
  --agent codex|claude     Agent to start in Matrix (default: codex)
  --brief PATH             Markdown continuation brief written by the current agent
  --history-file PATH      Explicit current-session JSONL transcript
  --no-history             Do not include a raw transcript
  --project-name NAME      Base name for the new Matrix project directory
  --profile NAME           Matrix CLI profile
  --attach                 Attach this terminal after creating the Matrix session
  --approve TOKEN          Approve the exact scope token printed by preview
`);
}

async function run(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
    env: options.env ?? process.env,
  });
  return result.stdout.trim();
}

async function repositoryRoot() {
  return await realpath(await run("git", ["rev-parse", "--show-toplevel"]));
}

async function repositoryFiles(root) {
  const output = await run(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root },
  );
  return output.split("\0").filter(Boolean).filter(isSafeHandoffPath).sort();
}

async function newestFile(paths) {
  const candidates = [];
  for (const path of paths) {
    try {
      const info = await stat(path);
      if (info.isFile()) candidates.push({ path, mtimeMs: info.mtimeMs, size: info.size });
    } catch (error) {
      // Concurrent transcript cleanup should not make the handoff fail.
      if (!isMissingPathError(error)) debug("transcript stat failed", error);
    }
  }
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0] ?? null;
}

async function transcriptPrefix(path, size) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(size, 256 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function findClaudeTranscript(root) {
  const directory = join(homedir(), ".claude", "projects", encodeClaudeProjectPath(root));
  try {
    const names = await readdir(directory);
    const candidates = [];
    for (const name of names.filter((entry) => entry.endsWith(".jsonl"))) {
      const candidate = await newestFile([join(directory, name)]);
      if (candidate) candidates.push(candidate);
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const candidate of candidates) {
      if (transcriptContainsCwd(await transcriptPrefix(candidate.path, candidate.size), root)) return candidate;
    }
    return null;
  } catch (error) {
    if (!isMissingPathError(error)) debug("Claude transcript directory read failed", error);
    return null;
  }
}

async function collectJsonlFiles(directory, remaining = { value: 4000 }) {
  if (remaining.value <= 0) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (!isMissingPathError(error)) debug("Codex transcript directory read failed", error);
    return [];
  }
  const results = [];
  for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
    if (remaining.value <= 0) break;
    remaining.value -= 1;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await collectJsonlFiles(path, remaining));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) results.push(path);
  }
  return results;
}

async function findCodexTranscript(root) {
  const files = await collectJsonlFiles(join(homedir(), ".codex", "sessions"));
  const ordered = [];
  for (const path of files) {
    try {
      const info = await stat(path);
      ordered.push({ path, mtimeMs: info.mtimeMs, size: info.size });
    } catch (error) {
      // Ignore a transcript that disappeared while scanning.
      if (!isMissingPathError(error)) debug("Codex transcript stat failed", error);
    }
  }
  ordered.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of ordered.slice(0, 200)) {
    if (transcriptContainsCwd(await transcriptPrefix(candidate.path, candidate.size), root)) return candidate;
  }
  return null;
}

async function resolveTranscript(options, root) {
  if (!options.includeHistory) return null;
  if (options.historyPath) {
    const path = resolve(options.historyPath);
    const info = await stat(path);
    if (!info.isFile()) throw new Error("--history-file must point to a regular file");
    return { path, size: info.size, mtimeMs: info.mtimeMs };
  }
  return options.agent === "claude"
    ? await findClaudeTranscript(root)
    : await findCodexTranscript(root);
}

function slugify(value) {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug || "project";
}

async function copyWorkspaceFile(root, stage, path) {
  const source = join(root, path);
  const destination = join(stage, path);
  const info = await lstat(source);
  await mkdir(dirname(destination), { recursive: true });
  if (info.isFile()) {
    await copyFile(source, destination);
    return;
  }
  if (!info.isSymbolicLink()) return;
  const target = await readlink(source);
  if (isAbsolute(target)) return;
  const resolvedTarget = resolve(dirname(source), target);
  if (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}${sep}`)) return;
  await symlink(target, destination);
}

function hashScopeField(hash, label, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  hash.update(`${label}\0${bytes.length}\0`);
  hash.update(bytes);
  hash.update("\0");
}

async function prepareHandoffStage({ root, stage, options, transcript, files }) {
  for (const path of files) await copyWorkspaceFile(root, stage, path);
  const historyPath = transcript
    ? join(stage, ".matrix-handoff", "history", `${options.agent}.jsonl`)
    : null;
  if (historyPath) {
    await mkdir(dirname(historyPath), { recursive: true });
    await copyFile(transcript.path, historyPath);
  }
  const userBrief = options.briefPath ? await readFile(resolve(options.briefPath), "utf8") : "";
  return { historyPath, userBrief };
}

async function readSourceMetadata(root) {
  async function optionalGit(args) {
    try {
      return await run("git", args, { cwd: root });
    } catch (error) {
      debug(`optional git ${args.join(" ")} failed`, error);
      return "";
    }
  }
  const [branch, commit, statusText, remote] = await Promise.all([
    optionalGit(["branch", "--show-current"]),
    optionalGit(["rev-parse", "HEAD"]),
    optionalGit(["status", "--short"]),
    optionalGit(["remote", "get-url", "origin"]),
  ]);
  return { branch, commit, statusText, remote };
}

async function createScopeDigest({
  root,
  stage,
  options,
  transcript,
  files,
  base,
  historyPath,
  userBrief,
  sourceMetadata,
}) {
  const hash = createHash("sha256");
  hashScopeField(hash, "scope", JSON.stringify({
    version: 1,
    root,
    files,
    transcriptPath: transcript?.path ?? null,
    agent: options.agent,
    includeHistory: options.includeHistory,
    profile: options.profile ?? null,
    projectName: base,
    attach: options.attach,
    sourceMetadata,
  }));
  hashScopeField(hash, "brief", userBrief);
  for (const path of files) {
    const stagedPath = join(stage, path);
    const info = await lstat(stagedPath);
    hashScopeField(hash, "path", path);
    hashScopeField(hash, "mode", info.mode & 0o777);
    if (info.isFile()) hashScopeField(hash, "file", await readFile(stagedPath));
    else if (info.isSymbolicLink()) hashScopeField(hash, "symlink", await readlink(stagedPath));
    else hashScopeField(hash, "other", "");
  }
  if (historyPath) hashScopeField(hash, "transcript", await readFile(historyPath));
  return hash.digest("hex");
}

async function writeHandoffMetadata({
  root,
  stage,
  options,
  transcript,
  files,
  uploadId,
  projectDir,
  userBrief,
  sourceMetadata,
}) {
  const metadataDir = join(stage, ".matrix-handoff");
  await mkdir(join(metadataDir, "history"), { recursive: true });
  const { branch, commit, statusText, remote } = sourceMetadata;
  const readme = `# Matrix handoff

Continue the task from the local ${options.agent} session. Inspect the working tree before changing it.

${userBrief.trim() || "No agent-written continuation brief was supplied. Read the transcript when present and ask the user what to continue."}

## Source state

- Original path: \`${root}\`
- Branch: \`${branch || "unknown"}\`
- Commit: \`${commit || "unknown"}\`
- Origin: \`${remote || "not recorded"}\`
- Raw transcript: ${transcript ? `\`.matrix-handoff/history/${options.agent}.jsonl\`` : "not available"}

## Local status at handoff

\`\`\`
${statusText || "clean"}
\`\`\`

Credentials and common secret files were deliberately excluded. Re-authenticate inside Matrix when needed.
`;
  await writeFile(join(metadataDir, "README.md"), readme, { mode: 0o600 });
  await writeFile(join(metadataDir, "manifest.json"), `${JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    sourceRoot: root,
    branch,
    commit,
    origin: remote || null,
    agent: options.agent,
    fileCount: files.length,
    transcriptIncluded: Boolean(transcript),
    uploadId,
    projectDir,
  }, null, 2)}\n`, { mode: 0o600 });
}

async function splitFile(path, outputDir) {
  const info = await stat(path);
  if (info.size > MAX_BUNDLE_BYTES) {
    throw new Error(`Compressed handoff is larger than ${MAX_BUNDLE_BYTES / 1024 / 1024} MiB`);
  }
  const input = await open(path, "r");
  const parts = [];
  try {
    let offset = 0;
    let index = 0;
    while (offset < info.size) {
      const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, info.size - offset));
      const { bytesRead } = await input.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      const part = join(outputDir, `bundle.part-${String(index).padStart(4, "0")}`);
      await writeFile(part, buffer.subarray(0, bytesRead), { flag: "wx", mode: 0o600 });
      parts.push(part);
      offset += bytesRead;
      index += 1;
    }
  } finally {
    await input.close();
  }
  return parts;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function main() {
  let options;
  try {
    options = parseHandoffArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage();
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    printUsage();
    return;
  }

  const root = await repositoryRoot();
  const files = await repositoryFiles(root);
  const transcript = await resolveTranscript(options, root);
  const base = slugify(options.projectName ?? basename(root));
  const sourceMetadata = await readSourceMetadata(root);
  const temp = await mkdtemp(join(tmpdir(), "matrix-handoff-"));
  try {
    const stage = join(temp, "stage");
    await mkdir(stage);
    const { historyPath, userBrief } = await prepareHandoffStage({
      root,
      stage,
      options,
      transcript,
      files,
    });
    const scopeDigest = await createScopeDigest({
      root,
      stage,
      options,
      transcript,
      files,
      base,
      historyPath,
      userBrief,
      sourceMetadata,
    });
    const estimatedBytes = (await Promise.all(
      files.map(async (path) => (await lstat(join(stage, path))).size),
    )).reduce((a, b) => a + b, 0);
    const transcriptBytes = historyPath ? (await stat(historyPath)).size : 0;
    const approved = options.approvalToken?.match(APPROVAL_TOKEN);
    const stamp = approved?.[1]
      ?? new Date().toISOString().replace(/[-:TZ]/g, "").slice(0, 12).toLowerCase();
    const approvalToken = `${stamp}.${scopeDigest}`;
    if (options.approvalToken && options.approvalToken !== approvalToken) {
      throw new Error("Scope changed after preview. Run a new preview and approve its new token.");
    }
    const suffix = scopeDigest.slice(0, 12);
    const uploadId = `handoff-${stamp}-${suffix}`;
    const projectDir = `projects/${base}`;

    console.log("Matrix handoff preview");
    console.log(`  Repository: ${root}`);
    console.log(`  Source files: ${files.length} (${(estimatedBytes / 1024 / 1024).toFixed(1)} MiB before compression)`);
    console.log(`  Transcript: ${transcript ? `${transcript.path} (${(transcriptBytes / 1024 / 1024).toFixed(1)} MiB)` : "none found"}`);
    console.log(`  Matrix destination: ~/${projectDir}`);
    console.log(`  Agent: ${options.agent}`);
    console.log(`  Approval token: ${approvalToken}`);
    console.log("  Excluded: credentials, .env files, private keys, .git, dependencies, and build output");

    if (!options.confirmed) {
      console.log(`\nPreview only. Review the scope, then re-run with --approve ${approvalToken} to upload and continue.`);
      return;
    }

    await writeHandoffMetadata({
      root,
      stage,
      options,
      transcript,
      files,
      uploadId,
      projectDir,
      userBrief,
      sourceMetadata,
    });

    const archive = join(temp, "handoff.tar.gz");
    await run("tar", ["-czf", archive, "-C", stage, "."], { timeout: 300_000 });
    const parts = await splitFile(archive, temp);
    const matrix = process.env.MATRIX_CLI || "matrix";
    const profileArgs = options.profile ? ["--profile", options.profile] : [];
    for (const [index, part] of parts.entries()) {
      console.log(`Uploading part ${index + 1}/${parts.length}...`);
      await run(matrix, ["upload", part, `~/.matrix-handoff/${uploadId}/`, "--force", ...profileArgs], { timeout: 180_000 });
    }
    const extractScript = buildRemoteExtractScript({ uploadId, projectDir });
    await run(matrix, ["run", ...profileArgs, "--", "sh", "-lc", extractScript], { timeout: 300_000 });

    const prompt = "Continue this task from the Matrix handoff. First read .matrix-handoff/README.md and .matrix-handoff/manifest.json, inspect the working tree, then proceed from the continuation brief. Ask before any destructive or external action.";
    const sessionName = `${options.agent}-${base}-${suffix}`.slice(0, 60);
    const command = `${options.agent} ${shellQuote(prompt)}`;
    await run(matrix, ["shell", "new", sessionName, "--cwd", projectDir, "--cmd", command, ...profileArgs], { timeout: 120_000 });

    console.log("\nHandoff ready.");
    console.log(`  Session: ${sessionName}`);
    console.log(`  Project: ~/${projectDir}`);
    console.log("  Open: https://app.matrix-os.com/?launch=__terminal__");
    console.log(`  CLI attach: matrix shell attach ${sessionName}`);
    if (options.attach) {
      await execFileAsync(matrix, ["shell", "attach", sessionName, ...profileArgs], { env: process.env });
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return await realpath(resolve(process.argv[1])) === await realpath(fileURLToPath(import.meta.url));
  } catch (error) {
    debug("entry point resolution failed", error);
    return false;
  }
}

if (await isMainModule()) {
  main().catch((error) => {
    console.error(`Matrix handoff failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
