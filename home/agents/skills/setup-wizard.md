---
name: setup-wizard
description: Re-run onboarding to reconfigure your OS for a new role or fresh start
triggers:
  - reconfigure
  - re-onboard
  - setup wizard
  - start fresh
  - change role
  - new career
---

# Setup Wizard

When the user wants to reconfigure their OS:

1. Ask what changed -- new career? New interests? Want a fresh start?
2. Ask their new role and 2-3 follow-up questions (same as initial onboarding)
3. Use `get_persona_suggestions` to get defaults for the new role
4. Propose changes clearly:
   - **New apps** to build
   - **Existing apps** that stay (with their data intact)
   - **Skills** to add or update
   - **Personality** changes
5. On confirmation:
   - Update `~/system/user.md` with new role and preferences
   - Update `~/system/identity.md` if name/vibe changed
   - Update `~/system/soul.md` with new personality traits
   - Write new `~/system/setup-plan.json` via the `write_setup_plan` tool
   - The provisioner builds new apps automatically
6. Existing apps and data are preserved unless the user explicitly asks to remove them

Triggers:
- "Reconfigure my OS"
- "I changed careers"
- "Start fresh"
- "Set me up as a [new role]"
- "I want different apps"
- "Redo my setup"
