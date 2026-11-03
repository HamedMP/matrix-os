#!/usr/bin/env node
/** Read-only census. Signals never authorize deleting a test or claim execution. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, lstatSync, writeFileSync, openSync, fstatSync, readSync, closeSync, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { analyzeTestEvidence } from "./test-evidence.mjs";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_REVIEW_BYTES = 8 * 1024 * 1024;
const MAX_REVIEWS = 10_000;
const sha256 = data => createHash("sha256").update(data).digest("hex");
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const read = (root, name) => {
  const filename = path.join(root, name);
  const metadata = lstatSync(filename);
  if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) throw new Error(`Unsupported audit input: ${name}`);
  return readFileSync(filename, "utf8");
};

export function isTestEntrypoint(name) {
  if (/(^|\/)(node_modules|\.git|dist|\.next)\//.test(name)) return false;
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(name)
    || /\.(test|spec)\.py$/.test(name)
    || /\.integration\.[cm]?[jt]sx?$/.test(name)
    || /(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(name)
    || /(^|\/)Tests\/.*Tests?\.swift$/.test(name)
    || /\.bats$/.test(name);
}

// Config inspection supports literal globs only. A dynamic collector is reported
// unresolved rather than guessed. This is not Vitest/Jest collection or execution.
function property(object, key) {
  if (!object || !ts.isObjectLiteralExpression(object) || object.properties.some(ts.isSpreadAssignment)) return null;
  const properties = object.properties.filter(p => ts.isPropertyAssignment(p)
    && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === key);
  return properties.length === 1 ? properties[0].initializer : null;
}

function literalArray(node) {
  return node && ts.isArrayLiteralExpression(node) && node.elements.every(ts.isStringLiteral)
    ? node.elements.map(element => element.text) : null;
}

function exportedConfig(source, name) {
  const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  let value;
  for (const node of tree.statements) {
    if (ts.isExportAssignment(node)) value = node.expression;
    else if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)
      && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && node.expression.left.getText(tree) === "module.exports") value = node.expression.right;
  }
  if (value && ts.isCallExpression(value) && value.arguments.length === 1) value = value.arguments[0];
  return value && ts.isObjectLiteralExpression(value) ? value : null;
}

function globRegex(glob) {
  let result = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (glob.slice(i, i + 3) === "**/") { result += "(?:.*/)?"; i += 2; }
    else if (glob.slice(i, i + 2) === "**") { result += ".*"; i++; }
    else if (c === "*") result += "[^/]*";
    else if (c === "?") result += "[^/]";
    else if (".^$+()[]{}|\\".includes(c)) result += `\\${c}`;
    else result += c;
  }
  return new RegExp(result + "$");
}

function collectors(root, names) {
  const configs = [];
  for (const name of names.filter(n => /(^|\/)(?:[\w-]+\.)*(vitest|playwright|jest)(?:\.[\w-]+)*\.config\.[cm]?[jt]s$/.test(n))) {
    const source = read(root, name);
    const configObject = exportedConfig(source, name);
    const testObject = property(configObject, "test");
    let include = literalArray(property(testObject, "include"));
    const excludeNode = property(testObject, "exclude");
    let exclude = literalArray(excludeNode) ?? [];
    if (excludeNode && !literalArray(excludeNode)) include = null;
    let base = path.posix.dirname(name);
    if (base === ".") base = "";
    let limitation = "Literal configuration match only, assuming launch from config directory; execution and conditional skips unverified.";
    const configuredRoot = property(configObject, "root");
    if (configuredRoot) {
      if (ts.isStringLiteral(configuredRoot) && !path.posix.isAbsolute(configuredRoot.text)) base = path.posix.normalize(path.posix.join(base, configuredRoot.text));
      else { include = null; limitation = "Dynamic or absolute config root; collection unresolved."; }
    }
    if (name.endsWith("jest.config.js")) {
      // Parse the repository's documented Jest glob without inventing defaults.
      const match = literalArray(property(configObject, "testMatch"));
      if (match?.length === 1 && match[0] === "**/__tests__/**/*.test.[jt]s?(x)") {
        include = ["**/__tests__/**/*.test.ts", "**/__tests__/**/*.test.tsx", "**/__tests__/**/*.test.js", "**/__tests__/**/*.test.jsx"];
      }
    }
    if (name.includes("playwright")) {
      const directory = property(configObject, "testDir");
      const match = property(configObject, "testMatch");
      if (directory && ts.isStringLiteral(directory) && match?.kind === ts.SyntaxKind.RegularExpressionLiteral) {
        const expression = match.getText();
        const end = expression.lastIndexOf("/");
        configs.push({ config: name, base: path.posix.join(base, directory.text), pattern: new RegExp(expression.slice(1, end), expression.slice(end + 1)), include: null, exclude: [], limitation });
        continue;
      }
      limitation = "Playwright collection is dynamic or uses defaults; inspect its runner.";
    }
    configs.push({ config: name, base, include, exclude, limitation });
  }
  return configs;
}

function matchingCollectors(name, configs) {
  return configs.filter(config => {
    const prefix = config.base ? config.base + "/" : "";
    if (!name.startsWith(prefix)) return false;
    const relative = name.slice(prefix.length);
    if (config.pattern) { config.pattern.lastIndex = 0; return config.pattern.test(relative); }
    if (!config.include) return false;
    return config.include.some(glob => globRegex(glob).test(relative))
      && !config.exclude.some(glob => globRegex(glob).test(relative));
  }).map(config => config.config);
}

function reviewIndex(reviews) {
  if (!Array.isArray(reviews)) throw new Error("Reviews must be an array");
  if (reviews.length > MAX_REVIEWS) throw new Error("Review count limit exceeded");
  // Per-invocation index: reject excess input rather than evicting review evidence.
  const result = new Map();
  for (const review of reviews) {
    if (!review || typeof review.path !== "string" || result.has(review.path)) throw new Error("Invalid or duplicate review path");
    if (!/^[a-f0-9]{64}$/.test(review.sourceSha256 ?? "")
      || !["source-reviewed", "fault-verified"].includes(review.evidenceDepth)
      || !["keep", "strengthen", "consolidate", "remove"].includes(review.decision)
      || typeof review.reviewer !== "string" || !review.reviewer.trim()
      || typeof review.rationale !== "string" || !review.rationale.trim()) throw new Error(`Incomplete review: ${review.path}`);
    if (review.evidenceDepth === "fault-verified" && (typeof review.fault !== "string" || !review.fault.trim())) throw new Error(`Missing fault observation: ${review.path}`);
    result.set(review.path, review);
  }
  return result;
}

export function readReviewLedger(filename) {
  const metadata = lstatSync(filename);
  if (!metadata.isFile() || metadata.size > MAX_REVIEW_BYTES) throw new Error("Review file size limit or regular-file requirement exceeded");
  const descriptor = openSync(filename, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = fstatSync(descriptor);
    if (!current.isFile() || current.size > MAX_REVIEW_BYTES) throw new Error("Review file size limit or regular-file requirement exceeded");
    // Bound the read itself as well: the file can grow after the metadata check.
    const buffer = Buffer.alloc(MAX_REVIEW_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_REVIEW_BYTES) throw new Error("Review file size limit exceeded");
    return JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } finally {
    closeSync(descriptor);
  }
}

export function auditRepository(root, reviews = []) {
  root = path.resolve(root);
  const listing = execFileSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const names = [...new Set(listing.split("\0").filter(Boolean))].filter(name => {
    try { lstatSync(path.join(root, name)); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }).sort(compare);
  const configs = collectors(root, names);
  const reviewed = reviewIndex(reviews);
  const durationPath = "scripts/ci/test-durations.json";
  const historicalDurations = names.includes(durationPath) ? JSON.parse(read(root, durationPath)).durationsMs ?? {} : {};
  const files = names.filter(isTestEntrypoint).map(name => {
    const source = read(root, name);
    const sourceSha256 = sha256(source);
    // Heuristics deliberately include false positives. Helpers, dynamic imports,
    // subprocesses and static policies need source review before any verdict.
    const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g)].map(m => m[1]);
    const signals = [];
    if (/\.[cm]?[jt]sx?$/.test(name) && !imports.some(i => /^(\.|@matrix-os\/|@\/|@renderer\/|@desktop\/)/.test(i))) signals.push("no-direct-production-import");
    if (/readFileSync|\breadFile\s*\(/.test(source)) signals.push("source-or-fixture-read");
    if (/\b(?:it|test|describe|suite)\.(?:skip|todo|skipIf|runIf)\b/.test(source)) signals.push("conditional-or-skipped");
    if (/process\.env|os\.environ/.test(source)) signals.push("environment-dependent");
    if (/\b(?:vi|jest)\.(?:mock|fn|spyOn)\s*\(/.test(source)) signals.push("test-doubles");
    if (/WebSocket\s*=|class\s+\w*(?:Mock|Stub)\w*WebSocket|startStubGateway/.test(source)) signals.push("synthetic-transport");
    const configuredCollectors = matchingCollectors(name, configs);
    if (!configuredCollectors.length) signals.push("collector-unresolved");
    let review = reviewed.get(name);
    if (review && review.sourceSha256 !== sourceSha256) { signals.push("stale-review"); review = undefined; }
    const testDeclarations = /\.[cm]?[jt]sx?$/.test(name) ? analyzeTestEvidence(source, name).tests : [];
    return { path: name, sourceSha256, lines: source.split("\n").length - Number(source.endsWith("\n")), imports: [...new Set(imports)].sort(compare),
      configuredCollectors, executionVerified: false, historicalDurationMs: historicalDurations[name] ?? null,
      testDeclarations,
      signals, evidenceDepth: review?.evidenceDepth ?? "automated-screen", decision: review?.decision ?? "needs-review",
      reviewer: review?.reviewer ?? null, rationale: review?.rationale ?? null, fault: review?.fault ?? null };
  });
  const discovered = new Set(files.map(file => file.path));
  for (const name of reviewed.keys()) if (!discovered.has(name)) throw new Error(`Unknown review path: ${name}`);
  const registrationCandidates = [];
  for (const name of names.filter(name => /\.[cm]?[jt]sx?$/.test(name) && !discovered.has(name))) {
    const source = read(root, name);
    if (!/\b(?:vitest|node:test|@playwright\/test|@jest\/globals)\b/.test(source)) continue;
    const testDeclarations = analyzeTestEvidence(source, name).tests;
    if (testDeclarations.length) registrationCandidates.push({ path: name, sourceSha256: sha256(source),
      configuredCollectors: matchingCollectors(name, configs), testDeclarations, evidenceDepth: "structural-source-screen" });
  }
  const sourceReviewed = files.filter(f => f.evidenceDepth !== "automated-screen").length;
  let commit = null;
  try { commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch (error) { if (error.status !== 128) throw error; }
  const worktreeDirty = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).length > 0;
  return { schemaVersion: 1, headCommit: commit, worktreeDirty, inventorySha256: sha256(files.map(f => `${f.path}\0${f.sourceSha256}\n`).join("")),
    limitations: ["Filename census and heuristic screening; not proof of quality, runtime collection, or execution.", "Configured collectors support literal repository scopes only; unresolved files require runner inspection.", "Historical durations are a dated profile, not a current benchmark or CI savings measurement.", "No automatic deletion or quality verdict. Reviews bind only test bytes; production/dependency changes require re-review."],
    collectors: configs.map(({ pattern, ...config }) => ({ ...config, pattern: pattern?.source ?? null })), registrationCandidates,
    summary: { files: files.length, sourceReviewed, faultVerified: files.filter(f => f.evidenceDepth === "fault-verified").length,
      completeSourceReview: files.length > 0 && sourceReviewed === files.length, collectorUnresolved: files.filter(f => !f.configuredCollectors.length).length,
      historicalProfileFiles: files.filter(f => f.historicalDurationMs !== null).length,
      syntacticJsTestDeclarations: files.reduce((total, file) => total + file.testDeclarations.length, 0),
      localOnlyCandidates: files.reduce((total, file) => total + file.testDeclarations.filter(test => test.classification === "local-only-candidate").length, 0),
      unconventionalRegistrationFiles: registrationCandidates.length }, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--root", "--output", "--reviews"].includes(args[i]) || !args[i + 1]) throw new Error("Usage: node scripts/testing/audit-test-suite.mjs [--root DIR] [--reviews JSON] [--output JSON]");
    options[args[i]] = args[i + 1];
  }
  const report = auditRepository(options["--root"] ?? process.cwd(), options["--reviews"] ? readReviewLedger(options["--reviews"]) : []);
  if (options["--output"]) writeFileSync(options["--output"], JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(JSON.stringify(report.summary, null, 2) + "\n");
}
