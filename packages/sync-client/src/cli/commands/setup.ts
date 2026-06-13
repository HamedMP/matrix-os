import { defineCommand } from "citty";
import { formatCliError, formatCliSuccess } from "../output.js";
import { resolveCliProfile } from "../profiles.js";
import { resolveCliAuthStatus } from "../auth-state.js";
import { fetchJourney, journeyGuidance, describeProgress } from "../journey.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_POLLS = 180; // ~15 min ceiling at the default interval

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const setupCommand = defineCommand({
  meta: {
    name: "setup",
    description: "Create (or retry) your Matrix computer and watch it build",
  },
  args: {
    profile: { type: "string", required: false },
    dev: { type: "boolean", required: false, default: false },
    gateway: { type: "string", required: false },
    platform: { type: "string", required: false },
    token: { type: "string", required: false },
    json: { type: "boolean", required: false, default: false },
    "poll-interval-ms": { type: "string", required: false },
  },
  run: async ({ args }) => {
    const json = args.json === true;
    const pollIntervalMs = typeof args["poll-interval-ms"] === "string"
      ? Math.max(0, Number(args["poll-interval-ms"]) || DEFAULT_POLL_INTERVAL_MS)
      : DEFAULT_POLL_INTERVAL_MS;
    try {
      const profile = await resolveCliProfile(args);
      const authStatus = await resolveCliAuthStatus(profile);
      if (authStatus.status !== "authenticated") {
        console.error(json ? formatCliError("not_authenticated") : "Not signed in. Run `mos login` first.");
        process.exitCode = 1;
        return;
      }
      const token = authStatus.token;
      const platformUrl = profile.platformUrl.replace(/\/+$/, "");

      // Trigger provisioning. retry-provision is idempotent: it converges on an
      // in-flight attempt and retries a failed one.
      const trigger = await fetch(`${platformUrl}/api/journey/retry-provision`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      });
      if (trigger.status === 402) {
        const guidance = journeyGuidance(await fetchJourney(platformUrl, token));
        if (json) console.log(formatCliError("billing_required"));
        else for (const line of guidance.lines) console.log(line);
        process.exitCode = 1;
        return;
      }
      if (trigger.status === 409) {
        console.error(json ? formatCliError("retry_exhausted") : "Setup has failed repeatedly. Contact support@matrix-os.com.");
        process.exitCode = 1;
        return;
      }
      if (!trigger.ok) {
        console.error(json ? formatCliError("setup_failed") : "Couldn't start setup. Please try again shortly.");
        process.exitCode = 1;
        return;
      }

      if (!json) console.log("Building your Matrix computer…");
      let lastStage = "";
      for (let i = 0; i < MAX_POLLS; i += 1) {
        const journey = await fetchJourney(platformUrl, token);
        if (journey) {
          if (journey.phase === "first_run" || journey.phase === "ready") {
            if (json) console.log(formatCliSuccess({ phase: journey.phase, connected: false }));
            else console.log("Your Matrix computer is ready. Run `mos login` to connect.");
            return;
          }
          if (journey.phase === "provisioning_failed") {
            console.error(journey.failure?.retryable
              ? "Setup hit a problem — run `mos setup` again to retry."
              : "Setup failed after several attempts. Contact support@matrix-os.com.");
            process.exitCode = 1;
            return;
          }
          if (journey.phase === "provisioning") {
            const stage = describeProgress(journey);
            if (stage !== lastStage) {
              lastStage = stage;
              if (!json) console.log(`… ${stage}`);
            }
          } else {
            // plan_required / payment_settling — provisioning can't proceed yet.
            const guidance = journeyGuidance(journey);
            if (!json) for (const line of guidance.lines) console.log(line);
            process.exitCode = 1;
            return;
          }
        }
        await sleep(pollIntervalMs);
      }
      console.error(json ? formatCliError("setup_timeout") : "Setup is taking longer than expected. Re-run `mos login` shortly to check.");
      process.exitCode = 1;
    } catch (err: unknown) {
      console.error(json
        ? formatCliError("setup_failed")
        : `Error: setup failed (${err instanceof Error ? err.name : typeof err})`);
      process.exitCode = 1;
    }
  },
});
