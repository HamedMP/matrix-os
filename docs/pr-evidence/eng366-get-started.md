# ENG-366 Get started: live evidence

GitHub stack #2849 ([#2846](https://github.com/HamedMP/matrix-os/pull/2846) → [#2885](https://github.com/HamedMP/matrix-os/pull/2885)), [ENG-366](https://linear.app/matrix-os/issue/ENG-366/guided-onboarding-get-started-wizard-and-personalized-first-run), [spec 635](../../specs/635-guided-onboarding/spec.md).

## Electron Desktop

- **Build:** Electron Desktop dev build of `668ee66f8` (top of the stack), signed in to the stack's Private Preview. The preview's server bundle is `a523d9e`; the changes after it are app-side only.
- **Recorded:** 23 October 2026, one full run from a fresh wizard to the first Chat.
- **Left out for privacy:** account sign-in windows (Google, GitHub, Pipedream), the API key entry and Chat results. The clip cuts those parts.

[Walkthrough recording, 74 s](eng366/electron-desktop-walkthrough.mp4)

| Step | Screenshot |
| --- | --- |
| Name pre-filled from the sign-in account | ![Name step](eng366/electron-01-name-prefilled.jpg) |
| Step 3: coding agents (Claude Code, Codex) and the integrations marketplace | ![Step 3](eng366/electron-02-step3-agents.jpg) |
| Claude Code installs on the card; Codex shows Connected · OpenAI API key | ![Agent install and connected](eng366/electron-03-agent-installing-and-connected.jpg) |
| A connected app shows a green Connected, no Add account | ![App connected](eng366/electron-04-app-connected.jpg) |
| Apps ready with your data, added apps show a green Added | ![App Gallery](eng366/electron-05-app-gallery-added.jpg) |
| Meet your bots, waiting for a bot's sign-in | ![Bots](eng366/electron-06-meet-your-bots.jpg) |
| Summary | ![All set](eng366/electron-07-all-set.jpg) |
| Arrival: the picked first app builds right away ("Build: Habit tracker") | ![Arrival](eng366/electron-08-arrival-auto-build.jpg) |
| Getting started follows the answers, with Try actions | ![Getting started](eng366/electron-09-getting-started.jpg) |
| Try opens Chat with the read-only prompt | ![Try](eng366/electron-10-try-opens-chat.jpg) |

## Web Desktop and Web Canvas

Pending: captured on the Private Preview once it runs the stack's latest bundle.
