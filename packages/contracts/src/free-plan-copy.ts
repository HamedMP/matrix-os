/**
 * User-facing copy for the Free plan (spec 2691, ENG-520). Every surface a free
 * owner sees (the platform sign-up and setup pages, the shell's install step and
 * Settings > Billing, Native Mobile, and the CLI) reads these strings so the plan
 * is described the same way everywhere. Plain strings only: the platform inlines
 * them into its pre-VPS page script.
 */
export const FREE_PLAN_COPY = {
  planName: "Free",
  /** What the plan includes. */
  summary:
    "A full Matrix computer at no cost: 2 GB of memory that grows to 8 GB as you work, 40 GB of disk, and $5 of Matrix AI every day (up to $20 a month).",
  preinstalls:
    "Claude Code and Codex come preinstalled on your free computer. You can install OpenCode or Pi later from the Terminal’s + menu.",
  sleep:
    "Your free computer sleeps after 60 minutes without use and wakes in a few seconds when you open it. Scheduled jobs wake it on time.",
  upgrade: "Upgrade to a paid plan for an always-on computer with more resources.",
  /** Shown when the free plan has no room for another computer. */
  capacityFull: "Free computers are at capacity right now. Try again in a few minutes.",
  /** A free setup start the platform did not accept for another reason. */
  setupRetry: "Matrix could not start setting up your computer. Try again.",
  setupLabel: "Set up",
  settingUpLabel: "Setting up…",
  /** Sign-up page lead when the Free plan is open. */
  signUpLead: "Start on the Free plan. No card needed. Upgrade any time for an always-on computer with more resources.",
} as const;

/** The provisioning response code for "free capacity is full" (`POST /api/auth/provision-runtime`, `POST /api/journey/retry-provision`). */
export const FREE_CAPACITY_FULL_CODE = "busy" as const;

/** Public pricing page, the upgrade path for a free owner until in-app upgrade ships. */
export const MATRIX_PRICING_URL = "https://matrix-os.com/pricing" as const;
