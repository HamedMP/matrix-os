#!/usr/bin/env node
// Judges one Vitest run of the real-PostgreSQL suites selected by
// scripts/test-collaboration-postgres.sh. The run passes only when every
// selected file reported tests, no test was skipped, and every failure is a
// quarantined product bug with a linked issue.

import { appendFile, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ISSUE_URL = /^https:\/\/github\.com\/hamedmp\/matrix-os\/issues\/[1-9]\d*$/i;
const UNHANDLED_ERROR = /Vitest caught \d+ unhandled errors? during the test run|There were unhandled errors during test collection/;
const SKIPPED_STATUSES = new Set(["skipped", "pending", "todo", "disabled"]);

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

export function summarizeCollaborationPostgresRun({ report, selection, quarantine, vitestStatus, vitestLog, root }) {
  const errors = [...quarantine.errors];
  const notices = [];
  const counts = { files: selection.length, tests: 0, passed: 0, failed: 0, skipped: 0 };
  const quarantined = new Map(quarantine.entries.map((entry) => [testKey(entry.file, entry.name), { ...entry, outcome: undefined }]));
  const reportedFiles = new Set();

  if (!report || !Array.isArray(report.testResults)) {
    errors.push("vitest did not write a JSON report");
  } else {
    for (const result of report.testResults) {
      const file = relative(root, resolve(root, String(result.name)));
      const assertions = Array.isArray(result.assertionResults) ? result.assertionResults : [];
      if (assertions.length > 0) reportedFiles.add(file);
      if (result.status === "failed" && !assertions.some((assertion) => assertion.status === "failed")) {
        errors.push(`failed to run: ${file}${result.message ? ` (${result.message})` : ""}`);
      }
      for (const assertion of assertions) {
        const key = testKey(file, assertion.fullName);
        const entry = quarantined.get(key);
        counts.tests += 1;
        if (entry) entry.outcome = assertion.status;
        if (assertion.status === "passed") {
          counts.passed += 1;
          if (entry) notices.push(`quarantined test passed: ${key} (${entry.issue}); remove the entry once the issue is fixed`);
        } else if (assertion.status === "failed") {
          if (entry) {
            notices.push(`quarantined failure: ${key} (${entry.issue})`);
          } else {
            counts.failed += 1;
            errors.push(`failed: ${key}`);
          }
        } else if (SKIPPED_STATUSES.has(assertion.status)) {
          counts.skipped += 1;
          errors.push(`skipped: ${key}`);
        } else {
          errors.push(`unknown status ${JSON.stringify(assertion.status)}: ${key}`);
        }
      }
    }
    for (const file of selection) {
      if (!reportedFiles.has(file)) errors.push(`not reported: ${file}`);
    }
  }

  for (const [key, entry] of quarantined) {
    if (entry.outcome === undefined) errors.push(`quarantine entry matches no test: ${key}`);
  }
  if (UNHANDLED_ERROR.test(vitestLog)) {
    errors.push("vitest reported an unhandled error outside any test");
  }
  const quarantinedFailures = [...quarantined.values()].filter((entry) => entry.outcome === "failed").length;
  if (vitestStatus !== 0 && errors.length === 0 && quarantinedFailures === 0) {
    errors.push(`vitest exited with status ${vitestStatus} without a failing test`);
  }

  return { ok: errors.length === 0, counts, quarantined: [...quarantined.values()], errors, notices };
}

export function renderSummaryMarkdown(summary) {
  const lines = [
    "### Collaboration PostgreSQL",
    "",
    "| Metric | Count |",
    "| --- | --- |",
    `| Selected files | ${summary.counts.files} |`,
    `| Tests | ${summary.counts.tests} |`,
    `| Passed | ${summary.counts.passed} |`,
    `| Failed | ${summary.counts.failed} |`,
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

async function readOptionalText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function readReport(path) {
  const text = await readOptionalText(path);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function lines(text) {
  return text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      report: { type: "string" },
      selection: { type: "string" },
      quarantine: { type: "string" },
      "vitest-status": { type: "string" },
      "vitest-log": { type: "string" },
    },
  });
  for (const option of ["report", "selection", "quarantine", "vitest-status", "vitest-log"]) {
    if (!values[option]) throw new Error(`--${option} is required`);
  }
  const summary = summarizeCollaborationPostgresRun({
    report: await readReport(values.report),
    selection: lines(await readFile(values.selection, "utf8")),
    quarantine: parseQuarantine(lines(await readFile(values.quarantine, "utf8"))),
    vitestStatus: Number(values["vitest-status"]),
    vitestLog: await readOptionalText(values["vitest-log"]),
    root: process.cwd(),
  });
  const markdown = renderSummaryMarkdown(summary);
  for (const notice of summary.notices) console.log(notice);
  for (const error of summary.errors) console.error(error);
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  process.exitCode = summary.ok ? 0 : 1;
}
