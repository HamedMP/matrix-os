# Visible Support in Electron Desktop

## Goal

Make the existing customer Support chat easy to find in the signed-in Electron Desktop app.

## Journey and scope

- Electron Desktop shows a labeled, keyboard-accessible Support button in the title bar beside Help.
- Activating it opens the existing PostHog Conversations panel through the current authenticated identity and platform relay. Closing and reopening remain supported.
- Help keeps its Support chat entry. PostHog's default floating launcher stays suppressed so it does not cover desktop content.
- Web Canvas, Web Desktop, Web Mobile, and Native Mobile are unchanged. The Electron title bar is the affected surface.

## Acceptance

- A signed-in packaged Electron build with Support configured visibly exposes the button and opens the panel from it.
- The panel can close and reopen without leaving a floating launcher.
- If Support initialization is unavailable, the existing failure behavior remains; the button must not navigate away or expose internal details.
- Focused tests prove the title-bar entry and open, close, reopen journey. Capture a screenshot and short recording from the live Electron build before review readiness.

## Risks and follow-up

This change improves access to the panel. Actual message delivery is tracked separately in [ENG-356](https://linear.app/matrix-os/issue/ENG-356/fix-posthog-support-message-sending-in-electron-desktop). Product and design review of the title-bar placement is recommended. A separate public documentation update in `FinnaAI/matrix-os-site` should explain where Desktop Support is found.
