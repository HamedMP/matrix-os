// PR evidence uploader: signs in with the caller's GitHub CLI token, uploads
// screenshots/recordings to the PR evidence Worker, and comments on the PR.
// No dependencies beyond Node and the `gh` CLI.
import { spawn } from 'node:child_process';
import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

export const DEFAULT_ENDPOINT = 'https://evidence.matrix-os.com';
export const DEFAULT_REPO = 'HamedMP/matrix-os';
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
const API_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const GH_TIMEOUT_MS = 30_000;

export const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

export const USAGE = `Usage: pr-evidence upload <pr> <files...> [--commit <sha>] [--title "..."] [--no-comment]

Uploads screenshots/recordings to the Matrix PR evidence store and comments on the PR.
Auth uses your GitHub CLI login (gh auth token); you need write access to the repo.
Types: png, jpg, webp, gif, mp4, webm, mov. Max ${MAX_FILES} files, 50 MB each.
Env: MATRIX_PR_EVIDENCE_URL overrides the endpoint (local dev); MATRIX_PR_EVIDENCE_REPO\noverrides the repo (default ${DEFAULT_REPO}; must match the Worker's GITHUB_REPO).`;

export class UsageError extends Error {}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') return { help: true };
  if (command !== 'upload') throw new UsageError(`Unknown command: ${command}`);
  const positional = [];
  const options = { commit: null, title: null, comment: true };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--no-comment') options.comment = false;
    else if (arg === '--commit' || arg === '--title') {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      options[arg.slice(2)] = value;
      i += 1;
    } else if (arg.startsWith('--commit=')) options.commit = arg.slice('--commit='.length);
    else if (arg.startsWith('--title=')) options.title = arg.slice('--title='.length);
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  const [prArg, ...files] = positional;
  if (!prArg || !/^[1-9][0-9]{0,8}$/.test(prArg)) throw new UsageError('A PR number is required');
  if (files.length === 0) throw new UsageError('At least one file is required');
  if (files.length > MAX_FILES) throw new UsageError(`At most ${MAX_FILES} files per upload`);
  if (options.commit !== null && !/^[0-9a-fA-F]{7,40}$/.test(options.commit)) {
    throw new UsageError('--commit must be a 7-40 character hex SHA');
  }
  if (options.title !== null && (options.title.length > 200 || /[\r\n]/.test(options.title))) {
    throw new UsageError('--title must be one line of at most 200 characters');
  }
  return { help: false, pr: Number(prArg), files, ...options };
}

export function contentTypeForPath(path) {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? null;
}

function altText(name) {
  return name.replace(/[[\]()<>`*_\\!\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'evidence';
}

/** Images render inline; videos stay as bare links because GitHub only inlines its own uploads. */
export function buildCommentMarkdown({ title, commit, files }) {
  const lines = [title ? `### PR evidence: ${altText(title)}` : '### PR evidence', '', `Commit: \`${commit.slice(0, 12)}\``, ''];
  for (const file of files) {
    if (file.contentType.startsWith('image/')) lines.push(`![${altText(file.name)}](${file.url})`, '');
    else lines.push(`**${altText(file.name)}**`, '', file.url, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function runCommand(command, args, { input, timeoutMs = GH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 100_000) stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve({ stdout });
      else reject(new Error(`${command} ${args[0] ?? ''} failed (${signal ?? code}): ${stderr.trim().slice(0, 500)}`));
    });
    child.stdin.end(input ?? '');
  });
}

/** Must match the Worker's GITHUB_REPO so the PR that is authorized is the PR that gets the comment. */
export function resolveRepo(env) {
  const repo = env.MATRIX_PR_EVIDENCE_REPO?.trim() || DEFAULT_REPO;
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) throw new UsageError('MATRIX_PR_EVIDENCE_REPO must be owner/name');
  return repo;
}

export function resolveEndpoint(env) {
  const raw = env.MATRIX_PR_EVIDENCE_URL?.trim() || DEFAULT_ENDPOINT;
  const url = new URL(raw);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new UsageError('MATRIX_PR_EVIDENCE_URL must be https (http only for localhost)');
  }
  return url.origin;
}

async function errorCode(response) {
  try {
    const body = await response.json();
    return typeof body?.error === 'string' ? body.error : `http_${response.status}`;
  } catch (error) {
    if (error instanceof SyntaxError) return `http_${response.status}`;
    throw error;
  }
}

export async function runUpload(parsed, deps = {}) {
  const {
    exec = runCommand,
    fetchImpl = fetch,
    readFile = fsReadFile,
    stat = fsStat,
    env = process.env,
    log = (line) => process.stderr.write(`${line}\n`),
    out = (text) => process.stdout.write(text),
  } = deps;
  const endpoint = resolveEndpoint(env);

  const files = [];
  for (const path of parsed.files) {
    const contentType = contentTypeForPath(path);
    if (!contentType) throw new UsageError(`Unsupported file type: ${path}`);
    const info = await stat(path);
    if (!info.isFile()) throw new UsageError(`Not a file: ${path}`);
    if (info.size < 1 || info.size > MAX_FILE_BYTES) throw new UsageError(`File must be 1 byte to 50 MB: ${path}`);
    files.push({ path, name: basename(path), contentType, size: info.size });
  }

  const token = (await exec('gh', ['auth', 'token'])).stdout.trim();
  if (!token) throw new Error('gh auth token returned nothing; run `gh auth login` first');
  const repo = resolveRepo(env);
  const commit = parsed.commit
    ?? (await exec('gh', ['pr', 'view', String(parsed.pr), '--repo', repo, '--json', 'headRefOid', '--jq', '.headRefOid'])).stdout.trim();
  if (!/^[0-9a-fA-F]{7,40}$/.test(commit)) throw new Error('Could not resolve the PR head commit');

  // Tickets last five minutes, so request each file's ticket right before its upload.
  const uploaded = [];
  for (const file of files) {
    const response = await fetchImpl(`${endpoint}/uploads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr: parsed.pr, commit, files: [{ name: file.name, contentType: file.contentType, size: file.size }] }),
      redirect: 'error',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Evidence upload was refused: ${await errorCode(response)}`);
    const issued = (await response.json()).files;
    const slot = Array.isArray(issued) && issued.length === 1 ? issued[0] : null;
    if (typeof slot?.uploadUrl !== 'string' || typeof slot?.url !== 'string' || new URL(slot.uploadUrl).origin !== endpoint) {
      throw new Error('Evidence service returned an unexpected upload URL');
    }
    const bytes = await readFile(file.path);
    if (bytes.byteLength !== file.size) throw new Error(`File changed during upload: ${file.path}`);
    const put = await fetchImpl(slot.uploadUrl, {
      method: 'PUT',
      // uploadUrl carries the short-lived signed ticket in its query string.
      headers: { 'Content-Type': file.contentType },
      body: bytes,
      redirect: 'error',
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!put.ok) throw new Error(`Uploading ${file.name} failed: ${await errorCode(put)}`);
    log(`uploaded ${file.name} -> ${slot.url}`);
    uploaded.push({ name: file.name, contentType: file.contentType, url: slot.url });
  }

  const markdown = buildCommentMarkdown({ title: parsed.title, commit, files: uploaded });
  if (parsed.comment) {
    await exec('gh', ['pr', 'comment', String(parsed.pr), '--repo', repo, '--body-file', '-'], { input: markdown });
    log(`commented on PR #${parsed.pr}`);
  } else {
    out(markdown);
  }
  return { commit, files: uploaded, markdown };
}

export async function main(argv, deps = {}) {
  const log = deps.log ?? ((line) => process.stderr.write(`${line}\n`));
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      log(USAGE);
      return 0;
    }
    await runUpload(parsed, deps);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      log(`pr-evidence: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    log(`pr-evidence: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
