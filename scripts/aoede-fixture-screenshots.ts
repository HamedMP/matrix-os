/**
 * Screenshot runner for the standalone Aoede fixture.
 *
 * Boots the vite fixture (`dev:aoede:fixture` equivalent, strict localhost port),
 * visits every scenario on both `web_canvas` and `web_desktop`, waits for the
 * `[data-aoede-ready]` marker, asserts the standalone invariants (launcher
 * present, panel visible where the scenario expects it, zero Chat DOM), and
 * writes PNGs to `.amp/in/artifacts/aoede/<surface>-<scenario>.png`.
 *
 * Run: `pnpm exec tsx scripts/aoede-fixture-screenshots.ts` (or `bun`).
 * Requires a Playwright chromium build (the bundled headless shell is enough).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PORT = 5_199;
const BASE_URL = `http://127.0.0.1:${FIXTURE_PORT}`;
const OUT_DIR = path.join(REPO_ROOT, ".amp/in/artifacts/aoede");
const SURFACES = ["web_canvas", "web_desktop"] as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function fixtureProblems(state: {
  ready: string | null | undefined;
  launcher: boolean;
  host: boolean;
  chatDom: boolean;
  schemaIssues: string | null | undefined;
}, closed: boolean): string[] {
  const problems: string[] = [];
  if (!state.launcher) problems.push("launcher missing");
  if (state.chatDom) problems.push("Chat DOM marker detected — fixture must never render Chat");
  if (state.ready !== "true") problems.push("driver did not settle successfully");
  if (state.host === closed) problems.push("standalone host visibility mismatch");
  if (state.schemaIssues !== "0") problems.push("fixture schema validation failed");
  return problems;
}

async function waitForServer(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // server not up yet
    }
    await sleep(250);
  }
  throw new Error(`fixture server did not start on ${BASE_URL}`);
}

async function main() {
  const { chromium } = await import("playwright");
  mkdirSync(OUT_DIR, { recursive: true });

  const server: ChildProcess = spawn(
    "pnpm",
    ["exec", "vite", "--config", "tests/fixtures/aoede/ui-fixture/vite.config.ts", "--host", "127.0.0.1", "--port", String(FIXTURE_PORT), "--strictPort"],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  server.stdout?.on("data", (chunk: Buffer) => {
    const line = chunk.toString();
    if (!/vite v|Local:|ready in/.test(line)) process.stdout.write(line);
  });

  const results: Array<{ surface: string; scenario: string; status: string; state: string; problems: string[] }> = [];
  const writeStatus = (extra: Record<string, unknown> = {}) => {
    writeFileSync(
      path.join(OUT_DIR, "run-status.json"),
      JSON.stringify({ at: new Date().toISOString(), baseUrl: BASE_URL, results, ...extra }, null, 2),
    );
  };

  let failed = false;
  try {
    await waitForServer();
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      // Artifact honesty: record that no runnable chromium was found so callers
      // and reviewers see a written status instead of a silent absence of PNGs.
      writeStatus({ browser: "unavailable", reason: error instanceof Error ? error.message : String(error) });
      console.warn(
        "playwright chromium unavailable — wrote .amp/in/artifacts/aoede/run-status.json "
        + "with browser=unavailable; no PNGs produced.",
      );
      process.exitCode = 1;
      return;
    }
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      const scenarioIds = await page.$$eval("[data-scenario-id]", (nodes) =>
        nodes.map((node) => node.getAttribute("data-scenario-id")).filter(Boolean) as string[]);
      if (scenarioIds.length === 0) throw new Error("fixture did not publish a scenario index");
      console.log(`scenarios: ${scenarioIds.join(", ")}`);

      for (const surface of SURFACES) {
        for (const scenario of scenarioIds) {
          const url = `${BASE_URL}/?surface=${surface}&scenario=${scenario}`;
          await page.goto(url, { waitUntil: "domcontentloaded" });
          await page.waitForSelector("[data-aoede-launcher]", { timeout: 15_000 });
          await page.waitForFunction(
            () => ["true", "error"].includes(document.querySelector("#aoede-fixture-ready")?.getAttribute("data-aoede-ready") ?? ""),
            undefined,
            { timeout: 30_000 },
          );
          const state = await page.evaluate(() => ({
            ready: document.querySelector("#aoede-fixture-ready")?.getAttribute("data-aoede-ready"),
            panelState: document.querySelector("#aoede-fixture-ready")?.getAttribute("data-aoede-state"),
            launcher: Boolean(document.querySelector("[data-aoede-launcher]")),
            host: Boolean(document.querySelector("[data-testid='aoede-host']")),
            chatDom: Boolean(document.querySelector(
              "[data-chat-root], .fixture-chat, article[data-app-path='__chat__'], [data-testid='chat-window'], [data-testid='chat-app']",
            )),
            schemaIssues: document.querySelector(".fixture-evidence")?.getAttribute("data-schema-issues"),
          }));
          const problems = fixtureProblems(state, scenario === "idle");
          const name = `${surface}-${scenario}.png`;
          await page.screenshot({ path: path.join(OUT_DIR, name), fullPage: true });
          // Exercise controls after capturing the pending state. These checks
          // prove real host/controller mutations and keyboard focus, not only
          // canned-card visibility. The backend and speech remain fake.
          try {
            if (scenario === "idle") {
              const launcher = page.locator("[data-aoede-launcher]");
              await launcher.focus();
              await launcher.press("Enter");
              await page.getByRole("dialog", { name: "Aoede assistant" }).waitFor();
              if (await page.getByRole("dialog").getAttribute("aria-modal") !== "false") throw new Error("assistant must be nonmodal");
              await page.keyboard.press("Escape");
              await page.waitForFunction(() => document.activeElement?.hasAttribute("data-aoede-launcher"));
              const palette = page.locator("[data-fixture-command='app:__aoede__']");
              await palette.focus();
              await palette.press("Enter");
              await page.getByRole("dialog", { name: "Aoede assistant" }).waitFor();
              await page.keyboard.press("Escape");
              await page.waitForFunction(() => document.activeElement?.getAttribute("data-fixture-command") === "app:__aoede__");
              const media = await page.locator(".fixture-evidence").textContent();
              // Dismissal records cleanup (`end`) even if Start was never used.
              // Assert acquisition, not the absence of legitimate cleanup.
              if (!media || media.includes("startVoice:")) throw new Error("launch started media");
            } else if (scenario === "clarification") {
              const choice = page.getByRole("radio").nth(1);
              await choice.focus();
              await choice.press("Space");
              await page.getByRole("button", { name: "Submit answer", exact: true }).press("Enter");
              await page.getByText("Answer submitted", { exact: true }).waitFor();
              await page.screenshot({ path: path.join(OUT_DIR, `${surface}-clarification-submitted.png`), fullPage: true });
            } else if (scenario === "approval") {
              await page.getByRole("button", { name: "Approve", exact: true }).click();
              await page.getByText("Decision: Approve", { exact: true }).waitFor();
            } else if (scenario === "navigation-artifact") {
              await page.getByRole("button", { name: "Open timer", exact: true }).click();
              await page.waitForFunction(() => document.querySelector(".fixture-evidence")?.textContent?.includes("navigation:timer:apps/timer"));
              await page.getByRole("button", { name: "Open result: apps/timer/App.tsx", exact: true }).click();
              await page.waitForFunction(() => document.querySelector(".fixture-evidence")?.textContent?.includes("result:apps/timer/App.tsx"));
            } else if (scenario === "tool-activity" && await page.getByRole("button", { name: "Cancel action", exact: true }).count() !== 0) {
              throw new Error("post-dispatch tool offers unsupported cancellation");
            }
            if (await page.locator(".fixture-evidence").getAttribute("data-schema-issues") !== "0") throw new Error("interaction produced schema issues");
          } catch (error: unknown) {
            problems.push(error instanceof Error ? error.message : "fixture interaction failed");
          }
          const status = problems.length ? "FAIL" : "ok";
          results.push({ surface, scenario, status, state: state.panelState ?? "closed", problems });
          console.log(`${status} ${name} state=${state.panelState ?? "closed"}${problems.length ? ` — ${problems.join("; ")}` : ""}`);
          if (problems.length) failed = true;
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
    await sleep(300);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  writeStatus({ browser: "ok", failed });
  if (failed) {
    console.error("\nSome scenarios failed their invariants — see FAIL lines above.");
    process.exitCode = 1;
  } else {
    console.log(`\nScreenshots written to ${path.relative(REPO_ROOT, OUT_DIR)}/`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch((error: unknown) => {
  // Even catastrophic failure leaves an artifact trail.
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      path.join(OUT_DIR, "run-status.json"),
      JSON.stringify({ at: new Date().toISOString(), browser: "unknown", error: error instanceof Error ? error.message : String(error) }, null, 2),
    );
  } catch {
    // artifact write is best-effort; the console line below is the fallback
  }
  console.error("aoede fixture screenshots failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
