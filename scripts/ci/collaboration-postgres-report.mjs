#!/usr/bin/env node
// Judges one Vitest run of the real-PostgreSQL suites selected by
// scripts/test-collaboration-postgres.sh from the report written by
// scripts/ci/collaboration-postgres-vitest-reporter.mjs. The run passes only
// when every selected file reported tests, no test was skipped, no module,
// suite hook or unhandled error occurred, and every test failure is a
// quarantined product bug with a linked issue.

import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ISSUE_URL = /^https:\/\/github\.com\/hamedmp\/matrix-os\/issues\/[1-9]\d*$/i;
const SKIPPED_STATES = new Set(["skipped", "pending"]);

/** Parses "<test file>|<full test name>|<issue URL>" lines from the script's quarantine block. */
export function parseQuarantine(lines) {
  const entries = [];
  const errors = [];
  for (const line of lines) {
    const entry = line.trim();
    if (!entry) continue;
    const [file, name, issue, ...rest] = entry.split("|");
    if (rest.length > 0 || !file || !name || !issue || !ISSUE_URL.test(issue)) {
      errors.push(`invalid quarantine entry (expected "<test file>|<full test name>|<issue URL>"): ${entry}`);
      continue;
    }
    entries.push({ file, name, issue });
  }
  return { entries, errors };
}

function testKey(file, name) {
  return `${file} > ${name}`;
}

/**
 * `selection` is the file list this run was given (one shard); `allSelected`
 * is the whole selection, so quarantine entries for another shard are ignored
 * here but entries naming an unselected file still fail.
 */
export function summarizeCollaborationPostgresRun({ report, selection, allSelected = selection, quarantine, vitestStatus }) {
  const errors = [...quarantine.errors];
  const notices = [];
  const counts = { files: selection.length, tests: 0, passed: 0, failed: 0, skipped: 0 };
  const inRun = new Set(selection);
  const selectedAnywhere = new Set(allSelected);
  const quarantined = new Map();
  for (const entry of quarantine.entries) {
    if (!selectedAnywhere.has(entry.file)) {
      errors.push(`quarantine entry names an unselected file: ${testKey(entry.file, entry.name)}`);
    } else if (inRun.has(entry.file)) {
      quarantined.set(testKey(entry.file, entry.name), { ...entry, outcome: undefined });
    }
  }

  if (!report || !Array.isArray(report.modules) || !Array.isArray(report.unhandledErrors)) {
    errors.push("vitest did not write the collaboration report");
  } else {
    const reportedFiles = new Set();
    for (const testModule of report.modules) {
      const file = String(testModule.file);
      const tests = Array.isArray(testModule.tests) ? testModule.tests : [];
      if (tests.length > 0) reportedFiles.add(file);
      for (const error of testModule.errors ?? []) errors.push(`suite error: ${file}: ${error}`);
      for (const test of tests) {
        const key = testKey(file, test.name);
        const entry = quarantined.get(key);
        counts.tests += 1;
        if (entry) entry.outcome = test.state;
        if (test.state === "passed") {
          counts.passed += 1;
          if (entry) notices.push(`quarantined test passed: ${key} (${entry.issue}); remove the entry once the issue is fixed`);
        } else if (test.state === "failed") {
          counts.failed += 1;
          if (entry) {
            notices.push(`quarantined failure: ${key} (${entry.issue})`);
          } else {
            errors.push(`failed: ${key}`);
          }
        } else if (SKIPPED_STATES.has(test.state)) {
          counts.skipped += 1;
          errors.push(`skipped: ${key}`);
        } else {
          errors.push(`unknown state ${JSON.stringify(test.state)}: ${key}`);
        }
      }
    }
    for (const file of selection) {
      if (!reportedFiles.has(file)) errors.push(`not reported: ${file}`);
    }
    for (const error of report.unhandledErrors) errors.push(`unhandled error: ${error}`);
  }

  for (const [key, entry] of quarantined) {
    if (entry.outcome === undefined) errors.push(`quarantine entry matches no test: ${key}`);
  }
  const quarantinedFailures = [...quarantined.values()].filter((entry) => entry.outcome === "failed").length;
  // Backstop for a non-zero exit the report cannot explain.
  if (vitestStatus !== 0 && errors.length === 0 && quarantinedFailures === 0) {
    errors.push(`vitest exited with status ${vitestStatus} without a failing test`);
  }

  return { ok: errors.length === 0, counts, quarantined: [...quarantined.values()], errors, notices };
}

export function renderSummaryMarkdown(summary, shard = "") {
  const lines = [
    `### Collaboration PostgreSQL${shard ? ` ${shard}` : ""}`,
    "",
    "| Metric | Count |",
    "| --- | --- |",
    `| Selected files | ${summary.counts.files} |`,
    `| Tests | ${summary.counts.tests} |`,
    `| Passed | ${summary.counts.passed} |`,
    `| Failed (including quarantined) | ${summary.counts.failed} |`,
    `| Skipped | ${summary.counts.skipped} |`,
    `| Quarantined | ${summary.quarantined.length} |`,
  ];
  if (summary.quarantined.length > 0) {
    lines.push("", "Quarantined product bugs:", "");
    for (const entry of summary.quarantined) {
      lines.push(`- \`${entry.file}\` > ${entry.name}: ${entry.issue} (${entry.outcome ?? "not run"})`);
    }
  }
  if (summary.errors.length > 0) {
    lines.push("", "Failures:", "");
    for (const error of summary.errors) lines.push(`- ${error}`);
  }
  return `${lines.join("\n")}\n`;
}

async function readReport(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function readLines(path) {
  return (await readFile(path, "utf8")).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      report: { type: "string" },
      selection: { type: "string" },
      "all-selected": { type: "string" },
      quarantine: { type: "string" },
      "vitest-status": { type: "string" },
      shard: { type: "string", default: "" },
    },
  });
  for (const option of ["report", "selection", "all-selected", "quarantine", "vitest-status"]) {
    if (!values[option]) throw new Error(`--${option} is required`);
  }
  const summary = summarizeCollaborationPostgresRun({
    report: await readReport(values.report),
    selection: await readLines(values.selection),
    allSelected: await readLines(values["all-selected"]),
    quarantine: parseQuarantine(await readLines(values.quarantine)),
    vitestStatus: Number(values["vitest-status"]),
  });
  const markdown = renderSummaryMarkdown(summary, values.shard);
  for (const notice of summary.notices) console.log(notice);
  for (const error of summary.errors) console.error(error);
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  process.exitCode = summary.ok ? 0 : 1;
}
