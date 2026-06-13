// CLI consumer of the platform journey contract (spec 092). The CLI renders the
// user's onboarding phase instead of dead-ending when no machine exists yet.

export interface CliJourneyState {
  phase:
    | "account_required"
    | "plan_required"
    | "payment_settling"
    | "provisioning"
    | "provisioning_failed"
    | "first_run"
    | "ready";
  detail: string;
  nextAction: { kind: string; url?: string };
  progress?: { stage: string; startedAt: string };
  failure?: { retryable: boolean; attempt: number };
  settling?: { since: string; delayed: boolean };
}

/** Fetches the caller's journey state; returns null on any failure (the CLI
 *  falls back to generic guidance — it never blocks on the journey). */
export async function fetchJourney(platformUrl: string, token: string): Promise<CliJourneyState | null> {
  try {
    const res = await fetch(`${platformUrl.replace(/\/+$/, "")}/api/journey`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as CliJourneyState;
  } catch (err: unknown) {
    return null;
  }
}

export interface JourneyGuidance {
  lines: string[];
  /** Suggested next CLI step the user should run, if any. */
  suggestedCommand?: "setup" | "login";
  /** Process exit code: 0 when `mos login` completes a live connection, non-zero when further action is needed. */
  exitCode: number;
}

const STAGE_LABEL: Record<string, string> = {
  creating_server: "creating your server",
  booting: "booting your computer",
  registering: "connecting your computer",
  finalizing: "finishing setup",
};

/**
 * Turns a journey state (or null) into human guidance for the terminal. Pure —
 * returns lines + the suggested next command so login/setup can render and the
 * tests can assert without capturing stdout.
 */
export function journeyGuidance(journey: CliJourneyState | null): JourneyGuidance {
  if (!journey) {
    return {
      lines: [
        "You're signed in, but there's no Matrix computer for this account yet.",
        "Run `mos setup` to create one.",
      ],
      suggestedCommand: "setup",
      exitCode: 1,
    };
  }
  switch (journey.phase) {
    case "account_required":
      // The token no longer maps to a platform account; `mos setup` can't help.
      return {
        lines: ["Your session is no longer valid for this account. Run `mos login` to sign in again."],
        suggestedCommand: "login",
        exitCode: 1,
      };
    case "plan_required":
      return {
        lines: [
          "You're signed in. Choose a plan to create your Matrix computer:",
          journey.nextAction.url ?? "https://app.matrix-os.com/?plans=1",
          "Then run `mos setup`.",
        ],
        suggestedCommand: "setup",
        exitCode: 1,
      };
    case "payment_settling":
      return {
        lines: [
          journey.settling?.delayed
            ? "Your payment is taking longer than expected to confirm — contact support@matrix-os.com if it persists."
            : "Your payment is confirming. Run `mos setup` once it's active.",
        ],
        suggestedCommand: "setup",
        exitCode: 1,
      };
    case "provisioning":
      return {
        lines: ["Your Matrix computer is being built. Run `mos setup` to watch progress."],
        suggestedCommand: "setup",
        exitCode: 1,
      };
    case "provisioning_failed":
      return {
        lines: journey.failure?.retryable
          ? ["Your last setup attempt failed. Run `mos setup` to retry."]
          : ["Setup failed after several attempts. Contact support@matrix-os.com."],
        suggestedCommand: journey.failure?.retryable ? "setup" : undefined,
        exitCode: 1,
      };
    case "first_run":
      return {
        lines: [
          "Your Matrix computer is being set up. Re-run `mos login` to connect once it's ready,",
          `or finish first-run setup at ${journey.nextAction.url ?? "https://app.matrix-os.com/"}.`,
        ],
        suggestedCommand: "login",
        exitCode: 1,
      };
    case "ready":
      return {
        lines: ["Your Matrix computer is ready. Re-run `mos login` to connect."],
        suggestedCommand: "login",
        exitCode: 1,
      };
    default:
      return {
        lines: ["You're signed in, but there's no Matrix computer yet. Run `mos setup` to create one."],
        suggestedCommand: "setup",
        exitCode: 1,
      };
  }
}

export function describeProgress(journey: CliJourneyState): string {
  if (journey.phase === "provisioning" && journey.progress) {
    return STAGE_LABEL[journey.progress.stage] ?? "building your computer";
  }
  return journey.detail;
}
