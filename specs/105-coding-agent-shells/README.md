# 105 - Coding Agent Shells

**Status**: Implementation checkpoint
**Created**: 2026-07-06
**Branch**: `chore/mobile-expo-sdk-57`
**Scope**: Desktop and mobile shell upgrade for multi-agent coding work on the user's Matrix computer.

## Documents

- [SPEC.md](./SPEC.md) - Product requirements, user stories, security model, success criteria, and non-goals.
- [plan.md](./plan.md) - Rollout strategy, sequencing, PR slices, risks, and decision gates.
- [ARCHITECTURE.md](./ARCHITECTURE.md) - System architecture, contracts, runtime model, client patterns, state rules, and implementation guidance.
- [tasks.md](./tasks.md) - Phase-by-phase implementation checklist for coding agents.
- [current-state.md](./current-state.md) - Current route, contract, client, shell, and test inventory.
- [completion-audit.md](./completion-audit.md) - Evidence-based completion audit for the landed implementation checkpoint.

## Intent

Matrix OS already has the pieces of a developer operating environment: per-user VPS runtime, terminal sessions, sync client, desktop shell, mobile shell, app runtime, file access, channels, and an AI kernel. This spec turns those pieces into a cohesive coding-agent cockpit across desktop and mobile.

The work must preserve all current mobile and desktop functionality. The upgrade adds first-class coding-agent workflows:

- Manage multiple coding agents and agent threads.
- Connect desktop and mobile shells to the same remote Matrix computer.
- Create, attach, resume, and terminate named remote terminal sessions.
- Open projects, files, diffs, previews, apps, and task workspaces from either shell.
- Keep mobile and desktop as thin interfaces over the same headless runtime.
- Use typed, validated contracts across gateway, desktop trusted core, renderer, mobile, and shell clients.

## Implementation Rule

Do not fork core behavior into desktop-only or mobile-only implementations. Core runtime state belongs on the Matrix computer behind the gateway. Desktop and mobile may cache bounded UI state, but they must never become sources of truth for projects, threads, terminal sessions, files, diffs, app state, credentials, or agent history.
