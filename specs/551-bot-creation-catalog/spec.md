# Unified Bot creation chooser

Ticket: [ENG-239](https://linear.app/matrix-os/issue/ENG-239/fixbots-unify-scratch-and-preset-creation-entry)

## Goal and surfaces

Match the supplied design: Start from scratch appears with existing preset Bots in one chooser. Shared presentation applies to Electron Desktop, Web Desktop and Web Canvas. Electron Desktop on the real main computer, connected to the existing Main runtime, is the requested acceptance environment. No Preview VPS is required for this frontend-only change.

## Journey

Clicking the sidebar Agents heading continues opening the existing Your AI team management page. Clicking the adjacent + opens the New agent chooser; never redirect the Agents heading to creation. The existing library New agent creation action also uses this chooser. The first card is Start from scratch, with a plus icon and Describe it in your own words. Selecting it opens the existing empty custom form; cancel/close returns to the chooser without a creation request. Preset selection keeps its existing setup flow.

Keep scratch visible while browsing/filtering, excluding it from preset counts. Preserve the no-matching-recipes message. Featured presentation has scratch plus up to five presets, maintaining the reference six-card grid. Show all exposes matching presets alongside scratch. Reuse responsive columns and light/dark theme tokens.

## Invariants

Reuse existing model selection, readiness, custom creation API, request IDs, validation, permissions, pending guards, 100-Agent creation limit and error handling. Scratch has the current custom-entry availability and must not depend on recipe catalog success. Opening/canceling never creates a Bot or sends a Chat message. Preserve the originating Chat, draft, attachments, saved editing and navigation scope. Preserve keyboard activation, dialog focus, Escape and focus return.

No new endpoint, database contract, IPC, permission grant, backend behavior or migration. Existing owner authentication remains creation authority. Welcome-in-Chat, model-sidebar and Full-access redesign belong to ENG-209. Native Mobile is outside this alignment scope.

## Acceptance

- Both creation entries show scratch first beside presets.
- Clicking Agents still displays Your AI team; clicking the adjacent + displays New agent.
- Scratch opens the empty existing form; cancellation returns without mutation.
- Recipe setup, search/categories, featured/show-all and counts work.
- Loading/error/pending states preserve readiness and duplicate protection.
- Saved editing and originating Chat draft remain intact.
- Focused tests, relevant type checks, production Electron build and real main-computer Electron Desktop checks pass at the PR head. Attach screenshots and a short recording with exact client SHA/version and Main runtime provenance.

## Delivery and rollback

Publish one frontend implementation PR linked to ENG-239. Update public Bot-creation documentation in a separate FinnaAI/matrix-os-site PR. Stop at Human Review; Greptile and merge wait for user approval. Rollback is reverting the UI commit; owner data is unchanged.
