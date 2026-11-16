#!/usr/bin/env node
// Added-line pattern checks for scripts/review/check-patterns.sh.
//
// The bash scanner checks whole files under packages/ and shell/. These rules
// apply repo-wide but only to lines a change adds (for swallowed errors, any
// catch block the change edits), so existing debt does not
// block unrelated work while new copies of the same mistake fail.
//
// Usage:
//   node scripts/review/check-added-patterns.mjs --base <ref>   # <ref>...HEAD
//   node scripts/review/check-added-patterns.mjs                # merge-base(origin/main)..working tree
//   --pr-size  also enforce the PR size limit over the same range
//   --only pr-size  run only the PR size limit (CI runs it for docs-only PRs too)
//   --filter-exceptions <rule>  read rg-style `path:line:text` hits on stdin and
//                               print those without a valid exception
//
// Exceptions go on the offending line or the line above it:
//   // pattern-allow <rule>: <reason> (expires YYYY-MM-DD, approved-by <human>)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { findSwallowedErrors } from "./swallowed-errors.mjs";

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SKIPPED_PATH = /(?:^|\/)(?:node_modules|dist|\.next|vendor|coverage)\/|\.min\.js$|\.d\.ts$/;
// The bash scanner already rejects bare catches in these files wholesale.
const BASH_CATCH_SCOPE = /^(?:packages|shell)\/.+(?<!\.test|\.spec)\.ts$/;
// The single-line patterns section 1 of check-patterns.sh greps for, per hit kind.
const BASH_CATCH_PATTERN = { "bare-catch": /catch\s*\{/, "empty-catch-handler": /\.catch\(\s*\(\s*\)\s*=>/ };
const EXCEPTION = /pattern-allow ([a-z-]+):\s*(.*?)\s*\(expires (\d{4}-\d{2}-\d{2}), approved-by ([\w.-]+)\)/;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function tryGit(args) {
  try {
    return git(args).trim();
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) return null;
    throw error;
  }
}

export function resolveRange(base) {
  if (tryGit(["rev-parse", "--is-inside-work-tree"]) !== "true") return { skip: "not a git work tree" };
  if (base) {
    if (!tryGit(["rev-parse", "--verify", `${base}^{commit}`])) return { error: `diff base '${base}' not found` };
    // Line numbers come from the committed HEAD, so file contents must too.
    return { diffArgs: [`${base}...HEAD`], includeUntracked: false, readFile: readCommitted };
  }
  const upstream = tryGit(["merge-base", "origin/main", "HEAD"]);
  if (!upstream) return { skip: "origin/main is not available; run git fetch origin main" };
  return { diffArgs: [upstream], includeUntracked: true, readFile: readText };
}

function readCommitted(path) {
  try {
    return git(["cat-file", "blob", `HEAD:${path}`]);
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) return null;
    throw error;
  }
}

function untrackedFiles() {
  return git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
}

function lineCount(text) {
  if (text.length === 0) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && (error.code === "ENOENT" || error.code === "EISDIR")) return null;
    throw error;
  }
}

const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

// Decode a path git printed in C-style quotes, e.g. "b/caf\303\251.mjs".
export function unquoteGitPath(raw) {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const bytes = [];
  const body = raw.slice(1, -1);
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== "\\") {
      bytes.push(...Buffer.from(body[i], "utf8"));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else {
      bytes.push(C_ESCAPES[body[i + 1]] ?? body.charCodeAt(i + 1));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

// Map of path -> { lines, gaps }: 1-based added line numbers, and for each
// pure deletion the new-file line it follows (0 for the top of the file).
export function addedLines(range) {
  const out = new Map();
  const diff = git([
    "diff", "-U0", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "--diff-filter=ACMR",
    ...range.diffArgs,
  ]);
  let current = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      current = line === "+++ /dev/null" ? null : unquoteGitPath(line.slice(4)).slice(2);
      if (current && !out.has(current)) out.set(current, { lines: new Set(), gaps: new Set() });
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count === 0) out.get(current).gaps.add(start);
      for (let n = start; n < start + count; n += 1) out.get(current).lines.add(n);
    }
  }
  if (range.includeUntracked) {
    for (const path of untrackedFiles()) {
      const text = readText(path);
      if (text === null) continue;
      const lines = new Set();
      for (let n = 1; n <= lineCount(text); n += 1) lines.add(n);
      out.set(path, { lines, gaps: new Set() });
    }
  }
  return out;
}

export function exceptionFor(lines, lineNumber, rule, today) {
  for (const candidate of [lines[lineNumber - 1], lines[lineNumber - 2]]) {
    const m = candidate === undefined ? null : EXCEPTION.exec(candidate);
    if (!m || m[1] !== rule) continue;
    if (m[2].length < 3) return { valid: false, why: "exception needs a reason" };
    if (m[3] < today) return { valid: false, why: `exception expired on ${m[3]}` };
    return { valid: true };
  }
  return null;
}

const CATCH_FIX = {
  "bare-catch": "catch without a binding drops the error",
  "empty-catch-handler": ".catch(() => ...) drops the error",
  "unused-catch-binding": "catch binding is never read",
};

// True when the change adds a line in from..to or deletes one strictly inside it.
function touches({ lines, gaps }, from, to) {
  for (let n = from; n <= to; n += 1) if (lines.has(n) || (n < to && gaps.has(n))) return true;
  return false;
}

function checkSwallowedErrors(added, readFile, today, report) {
  for (const [path, changes] of added) {
    if (!SOURCE_FILE.test(path) || SKIPPED_PATH.test(path) || changes.lines.size + changes.gaps.size === 0) continue;
    const text = readFile(path);
    if (text === null) continue;
    const lines = text.split("\n");
    for (const hit of findSwallowedErrors(text)) {
      // A body edit can drop the only read of an unchanged catch's error, so check the whole block.
      if (!touches(changes, hit.line, hit.endLine)) continue;
      // Section 1 of check-patterns.sh reports this exact line (and applies the same exceptions).
      if (BASH_CATCH_SCOPE.test(path) && BASH_CATCH_PATTERN[hit.kind]?.test(lines[hit.line - 1] ?? "")) continue;
      const exception = exceptionFor(lines, hit.line, "swallowed-error", today);
      if (exception?.valid) continue;
      const detail = exception ? ` (${exception.why})` : "";
      report.violation(
        "swallowed-error",
        `${path}:${hit.line}: ${CATCH_FIX[hit.kind]}${detail}. Bind the error, narrow it (instanceof / error.code), ` +
          "and log a safe category before returning a fallback. Use URL.canParse() instead of try/new URL(); " +
          "in tests assert with expect(...).rejects instead.",
      );
    }
  }
}

// [{ path, added, deleted }] for every changed file, renames counted once.
export function changedFileStats(range) {
  const raw = git(["diff", "--numstat", "-z", "-M", "--no-ext-diff", ...range.diffArgs]).split("\0");
  const stats = [];
  for (let i = 0; i < raw.length; i += 1) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(raw[i]);
    if (!m) continue;
    let path = m[3];
    if (path === "") {
      path = raw[i + 2];
      i += 2;
    }
    stats.push({ path, added: m[1] === "-" ? 0 : Number(m[1]), deleted: m[2] === "-" ? 0 : Number(m[2]) });
  }
  if (range.includeUntracked) {
    for (const path of untrackedFiles()) {
      const text = readText(path);
      stats.push({ path, added: text === null ? 0 : lineCount(text), deleted: 0 });
    }
  }
  return stats;
}

export const PR_LIMITS = { files: 50, additions: 3000 };
const PR_SIZE_IGNORED = /(?:^|\/)pnpm-lock\.yaml$/;

function checkPrSize(stats, report) {
  const counted = stats.filter((s) => !PR_SIZE_IGNORED.test(s.path));
  const additions = counted.reduce((sum, s) => sum + s.added, 0);
  if (counted.length <= PR_LIMITS.files && additions <= PR_LIMITS.additions) return;
  report.violation(
    "pr-size",
    `this change touches ${counted.length} files with ${additions} additions ` +
      `(limit ${PR_LIMITS.files} files / ${PR_LIMITS.additions} additions, pnpm-lock.yaml excluded). ` +
      "Split it into GitHub native stack layers with gh stack init / gh stack add (docs/dev/stacked-prs.md); " +
      "for a stack layer, check it with --diff <parent-branch>.",
  );
}

export const FILE_LIMITS = { split: 2000, plan: 1000 };
const GENERATED_PATH = /(?:^|\/)(?:fixtures|generated|__generated__)\//;
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/;

function checkLargeFiles(stats, readFile, today, report) {
  for (const { path, added, deleted } of stats) {
    if (added <= deleted || !SOURCE_FILE.test(path) || SKIPPED_PATH.test(path) || GENERATED_PATH.test(path)) continue;
    const text = readFile(path);
    if (text === null) continue;
    const lines = lineCount(text);
    if (lines <= FILE_LIMITS.plan) continue;
    const growth = `${path} has ${lines} lines and this change grows it by ${added - deleted}`;
    // Review evidence covers source files; oversized suites only warn until they are split by behavior.
    if (TEST_FILE.test(path) && lines > FILE_LIMITS.split) {
      report.warning("large-file", `${growth}. Add new cases in a new focused test file (docs/dev/large-file-refactoring.md).`);
      continue;
    }
    if (lines <= FILE_LIMITS.split) {
      report.warning(
        "large-file",
        `${growth}. Put an extraction plan or follow-up issue in the PR body (docs/dev/large-file-refactoring.md).`,
      );
      continue;
    }
    const marker = text.split("\n").findIndex((line) => EXCEPTION.exec(line)?.[1] === "large-file");
    const exception = marker === -1 ? null : exceptionFor(text.split("\n"), marker + 1, "large-file", today);
    if (exception?.valid) continue;
    report.violation(
      "large-file",
      `${growth}${exception ? ` (${exception.why})` : ""}. Files over ${FILE_LIMITS.split} lines are split before ` +
        "adding behavior: move the new code, or an existing route group or helper family, into a focused module " +
        "first (docs/dev/large-file-refactoring.md).",
    );
  }
}

export function run({ base = null, prSize = false, only = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const findings = { violations: [], warnings: [], notices: [] };
  const report = {
    violation: (rule, message) => findings.violations.push({ rule, message }),
    warning: (rule, message) => findings.warnings.push({ rule, message }),
  };
  const range = resolveRange(base);
  if (range.error) throw new Error(range.error);
  if (range.skip) {
    findings.notices.push(`added-line checks skipped: ${range.skip}`);
    return findings;
  }
  const stats = changedFileStats(range);
  if (only === "pr-size") {
    checkPrSize(stats, report);
    return findings;
  }
  checkSwallowedErrors(addedLines(range), range.readFile, today, report);
  checkLargeFiles(stats, range.readFile, today, report);
  if (prSize) checkPrSize(stats, report);
  return findings;
}

// Keeps rg-style `path:line:text` hits that have no valid exception, so the
// bash scanner and this script make the same exception decision.
export function filterExceptions(hits, rule, today = new Date().toISOString().slice(0, 10)) {
  const cache = new Map();
  const kept = [];
  for (const hit of hits) {
    const m = /^(.*?):(\d+):/.exec(hit);
    if (!m) {
      kept.push(hit);
      continue;
    }
    if (!cache.has(m[1])) cache.set(m[1], readText(m[1])?.split("\n") ?? null);
    const lines = cache.get(m[1]);
    const exception = lines ? exceptionFor(lines, Number(m[2]), rule, today) : null;
    if (exception?.valid) continue;
    kept.push(exception ? `${hit} (${exception.why})` : hit);
  }
  return kept;
}

function main(argv) {
  const filterIndex = argv.indexOf("--filter-exceptions");
  if (filterIndex !== -1) {
    const hits = readFileSync(0, "utf8").split("\n").filter(Boolean);
    for (const hit of filterExceptions(hits, argv[filterIndex + 1])) console.log(hit);
    return 0;
  }
  const baseIndex = argv.indexOf("--base");
  const base = baseIndex === -1 ? null : argv[baseIndex + 1];
  const onlyIndex = argv.indexOf("--only");
  const only = onlyIndex === -1 ? null : argv[onlyIndex + 1];
  if (only !== null && only !== "pr-size") {
    console.error(`check-added-patterns: unknown --only rule '${only}'`);
    return 2;
  }
  let findings;
  try {
    findings = run({ base, prSize: argv.includes("--pr-size"), only });
  } catch (error) {
    console.error(`check-added-patterns: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  for (const notice of findings.notices) console.log(`  ${notice}`);
  for (const { rule, message } of findings.violations) console.log(`  VIOLATION [${rule}] ${message}`);
  for (const { rule, message } of findings.warnings) console.log(`  WARNING [${rule}] ${message}`);
  console.log(`added-line summary: ${findings.violations.length} violation(s), ${findings.warnings.length} warning(s)`);
  return findings.violations.length > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
