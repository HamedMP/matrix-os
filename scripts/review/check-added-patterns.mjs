#!/usr/bin/env node
// Added-line pattern checks for scripts/review/check-patterns.sh.
//
// The bash scanner checks whole files under packages/ and shell/. These rules
// apply repo-wide but only to lines a change adds, so existing debt does not
// block unrelated work while new copies of the same mistake fail.
//
// Usage:
//   node scripts/review/check-added-patterns.mjs --base <ref>   # <ref>...HEAD
//   node scripts/review/check-added-patterns.mjs                # merge-base(origin/main)..working tree
//   --pr-size  also enforce the PR size limit over the same range
//
// Exceptions go on the offending line or the line above it:
//   // pattern-allow <rule>: <reason> (expires YYYY-MM-DD, approved-by <human>)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SKIPPED_PATH = /(?:^|\/)(?:node_modules|dist|\.next|vendor|coverage)\/|\.min\.js$|\.d\.ts$/;
// The bash scanner already rejects bare catches in these files wholesale.
const BASH_CATCH_SCOPE = /^(?:packages|shell)\/.+(?<!\.test|\.spec)\.ts$/;
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
    return { diffArgs: [`${base}...HEAD`], includeUntracked: false };
  }
  const upstream = tryGit(["merge-base", "origin/main", "HEAD"]);
  if (!upstream) return { skip: "origin/main is not available; run git fetch origin main" };
  return { diffArgs: [upstream], includeUntracked: true };
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

// Map of path -> Set of 1-based added line numbers.
export function addedLines(range) {
  const out = new Map();
  const diff = git(["diff", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=ACMR", ...range.diffArgs]);
  let current = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      current = line === "+++ /dev/null" ? null : line.slice(6);
      if (current && !out.has(current)) out.set(current, new Set());
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let n = start; n < start + count; n += 1) out.get(current).add(n);
    }
  }
  if (range.includeUntracked) {
    for (const path of untrackedFiles()) {
      const text = readText(path);
      if (text === null) continue;
      const lines = new Set();
      for (let n = 1; n <= lineCount(text); n += 1) lines.add(n);
      out.set(path, lines);
    }
  }
  return out;
}

// Replace comment and string contents with spaces, keeping offsets and
// newlines, so code-shaped text in prose, prompts, or fixtures is ignored.
// Single and double quoted strings end at a newline, which bounds the damage
// from JSX text such as `Don't`.
export function maskSource(text) {
  const out = text.split("");
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) if (out[i] !== "\n") out[i] = " ";
  };
  // Brace depth of each open `${ ... }` template expression, innermost last.
  const templateDepths = [];
  const scanTemplate = (from) => {
    let j = from;
    while (j < text.length && text[j] !== "`") {
      if (text[j] === "\\") j += 2;
      else if (text[j] === "$" && text[j + 1] === "{") {
        blank(from, j);
        templateDepths.push(0);
        return j + 2;
      } else j += 1;
    }
    blank(from, Math.min(j, text.length));
    return j + 1;
  };
  let i = 0;
  let lastSignificant = "";
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (templateDepths.length > 0 && (ch === "{" || ch === "}")) {
      const top = templateDepths.length - 1;
      if (ch === "{") templateDepths[top] += 1;
      else if (templateDepths[top] > 0) templateDepths[top] -= 1;
      else {
        templateDepths.pop();
        i = scanTemplate(i + 1);
        lastSignificant = "`";
        continue;
      }
    }
    if (ch === "`") {
      i = scanTemplate(i + 1);
      lastSignificant = "`";
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) {
        if (text[j] === "\\") j += 1;
        else if (text[j] === "\n") break;
        j += 1;
      }
      blank(i + 1, Math.min(j, text.length));
      i = j + 1;
      lastSignificant = ch;
      continue;
    }
    if (ch === "/" && (lastSignificant === "" || "(,=:[!&|?{};+-*%<>~^".includes(lastSignificant))) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== "\n" && (inClass || text[j] !== "/")) {
        if (text[j] === "\\") j += 1;
        else if (text[j] === "[") inClass = true;
        else if (text[j] === "]") inClass = false;
        j += 1;
      }
      if (text[j] === "/") {
        blank(i + 1, j);
        i = j + 1;
        lastSignificant = "/";
        continue;
      }
    }
    if (!/\s/.test(ch)) lastSignificant = ch;
    i += 1;
  }
  return out.join("");
}

function matchClose(masked, openIndex, open, close) {
  let depth = 0;
  for (let i = openIndex; i < masked.length; i += 1) {
    if (masked[i] === open) depth += 1;
    else if (masked[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return masked.length;
}

function lineOf(lineStarts, index) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const uses = (body, name) => new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(body);

// Returns { line, kind } for each catch that drops its error.
export function findSwallowedErrors(text) {
  const masked = maskSource(text);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") lineStarts.push(i + 1);
  const found = [];

  const clause = /(?<![\w$.]\s*)\bcatch\s*(?:\(([^()]*)\))?\s*\{/g;
  for (let m = clause.exec(masked); m; m = clause.exec(masked)) {
    if (/\.\s*$|\?\.\s*$/.test(masked.slice(Math.max(0, m.index - 3), m.index))) continue;
    const binding = (m[1] ?? "").trim();
    const line = lineOf(lineStarts, m.index);
    if (!binding) {
      found.push({ line, kind: "bare-catch" });
      continue;
    }
    const name = /^([A-Za-z_$][\w$]*)/.exec(binding)?.[1];
    if (!name) continue; // destructuring binds the parts it needs
    const open = m.index + m[0].length - 1;
    const body = masked.slice(open + 1, matchClose(masked, open, "{", "}"));
    if (!uses(body, name)) found.push({ line, kind: "unused-catch-binding", name });
  }

  const method = /\.\s*catch\s*\(/g;
  for (let m = method.exec(masked); m; m = method.exec(masked)) {
    const callOpen = m.index + m[0].length - 1;
    const callClose = matchClose(masked, callOpen, "(", ")");
    const args = masked.slice(callOpen + 1, callClose);
    const line = lineOf(lineStarts, m.index);
    const handler =
      /^\s*(?:async\s*)?\(\s*([A-Za-z_$][\w$]*)?\s*(?::[^)]*)?\)\s*=>\s*/.exec(args) ??
      /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>\s*/.exec(args) ??
      /^\s*(?:async\s+)?function\s*[\w$]*\s*\(\s*([A-Za-z_$][\w$]*)?\s*(?::[^)]*)?\)\s*/.exec(args);
    if (!handler) continue; // a named handler such as .catch(logFailure)
    const name = handler[1];
    if (!name) {
      found.push({ line, kind: "empty-catch-handler" });
      continue;
    }
    if (!uses(args.slice(handler[0].length), name)) found.push({ line, kind: "unused-catch-binding", name });
  }
  return found;
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

function checkSwallowedErrors(added, today, report) {
  for (const [path, lineSet] of added) {
    if (!SOURCE_FILE.test(path) || SKIPPED_PATH.test(path) || lineSet.size === 0) continue;
    const text = readText(path);
    if (text === null) continue;
    const lines = text.split("\n");
    for (const hit of findSwallowedErrors(text)) {
      if (!lineSet.has(hit.line)) continue;
      if (hit.kind !== "unused-catch-binding" && BASH_CATCH_SCOPE.test(path)) continue;
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

function checkLargeFiles(stats, today, report) {
  for (const { path, added, deleted } of stats) {
    if (added <= deleted || !SOURCE_FILE.test(path) || SKIPPED_PATH.test(path) || GENERATED_PATH.test(path)) continue;
    const text = readText(path);
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

export function run({ base = null, prSize = false, today = new Date().toISOString().slice(0, 10) } = {}) {
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
  checkSwallowedErrors(addedLines(range), today, report);
  const stats = changedFileStats(range);
  checkLargeFiles(stats, today, report);
  if (prSize) checkPrSize(stats, report);
  return findings;
}

function main(argv) {
  const baseIndex = argv.indexOf("--base");
  const base = baseIndex === -1 ? null : argv[baseIndex + 1];
  let findings;
  try {
    findings = run({ base, prSize: argv.includes("--pr-size") });
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
