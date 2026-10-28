# Spec 636: Get started polish (coding agents screen, bot name suggestions, App Gallery copy)

Status: Draft for review.
Ticket: [ENG-391](https://linear.app/matrix-os/issue/ENG-391/polish-the-get-started-wizard).
Builds on: [Spec 635](../635-guided-onboarding/spec.md) (Get started wizard, ENG-366). This spec supersedes spec 635's step 3 coding agent chips and its App Gallery step copy.
Feedback: [#tech thread](https://matrixos.slack.com/archives/C0C459830FJ/p1792775608591359?thread_ts=1792676322.691099&cid=C0C459830FJ).
Reviewers suggested: product (onboarding), Yuhan (Agents & providers), Nima.

## Goal

Three polish items from the Get started review, shipped in one PR:

1. **Coding agents screen** (Part A). Signing in to Claude Code or Codex gets its own Get started screen, before "Connect the tools you use". It looks like Settings › Agents & providers › Coding agents and says how much Matrix AI credit the owner already has, so it is clear the step is optional.

2. **Bot name suggestions** (Part B). The "Name your main bot" step suggests five names with emojis from a small, fast model, with a refresh button for five more.

3. **Honest App Gallery copy** (Part C). The App Gallery step no longer says apps are "ready with your data": apps install empty and fill up only after the owner imports data inside them.

Why (A): today the agent sign-in sits on step 3 under "Your coding agent" chips, mixed with the integrations list. It looks unlike Settings, only appears for "Write code with agents", and never says that Matrix already works with the owner's credit.

## Affected surfaces

| Surface | Scope |
| -- | -- |
| Web Desktop | In scope |
| Web Canvas | In scope (same wizard) |
| Electron Desktop | In scope |
| Web Mobile | N/A: the wizard does not run on mobile (spec 635). Needs reviewer approval |
| Native Mobile | N/A: same rationale. Needs reviewer approval |

## Journey

Steps become: name → goals → **coding agents** → connect your tools → main bot → App Gallery → bots → summary.

**Coding agents screen** (every owner, whatever the goals):

- Title "Sign in to your coding agents". Hint: "Have a Claude or ChatGPT plan? Sign in to use it in Matrix. You can skip this and do it later in Settings."
- **Credit line**, when this computer reports current Matrix AI credit above zero: "You have $5.00 of Matrix AI credit, so Matrix works without signing in." The amount is the same spendable Chat credit Settings shows (`gatewayChatAvailableMicrousd`); stale, missing or zero credit hides the line instead of guessing.
- **"Coding agents" list** with Claude Code and Codex, always both, each the Settings row: logo, name, status chip, chevron. The status is the Settings derivation (Not installed, Installing, Install failed, Checking installation, Not connected, Connecting, Connected).
- Rows start collapsed. Clicking a row expands it (one at a time, click again to collapse):
  - Not connected: the same Settings install and sign-in panel the wizard uses today (`HarnessWorkflowPanel`, no Terminal options, installs run in the background with progress).
  - Connected: the Settings connection card (plan or account, email, usage; "API key, billed per request by …" for keys). Log out, Disconnect and Change account stay in Settings.
  - This computer cannot sign it in here, or the provider state failed to load: "You can log in to <agent> later in Settings > Agents & providers."
- Next and Skip both move on; nothing is required. Skip never signs anything out.

**Connect your tools** keeps the Settings integrations marketplace and the "Sounds fun" starters, and loses the "Your coding agent" chips.

**Answers:** a coding agent becomes a tool in the saved answers (`claude-code`, `codex`) when it is connected, the same way connected integrations already do, instead of when its chip was picked. Until the screen has read this computer's agents (for example after resuming at a later step), saved agent tools stand.

## Design

- **Shared row:** the Settings row moves out of `HarnessRail` into `AgentRow` (head button, status chip, chevron, `ProviderAccordion`). Settings and the wizard render the same component; Settings keeps its markup and behaviour.
- **Shared status:** the installed-but-unregistered status (`capabilityRowStatus`) moves next to `resolvedWorkflowRowStatus`, used by both.
- **One provider host per wizard:** the surface's agent host becomes a render-prop host (like the integrations connector) that builds one port from the surface's provider settings controller and workflow client. The coding agents screen reads capabilities once for both rows. Before, each picked agent mounted its own controller.
- **Contracts:** `GET_STARTED_WIZARD_STEPS` gains `agents` after `goals`; `GET_STARTED_STEP_COUNT` becomes 8. The wizard state gains `agents: GetStartedAgentKind[] | null` (connected agents, reported by the screen, never saved on their own) and an `agents-connected` event. The coding agent chip group is removed from `getStartedToolGroupsForGoals`.

## Security, data and failure modes

- No new endpoints, files or persistence. The screen reads the provider settings snapshot and workflow capabilities the surface already exposes to Settings, with the same auth, and writes nothing except through the existing workflow client.
- The saved draft keeps its schema; only the step index range grows to 0–7. A draft saved before this change at step index 2 or later resumes one step earlier (its answers are kept), never later.
- Provider state still loading: rows show "Checking installation" and the credit line stays hidden. Load failure or a computer with no workflow for an agent: the "later in Settings" line; the screen stays skippable.
- Read-only computers: the row content shows the Settings read-only notice and disables sign-in, as today.
- Switching computers mid-wizard: the hosts keep their identity checks, so a late result from another computer never opens a sign-in or refreshes Chat.
- Resources: one provider controller and one capability request per open screen, cancelled on unmount; status overrides keep the existing 32-entry cap.

## Acceptance checks

1. A new account sees the coding agents screen right after goals on Web Desktop, Web Canvas and Electron Desktop, whatever goals were picked.
2. With $5 of current Matrix AI credit the screen says "You have $5.00 of Matrix AI credit, …"; with no current credit there is no credit line.
3. Both rows match Settings › Coding agents (logo, name, status chip, chevron). Expanding Claude Code when not connected shows the Settings sign-in without Terminal; signing in turns the chip to Connected and shows the connection card.
4. Skip and Next move to "Connect the tools you use", which no longer shows coding agent chips.
5. Finishing with Codex connected saves `codex` in the answers' tools; finishing without a connected agent saves none.
6. Settings › Agents & providers looks and behaves as before.

Evidence: live screenshots and a short recording for Web Desktop, Web Canvas and Electron Desktop, in the PR and #tech.

## Deliverables

- Code and tests in this repository, in the ENG-391 PR.
- **Public docs:** a separate PR in `FinnaAI/matrix-os-site` under `content/docs/` updating the Get started guide from spec 635: the coding agents screen (optional sign-in, Matrix AI credit), suggested bot names with refresh, and the App Gallery step's wording (apps fill up after an import). Opened once this PR ships.

## Out of scope

Prefilling apps from connected data during onboarding: [ENG-369](https://linear.app/matrix-os/issue/ENG-369/onboarding-connect-gmailcalendar-and-auto-set-up-matrix-from-them), with its consent, privacy-copy, Google policy and OAuth-ownership questions noted there. Part C only makes the copy honest.

## Risks

- **Two screens of setup instead of one.** Mitigated: the screen is one click to skip and says Matrix already works.
- **Credit copy vs plan.** The amount is the current balance, which for a new account is the starter credit. If product wants the plan's included amount instead, that needs a new snapshot field.

---

# Part B: bot name suggestions

## Journey

On "Name your main bot", the fixed Matrix / Atlas / Nova / Ada / Sage chips become **Suggested names**: five chips such as "🌙 Luna", and a 🔄 "New names" button.

- Names fit the goals picked earlier and the personality chip currently selected. Refresh asks for five names not shown yet.
- While the first names load, five placeholder chips hold their place (no layout shift). Refresh keeps the current names until new ones arrive.
- Clicking a chip sets the bot's name, exactly like typing it; the emoji is decoration only and is not saved. "Or type a name" stays.
- If suggestions are unavailable (slow, failing, rate limited, or not deployed yet), the step shows names from a built-in list of names with emojis instead, and refresh pages through it. The owner never sees an error for this.

## Design

| Piece | What |
| -- | -- |
| Contracts | `GetStartedBotNamesRequest` `{ goals, personality, exclude }` and `GetStartedBotNamesResponse` `{ names: [{ name, emoji }] × 5 }`; the built-in fallback list and picker |
| Platform | `POST /internal/containers/:handle/get-started/bot-names`: calls Gemini (`gemini-3.5-flash-lite`, overridable with `MATRIX_GET_STARTED_NAMES_MODEL`) with the platform's existing `GEMINI_API_KEY` |
| Gateway | `POST /api/settings/get-started/bot-names`: forwards to the platform with the computer's machine bearer |
| UI | `GetStartedPort.suggestBotNames`, the suggestions row on the AI step, Web and Electron ports |

Matrix pays for the model call; the owner's credit is never used. No model key ever reaches a customer computer: the computer asks the platform, as Integrations and Speech do.

## Security architecture

| Route | Method | Auth | Public | Body limit | Validation |
| -- | -- | -- | -- | -- | -- |
| `/api/settings/get-started/bot-names` (gateway) | `POST` | Gateway global owner auth | No | 2 KiB | strict Zod request; only while the wizard is `pending` or `in_progress` |
| `/internal/containers/:handle/get-started/bot-names` (platform) | `POST` | Machine bearer: `buildPlatformVerificationToken(handle, platformSecret)`, constant-time compare; handle must be a known machine | No | 2 KiB | handle pattern; strict Zod request |

- **Input:** goals and personality are enums, mapped to fixed labels on the platform; the only free text is `exclude`, at most 30 names that must each be a suggestion-shaped name (letters, spaces, apostrophes and hyphens, at most 24 characters). Nothing else from the client reaches the prompt.
- **Output:** the model must return JSON; every name is validated with the same rule plus the bot name schema, emojis must be emoji only, duplicates and excluded names are dropped, and anything short of five valid names is a failure. Model text never reaches the client unvalidated.
- **Key handling:** the Gemini key is sent in the `x-goog-api-key` header, never in a URL; `redirect: "error"`.
- **Errors:** clients get generic messages only ("Name suggestions are unavailable"); provider status codes, bodies and messages are logged server-side without the prompt.
- **Wizard state:** the gateway route reads the Get started state through the pinned `system/` directory like the existing routes, and refuses once setup has finished (`409`) or when not eligible (`404`).

| Request | Result |
| -- | -- |
| Gateway: not eligible / flag off | `404` |
| Gateway: setup finished or skipped | `409` |
| Gateway: no platform URL, token or handle | `503` |
| Gateway: platform error, timeout or invalid response | `503` generic |
| Platform: bad or missing bearer | `401` |
| Platform: unknown machine | `404` |
| Platform: over the rate limit | `429` |
| Platform: no `GEMINI_API_KEY` | `503` |
| Platform: model timeout, error or invalid output | `502` generic |

## Failure modes and resources

- **Timeouts:** platform → Gemini 8 s; gateway → platform 10 s; the UI shows fallback names when the request fails or takes longer than 12 s, and ignores a late answer.
- **Rate limit:** 30 requests per hour per machine on the platform, in memory, at most 2,048 tracked machines, oldest evicted, expired windows swept on each request. A restart resets it, which is acceptable for a cost guard of this size.
- **Response bounds:** model and platform responses are read up to 32 KiB; larger is a failure.
- **Concurrency:** the UI aborts a pending request when a new one starts or the step unmounts; only the latest answer is shown.
- **Cost:** one Flash-Lite call per request (well under a cent), capped by the rate limit.

## Acceptance checks (Part B)

1. On a deployed platform, the AI step shows five suggested names with emojis that fit the goals and personality; 🔄 shows five different ones.
2. Clicking a suggestion sets the name; finishing saves it without the emoji.
3. With the platform route unreachable, the step shows five built-in names right away and refresh still works.
4. The gateway route refuses requests once setup is finished; the platform route refuses a wrong bearer.

## Rollout

The gateway and UI ship in the host bundle; the platform route needs a platform deploy. Until then, every surface shows the built-in names.

---

# Part C: honest App Gallery copy

The App Gallery step lists apps whose required services are connected (App Gallery's readiness rule). Adding one installs an empty app; data arrives only when the owner runs an import inside it. The old copy promised more than that.

| Where | Before | After |
| -- | -- | -- |
| Title (apps listed) | "Apps ready with your data" | "Apps that work with your tools" |
| Hint | "Because you connected Gmail and Google Calendar, these apps are ready with your data." | "These apps work with Gmail and Google Calendar. Add one, then import your data from inside it." |
| List label | "Apps ready with your data" | "Apps that work with your tools" |

No behavior change. Acceptance: with Gmail and Google Calendar connected, the step shows the new title and hint on Web Desktop, Web Canvas and Electron Desktop, and nothing on it says "ready with your data".
