# Task 4: Quickstart page — report

**Status: DONE**

## Page structure

1. Intro paragraph — sets linear scope (sign up → compute → billing → provision → shell → GitHub → clone).
2. Steps component with 8 steps:
   - Step 1: Create account at app.matrix-os.com, choose Matrix handle.
   - Step 2: Choose compute plan — includes a plan/spec table (Starter/Builder/Max, sourced from `www/src/lib/billing-plans.ts` values in spec 098). Notes Builder as default; mentions pricing-page preselect via a Callout.
   - Step 3: Complete billing — explains 3-day trial starts at checkout, notes payment-settling phase.
   - Step 4: Pick developer tools (Claude Code, Codex, OpenCode) — surfaced from `install_choices_required` journey phase.
   - Step 5: Wait for provisioning — four stages (creating server, booting, registering, finalizing), from `deriveProvisioningStage` in `packages/platform/src/journey.ts`. Includes a warn Callout about not closing the tab.
   - Step 6: Land in the web shell — directs to Terminal first.
   - Step 7: Authenticate GitHub — `gh auth login --hostname github.com --web`, Matrix-managed SSH key.
   - Step 8: Clone a repo.
3. Next-steps Cards linking `/docs/cli` and `/docs/shell`.
4. "Let your coding agent drive setup" section — the agent prompt from the current quickstart, preserved and trimmed.

## Sources used

- `/www/content/docs/quickstart.mdx` — existing agent-prompt text preserved verbatim in the agent section.
- `/www/content/docs/cli.mdx` — tone reference; confirmed CLI install commands (`brew install finnaai/tap/matrix`, `npm install -g @finnaai/matrix`).
- `/specs/098-onboarding-billing-preselect/design.md` — canonical plan table (Starter $14/CPX22/2vCPU/4GB/80GB, Builder $19/CPX32/4vCPU/8GB/160GB, Max $49/CPX52/12vCPU/24GB/480GB), plan preselect flow, 3-day trial note.
- `/specs/098-onboarding-billing-preselect/plan.md` — confirmed plan slugs, preselect via `publicMetadata.selectedPlan`.
- `/packages/platform/src/journey.ts` — journey phases, provisioning stages, install-choices step.

## Factual uncertainties for the maintainer

1. **Developer-tools picker step**: The journey has an `install_choices_required` phase before provisioning, but the exact UI label and the list of tools shown to the user (Claude Code, Codex, OpenCode, Pi, etc.) are inferred from `docs/dev` references and the platform code — not confirmed from a screenshot. Verify the step label and tool list against the actual onboarding screen.

2. **Provisioning time estimate**: "Two to four minutes" is a reasonable guess based on VPS boot times; no code source confirms this. Replace with the measured p50 if known.

3. **SSH key step in `gh auth login`**: The page says "when asked whether to add an SSH key, let Matrix generate a Matrix-managed key." The exact CLI prompt wording from `gh` and whether the Matrix terminal surface intercepts/automates this is not confirmed. Verify the exact user interaction.

4. **Plan pricing**: Values (Starter $14, Builder $19, Max $49 monthly) come from `specs/098-onboarding-billing-preselect/design.md` and the `LANDING_PLANS` constant — but the spec is dated 2026-06-28 (current branch). Confirm they match live Stripe prices before publishing.
