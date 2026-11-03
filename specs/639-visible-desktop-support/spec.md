# Visible Support in OS views

## Goal

Make the existing customer Support chat easy to find in the signed-in Web and Electron OS views, and give users a contact path when chat cannot open.

## Journey and scope

- Web Desktop, Web Canvas, and Electron Desktop show a labeled, keyboard-accessible Support button beside Help.
- Activating it opens the existing PostHog Conversations panel through the current client configuration and platform relay. Closing and reopening remain supported.
- Help keeps its Support chat entry. PostHog's default floating launcher stays suppressed so it does not cover desktop content.
- If chat configuration or the widget is unavailable, the action shows a bounded message with the support email address instead of silently doing nothing.
- Web Mobile and Native Mobile are unchanged.

## Acceptance

- Signed-in Web Desktop, Web Canvas, and packaged Electron builds visibly expose the button and open the panel from it.
- The panel can close and reopen without leaving a floating launcher.
- If Support initialization is unavailable, the action gives the support email without navigating away or exposing internal details.
- Focused tests prove the visible entry, fallback and open, close, reopen journey. Capture screenshots and short recordings from the live Web Desktop, Web Canvas, and Electron builds before review readiness.

## Risks and follow-up

This change improves access to the panel. Actual message delivery is tracked separately in [ENG-356](https://linear.app/matrix-os/issue/ENG-356/fix-posthog-support-message-sending-in-electron-desktop). Product and design review of the top-bar placement is recommended. A separate public documentation update in `FinnaAI/matrix-os-site` should explain where Support is found.
