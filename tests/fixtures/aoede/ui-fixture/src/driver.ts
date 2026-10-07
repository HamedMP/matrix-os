/**
 * DOM driver for the standalone Aoede fixture.
 *
 * Drives the real `ShellAoedeHost` through each scenario's symbolic steps using
 * only element handles + DOM events (no React internals, no controller
 * handles). `.click()` dispatches a `click` event — real `pointerdown`-based
 * light dismissal stays untouched, which keeps runs deterministic.
 */
import type { AoedeScenario } from "./scenarios";

const LAUNCHER = "[data-aoede-launcher]";
const HOST = "[data-testid='aoede-host']";
const PANEL = ".matrix-aoede";

export interface DriverResult {
  ok: boolean;
  errors: string[];
  /** `.matrix-aoede[data-state]` observed at settle time ("" when closed). */
  state: string;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return null;
    } catch {
      // predicate threw on a transitional DOM — keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return `timed out waiting for ${what}`;
}

function panelButton(text: string, root = PANEL): HTMLElement | null {
  const panel = document.querySelector(root);
  if (!panel) return null;
  for (const button of panel.querySelectorAll("button")) {
    if (button.textContent?.trim() === text && !button.hasAttribute("disabled")) return button as HTMLElement;
  }
  return null;
}

async function step(name: string): Promise<string | null> {
  switch (name) {
    case "open": {
      const launcher = document.querySelector<HTMLElement>(LAUNCHER);
      if (!launcher) return "launcher button missing";
      launcher.click();
      return waitFor(() => Boolean(document.querySelector(HOST)), 5_000, "panel to open");
    }
    case "palette": {
      // Runs the command the shell host registered in the real command store —
      // convergence proof: same singleton controller as the launcher icon.
      const entry = document.querySelector<HTMLElement>("[data-fixture-command='app:__aoede__']");
      if (!entry) return "command-palette Aoede entry missing";
      entry.click();
      return waitFor(() => Boolean(document.querySelector(HOST)), 5_000, "panel to open via command");
    }
    case "start": {
      const error = await waitFor(() => panelButton("Start") !== null, 5_000, "Start button");
      if (error) return error;
      panelButton("Start")!.click();
      return waitFor(
        () => document.querySelector(PANEL)?.getAttribute("data-state") === "permission",
        5_000,
        "permission status",
      );
    }
    case "native-start": {
      const root = "[data-aoede-live]";
      const error = await waitFor(() => panelButton("Start talking", root) !== null, 5_000, "native Start talking button");
      if (error) return error;
      panelButton("Start talking", root)!.click();
      return null; // Actual caption checks wait for the simulated frames.
    }
    case "allow": {
      const error = await waitFor(() => panelButton("Allow microphone") !== null, 5_000, "Allow microphone button");
      if (error) return error;
      panelButton("Allow microphone")!.click();
      return null; // frames settle asynchronously; the ready spec confirms
    }
    case "ptt-hold": {
      const error = await waitFor(() => panelButton("Push to talk") !== null, 5_000, "Push to talk button");
      if (error) return error;
      const button = panelButton("Push to talk")!;
      button.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      return waitFor(
        () => document.querySelector<HTMLElement>("[data-testid='aoede-host'] .matrix-aoede__mic")?.dataset.active === "true"
          || document.querySelector(PANEL)?.textContent?.includes("Microphone active") === true,
        5_000,
        "microphone active indicator",
      );
    }
    default:
      return `unknown drive step ${name}`;
  }
}

async function checkReady(ready: AoedeScenario["ready"]): Promise<string[]> {
  const errors: string[] = [];
  const timeoutMs = 8_000;
  if (ready.closed) {
    const error = await waitFor(
      () => Boolean(document.querySelector(LAUNCHER)) && !document.querySelector(HOST),
      timeoutMs,
      "launcher-only state",
    );
    if (error) errors.push(error);
    return errors;
  }
  if (ready.state) {
    const error = await waitFor(
      () => document.querySelector(PANEL)?.getAttribute("data-state") === ready.state,
      timeoutMs,
      `panel state ${ready.state}`,
    );
    if (error) errors.push(error);
  }
  for (const text of ready.texts ?? []) {
    const error = await waitFor(
      () => document.querySelector(ready.textRoot ?? HOST)?.textContent?.includes(text) === true,
      timeoutMs,
      `panel text "${text}"`,
    );
    if (error) errors.push(error);
  }
  for (const selector of ready.selectors ?? []) {
    const error = await waitFor(
      () => Boolean(document.querySelector(selector)),
      timeoutMs,
      `selector ${selector}`,
    );
    if (error) errors.push(error);
  }
  return errors;
}

export async function driveScenario(scenario: AoedeScenario): Promise<DriverResult> {
  const errors: string[] = [];
  for (const name of scenario.drive) {
    const error = await step(name);
    if (error) errors.push(error);
  }
  if (errors.length === 0) errors.push(...(await checkReady(scenario.ready)));
  return {
    ok: errors.length === 0,
    errors,
    state: document.querySelector(PANEL)?.getAttribute("data-state") ?? "",
  };
}
