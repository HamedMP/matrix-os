# Task 3 Report — About page (index.mdx)

## Page structure (one line)

Hero banner → positioning paragraph → "A computer, not a dashboard" callout → DocsCloudComputer visual → 4-step "How it works" Steps block → 4-card "Where to go next" Cards block → 4-paragraph "What Matrix is" prose section.

## Factual claims I am NOT certain about

1. **Zellij is the session backend on the hosted runtime.** This is stated in CLAUDE.md and the CLI docs, but I did not verify against the production VPS distro scripts. If the hosted runtime uses a different multiplexer, the "backed by zellij" line is wrong.
2. **Detach keybinding `Ctrl-\ Ctrl-\`.** Taken from the existing CLI page. Correct for the default Matrix zellij config, but depends on the shipped keybinding not being remapped.
3. **Pi is a currently installable coding agent on Matrix computers.** Pi appears alongside Claude, Codex, and OpenCode in existing docs and `developer-tools.ts`. I did not verify whether it ships as a working install in the current `matrix-install-tool-pack` script or if it is planned/partial.
4. **"Takes a few minutes" for provisioning.** Taken from general knowledge of VPS provisioning; no observed SLA from the codebase. Maintainer should correct or remove if provisioning time varies significantly.

## Positioning assumptions

- The page leads with "cloud coding computer for developers who run AI coding agents" as the primary framing, per spec 100 §Positioning. The sub-text ("sessions keep running after your laptop closes") is the single most concrete differentiator — foregrounded in both the hero and the "What Matrix is" section.
- The "For Users / For Contributors" split-card from the old index was removed per spec 100 §Structural changes (the dropdown now handles section switching).
- DocsCloudComputer visual is kept because the spec says it is optional and it is a meaningful diagram — maintainer can remove the import/component if the visual is stale.
- The four Cards in "Where to go next" match the four links called out in the task brief (Quickstart, CLI, Coding Agents, Hermes). The old "Contributor Platform" card was dropped from this page — it belongs in the Developers section.
