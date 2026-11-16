import { SHARED_BROWSER_UNCERTAIN_ACTION_MESSAGE, type SharedBrowserActionResult } from "@matrix-os/contracts";
import { SharedBrowserError, type SharedBrowserBinding, type SharedBrowserBroker } from "./broker.js";

const STOP_UNAVAILABLE_RUN = "Browser control is unavailable. Ask the owner to select Stop agent in Browser if available. After Stop succeeds, start a new run to verify the previous action's outcome.";
const UNAVAILABLE_RUN_GUIDANCE = STOP_UNAVAILABLE_RUN + " Never repeat it while the outcome is uncertain.";

export function sharedBrowserFailureResult(
  error: unknown,
  binding: SharedBrowserBinding,
  browser: Pick<SharedBrowserBroker, "status">,
  { includeUnavailable = false }: { includeUnavailable?: boolean } = {},
): SharedBrowserActionResult | undefined {
  if (!(error instanceof SharedBrowserError)) return;

  const unavailable = includeUnavailable && error.code === "browser_unavailable";
  const refused = !error.dispatched && ["observe_again", "browser_changed", "browser_busy", "tab_limit"].includes(error.code);
  if (!unavailable && !refused) return;

  const automation = browser.status();
  const run = automation.run;
  const sameRun = run?.runId === binding.runId && run.chatId === binding.chatId && run.harness === binding.harness;
  if (unavailable) {
    if (!sameRun || automation.phase !== "unavailable") {
      return { success: false, content: error.dispatched ? SHARED_BROWSER_UNCERTAIN_ACTION_MESSAGE : error.message };
    }
    const content = error.dispatched
      ? "The Browser action's effect is uncertain. Never replay it. " + STOP_UNAVAILABLE_RUN
      : UNAVAILABLE_RUN_GUIDANCE;
    return { success: false, content, automation };
  }

  let content = error.message;
  if (sameRun && error.code === "browser_changed") {
    if (automation.phase === "unavailable") content = UNAVAILABLE_RUN_GUIDANCE;
    if (automation.phase === "human" || automation.phase === "paused") {
      content = "Browser control changed. Wait for the owner to select Resume agent, then take a fresh snapshot.";
    }
  }
  return { success: false, content, automation };
}
