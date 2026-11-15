#!/usr/bin/env node
// Runs one Playwright journey against a run started by `matrix-verify launch`.
// Invoked by `matrix-verify drive <journey.mjs>`, which sets the env below.
// A journey is an ES module: export default async ({ page, step, shot, aria, home, check }) => {}.
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { SHELL_URL, MATRIX_HOME_DIR, EVIDENCE_DIR, RUN_ID, BUILD_SHA } = process.env;
if (!SHELL_URL || !MATRIX_HOME_DIR || !EVIDENCE_DIR) {
  console.error("drive.mjs: run through `matrix-verify drive <journey.mjs>`, not directly");
  process.exit(2);
}
const journeyPath = resolve(process.argv[2] ?? "");
const name = basename(journeyPath).replace(/\.m?js$/, "");
const out = join(EVIDENCE_DIR, name);
await mkdir(out, { recursive: true });

// Resolve Playwright from the repo root (cwd), not from the skill directory.
const { chromium } = createRequire(join(process.cwd(), "package.json"))("playwright");

const logFile = join(out, "journey.log");
await writeFile(logFile, `journey ${name}\nrun ${RUN_ID}\nbuild ${BUILD_SHA}\nshell ${SHELL_URL}\nstarted ${new Date().toISOString()}\n\n`);
const note = async (line) => { console.log(line); await appendFile(logFile, `${line}\n`); };

let shotCount = 0;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`));

const helpers = {
  page,
  /** Labeled user action; failures name the step in journey.log. */
  step: async (label, fn) => {
    await note(`step: ${label}`);
    await fn();
  },
  /** Screenshot into the evidence dir with an ordered prefix. */
  shot: async (label) => {
    const file = join(out, `${String(++shotCount).padStart(2, "0")}-${label}.png`);
    await page.screenshot({ path: file });
    await note(`  screenshot ${file}`);
    return file;
  },
  /** ARIA snapshot of a locator (default: body) into the evidence dir. */
  aria: async (label, locator = page.locator("body")) => {
    const file = join(out, `${label}.aria.txt`);
    await writeFile(file, await locator.ariaSnapshot());
    await note(`  aria ${file}`);
    return file;
  },
  /** Absolute path inside the run's scratch MATRIX_HOME, for side-effect checks. */
  home: (rel) => {
    const abs = resolve(MATRIX_HOME_DIR, rel);
    if (!abs.startsWith(resolve(MATRIX_HOME_DIR))) throw new Error(`path escapes scratch home: ${rel}`);
    return abs;
  },
  /** Record a pass/fail assertion; a failed check fails the journey. */
  check: async (label, ok, detail = "") => {
    await note(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
    if (!ok) throw new Error(`check failed: ${label}`);
  },
  exists: async (abs) => stat(abs).then(() => true, (error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  }),
  readText: (abs) => readFile(abs, "utf8"),
  shellUrl: SHELL_URL,
};

let failed = null;
try {
  await page.goto(`${SHELL_URL}/`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.getByRole("navigation", { name: "Desktop apps" }).waitFor({ timeout: 120_000 });
  const mod = await import(pathToFileURL(journeyPath).href);
  await mod.default(helpers);
} catch (error) {
  failed = error;
  await note(`ERROR ${error instanceof Error ? error.message : String(error)}`);
  await helpers.shot("failure").catch((shotError) => note(`  failure screenshot unavailable: ${shotError}`));
} finally {
  await writeFile(join(out, "console-errors.txt"), consoleErrors.join("\n"));
  await browser.close();
}
await note(`\nresult ${failed ? "FAIL" : "PASS"}  evidence ${out}`);
process.exit(failed ? 1 : 0);
