# Feature flags

Matrix OS turns runtime features on and off with PostHog feature flags, so a
feature can be switched or rolled out without a deploy (ENG-608). Env vars and
Secret Manager keep everything that is not a runtime switch.

| Layer | Holds | Examples |
| --- | --- | --- |
| Env / Secret Manager | Secrets, infrastructure config, capacity numbers, "is this capability installed here" gates | `METAL_HOSTS_ENABLED`, hostd tokens and CA, `METAL_GOLDEN_VERSION`, `MATRIX_FREE_TIER_MAX_RUNTIMES`, `MATRIX_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD` |
| PostHog flag | Runtime on/off and rollout (internal first, percentage, everyone) | `free-tier-enabled`, `free-tier-sleep`, `free-tier-invite-required` |

The effective state is **env capability AND flag**. Never put secrets, numeric
limits, email addresses or other personal data in a flag.

## Server-side flags (platform)

`packages/platform/src/feature-flags/server-flags.ts` evaluates flags locally:

- Definitions are polled every 15 s from
  `/api/feature_flag/local_evaluation` with the PostHog feature-flags secure API
  key. A request never waits on PostHog.
- Each poll has a 10 s timeout and refuses redirects. The client may make no
  other request, so no capture events, no remote evaluation, and no distinct id
  ever leave the platform.
- **Cold start fails closed**: until definitions first load, a flag is unknown
  and the switch takes its `whenUnknown` value.
- **Outages keep the last known definitions**: a failed or 5xx poll leaves the
  loaded definitions in place.
- A flag missing from the project is unknown, so create each flag in PostHog
  **before** configuring the key.
- The distinct id is the Clerk user id (`user_...`) or a fixed platform id. Ids
  containing `@` or spaces are refused. Target internal-first rollouts with a
  `distinct_id` condition listing Clerk user ids, or with a percentage.
  Conditions on person properties or cohorts cannot be evaluated locally and
  read as unknown.

### Settings

| Name | Kind | Purpose |
| --- | --- | --- |
| `POSTHOG_FEATURE_FLAGS_SECURE_API_KEY` | Secret Manager `posthog-feature-flags-secure-api-key` | Feature-flags secure API key (`phs_...`). Unset: flags are unconfigured and every switch keeps its env behavior. |
| `POSTHOG_PROJECT_TOKEN` (or `POSTHOG_TOKEN`) | existing secret | Public project token the definitions request names. |
| `POSTHOG_FEATURE_FLAGS_HOST` | optional env | Private API host for definitions. Defaults to `POSTHOG_API_HOST`, then `POSTHOG_HOST`, then `https://eu.i.posthog.com`. Must be an absolute `https` origin (never the `/relay` client path). |
| `POSTHOG_SERVER_FLAGS_ENABLED` | GitHub variable for `platform-cloud-run.yml` | `true` preflights and binds the secret on the Cloud Run service (and the worker, whose manifest is copied from it). Default `false`. |

A key with an invalid companion setting fails closed (every flag unknown) and
logs the setting name only.

### Using a switch

```ts
import { PLATFORM_FEATURE_FLAGS, resolveRuntimeSwitch } from '../feature-flags/server-flags.js';

const enabled = await resolveRuntimeSwitch(flags, {
  flag: PLATFORM_FEATURE_FLAGS.myFeature, // add the key to PLATFORM_FEATURE_FLAGS
  whenUnconfigured: envSaysOn,             // today's env behavior when no key is configured
  whenUnknown: false,                      // cold start or missing flag: the safe side
}, { distinctId: clerkUserId });
```

Keep the env capability gate in front: compose the feature only when its env
capability is on, then ask the switch.

## Free tier flags (ENG-520)

| Flag | Gates | Flag known | Cold start / missing | No key configured |
| --- | --- | --- | --- | --- |
| `free-tier-enabled` | New free admission and the Free offer on the signup journey. Admitted owners keep their runtime. | flag | no new admission | open (`MATRIX_FREE_TIER_ENABLED` already enabled the tier) |
| `free-tier-invite-required` | Whether admission needs an invite | flag | invites required | `MATRIX_FREE_TIER_INVITE_REQUIRED` |
| `free-tier-sleep` | The idle sleeper's suspends. Scheduled wakes and resumes keep running. | flag | no suspends | sleeps (`MATRIX_FREE_TIER_SLEEP_ENABLED` already installed the sleeper) |

A change to `free-tier-sleep` triggers a sleeper pass as soon as the poll
applies it (`onFlagChange`), so it takes effect within one 15 s poll plus the
pass already in flight (at most 30 s), rather than waiting for the 60 s interval.

`MATRIX_FREE_TIER_ENABLED` and `MATRIX_FREE_TIER_SLEEP_ENABLED` stay as the
capability layer: with either off, the flag cannot turn that part on.
Recommended rollout: create all three flags (enabled for nobody, invite
required for everyone), set the secret and `POSTHOG_SERVER_FLAGS_ENABLED=true`,
deploy, then target internal Clerk user ids before widening.

## Client-side flags

Web and Electron gates use `useFeatureFlag` from `packages/ui/src/feature-flags.ts`.
A client flag hides or shows UI only; the server decides access.

## Inventory of env toggles

Env-based toggles found in `packages/platform`, `packages/gateway` and `shell`
(Nov 2026). This PR migrates only the free tier. Recommendations:
**migrate** (a runtime switch or rollout that belongs in a flag; keep any
capability half in env), **capability** (needs secrets or infrastructure, keep
in env), **config** (deployment, debug, or third-party tool setting).

| Setting | Where | Recommendation |
| --- | --- | --- |
| `MATRIX_FREE_TIER_ENABLED` | platform free tier | capability; runtime switch moved to `free-tier-enabled` (this PR) |
| `MATRIX_FREE_TIER_SLEEP_ENABLED` | platform metal sleeper | capability; runtime switch moved to `free-tier-sleep` (this PR) |
| `MATRIX_FREE_TIER_INVITE_REQUIRED` | platform free tier | default when unconfigured; runtime switch moved to `free-tier-invite-required` (this PR) |
| `MATRIX_PREBILLING_PROVISIONING_ENABLED`, `MATRIX_PREBILLING_PROVISIONING_ROLLOUT_PERCENT` | platform | migrate (`_MAX_ACTIVE` stays config) |
| `GOLDEN_SNAPSHOTS_ENABLED`, `GOLDEN_SNAPSHOT_ROLLOUT_PERCENT` | platform customer VPS | migrate |
| `MATRIX_CARD_TRIALS_ENABLED` | platform billing | migrate (trial day counts stay config) |
| `MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED` | platform AI credit checkout | migrate |
| `AI_FUNDED_PROMOTIONAL_GRANT_ENABLED` | platform funded AI | migrate |
| `MATRIX_FUNDED_AI_RUNTIME_ENABLED` | platform funded AI | migrate |
| `MATRIX_PAGE_EMAIL_INVITATIONS_ENABLED` | platform Sites | migrate (edge/satellite verification stays env) |
| `ACCOUNT_DELETION_ENABLED` | platform account deletion | migrate (`ACCOUNT_DELETION_CONFIGURED` stays capability) |
| `PLATFORM_SPEECH_OWNER_AUDIO_ENABLED` | platform speech | migrate |
| `MATRIX_PLATFORM_SPEECH_RUNTIME_ENABLED` | platform customer VPS config | migrate |
| `MATRIX_GET_STARTED_ENABLED` | platform, forwarded to VPS host env | migrate (client flag) |
| `MATRIX_COLLABORATION_DISABLED` | gateway, platform host config | migrate (kill switch) |
| `MATRIX_SUPERVISED_BROWSER_APPROVALS_ENABLED` | gateway, platform | migrate (needs a gateway-side flag client) |
| `MATRIX_DESKTOP_PAIRING_ENABLED` | gateway | migrate (needs a gateway-side flag client) |
| `CUSTOMER_VPS_ENABLED` | platform | capability |
| `METAL_HOSTS_ENABLED` | platform | capability |
| `MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED` | platform | capability |
| `MATRIX_STRIPE_BILLING_ENABLED` | platform entitlements | capability |
| `CUSTOM_MCP_ENABLED` | platform | capability (encryption key secret) |
| `MATRIX_MCP_ENABLED` | platform | capability (OAuth issuer config) |
| `MATRIX_PUBLIC_SITES_ENABLED` | platform | capability (dedicated edge and storage secrets) |
| `MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED` | platform | capability (relay secrets) |
| `MATRIX_FUNDED_AI_ENABLED` | platform host config, VPS | capability |
| `MATRIX_FUNDED_HOST_CONFIG_ENABLED` | platform | capability (pinned machine ids) |
| `MATRIX_FUNDED_AI_PRICING_REGISTRY_ENABLED` | platform | capability |
| `PLATFORM_SPEECH_ENABLED` | platform speech | capability (provider secrets) |
| `MATRIX_PLATFORM_SPEECH_ENABLED` | platform host config, gateway | capability |
| `MATRIX_PREVIEW_PAIR_ENABLED` | platform preview pairs | capability |
| `MATRIX_PREVIEW_RUNTIME_ACCESS_ENABLED` | platform previews | capability |
| `GOLDEN_SNAPSHOT_BUILDS_ENABLED` | platform | capability (build infrastructure) |
| `TERMINAL_USER_SYSTEMD_ENABLED` | gateway | capability (host support) |
| `PLATFORM_BACKGROUND_WORKERS_ENABLED` | platform | config (process role) |
| `MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED` | platform | config (worker placement) |
| `MATRIX_FUNDED_AI_PRICING_REVIEW_JOB_ENABLED` | platform | config (job placement) |
| `TERMINAL_DEBUG_ENABLED` | gateway | config (debug) |
| `POSTHOG_DISABLE_REPLAY`, `NEXT_PUBLIC_POSTHOG_DISABLE_REPLAY` | shell | config (kill switch for PostHog itself; must not depend on PostHog) |
| `GH_PROMPT_DISABLED` | gateway | config (third-party tool env) |
| `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER` | gateway | config (third-party tool env) |
| `CLAUDE_CODE_DISABLE_CRON`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | gateway | config (third-party tool env) |
| `HERMES_DISABLE_TELEMETRY`, `HERMES_DISABLE_LAZY_INSTALLS` | gateway | config (third-party tool env) |
