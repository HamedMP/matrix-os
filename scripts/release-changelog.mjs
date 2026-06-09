#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const GROUPS = [
  ["New", new Set(["feat"])],
  ["Fixed", new Set(["fix", "revert"])],
  ["Faster", new Set(["perf"])],
  ["Polish and reliability", new Set(["build", "chore", "ci", "docs", "refactor", "style", "test"])],
];
export const FALLBACK_MAX_COMMITS = 100;

function capitalizeSentence(value) {
  if (!value) return value;
  const text = value.replace(/\s+/g, " ").trim();
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`.replace(/[.!?]?$/, ".");
}

export function humanizeCommitSubject(subject) {
  const withoutPrNumber = subject.replace(/\s+\(#\d+\)\s*$/, "").trim();
  const conventional = withoutPrNumber.match(/^([a-z]+)(?:\([^)]+\))?!?:\s*(.+)$/i);
  const text = conventional ? conventional[2] : withoutPrNumber;
  return capitalizeSentence(text.replace(/\bdb\b/gi, "database"));
}

function commitType(subject) {
  const match = subject.match(/^([a-z]+)(?:\([^)]+\))?!?:/i);
  return match?.[1]?.toLowerCase() ?? "other";
}

function groupNameForType(type) {
  for (const [name, types] of GROUPS) {
    if (types.has(type)) return name;
  }
  return "Polish and reliability";
}

export function buildReleaseChangelog(subjects) {
  const grouped = new Map(GROUPS.map(([name]) => [name, []]));
  for (const subject of subjects) {
    const note = humanizeCommitSubject(subject);
    if (!note) continue;
    grouped.get(groupNameForType(commitType(subject)))?.push(note);
  }

  const lines = ["What's changed", ""];
  for (const [name, notes] of grouped) {
    if (notes.length === 0) continue;
    lines.push(name);
    for (const note of notes) {
      lines.push(`- ${note}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function parseArgs(argv) {
  const args = { base: "", head: "HEAD" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base") args.base = argv[++i] ?? "";
    else if (arg === "--head") args.head = argv[++i] ?? "HEAD";
  }
  return args;
}

export function gitLogArgs({ base, head }) {
  const range = base ? `${base}..${head}` : head;
  const args = ["log", "--reverse", "--format=%s"];
  if (!base) {
    args.push(`--max-count=${FALLBACK_MAX_COMMITS}`);
  }
  args.push(range);
  return args;
}

function gitLogSubjects({ base, head }) {
  const args = gitLogArgs({ base, head });
  const output = execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const args = parseArgs(process.argv.slice(2));
  const subjects = gitLogSubjects(args);
  const changelog = subjects.length > 0
    ? buildReleaseChangelog(subjects)
    : "What's changed\n\n- This release keeps Matrix OS up to date.";
  process.stdout.write(`${changelog}\n`);
}
