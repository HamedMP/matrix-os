# Spec 636: Get started, coding agents screen

Status: Draft for review.
Ticket: [ENG-391](https://linear.app/matrix-os/issue/ENG-391/polish-the-get-started-wizard).
Builds on: [Spec 635](../635-guided-onboarding/spec.md) (Get started wizard, ENG-366).
Feedback: [#tech thread](https://matrixos.slack.com/archives/C0C459830FJ/p1792775608591359?thread_ts=1792676322.691099&cid=C0C459830FJ).
Reviewers suggested: product (onboarding), Yuhan (Agents & providers), Nima.

## Goal

Signing in to Claude Code or Codex gets its own Get started screen, before "Connect the tools you use". It looks like Settings › Agents & providers › Coding agents and says how much Matrix AI credit the owner already has, so it is clear the step is optional.

Why: today the agent sign-in sits on step 3 under "Your coding agent" chips, mixed with the integrations list. It looks unlike Settings, only appears for "Write code with agents", and never says that Matrix already works with the owner's credit.

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

## Out of scope (rest of ENG-391)

AI-suggested bot names with a refresh button; not calling apps "ready with your data" before an import finishes. Separate PRs on the same ticket.

## Risks

- **Two screens of setup instead of one.** Mitigated: the screen is one click to skip and says Matrix already works.
- **Credit copy vs plan.** The amount is the current balance, which for a new account is the starter credit. If product wants the plan's included amount instead, that needs a new snapshot field.
