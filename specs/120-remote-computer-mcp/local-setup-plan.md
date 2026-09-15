---
status: completed
---
# Local CLI, MCP, and skills setup

## Requirements

- One Settings entry named “Matrix CLI & MCP”, retaining the existing `cli` deep link.
- Shared CLI, Streamable HTTP, and plugin-bundled skills setup in Electron Desktop, Web Desktop, and Web Canvas; web-mobile rendering remains usable for opening instructions on a local computer.
- Optional Getting started shortcut opens the page without changing completion counts or installing anything.
- Copy-only commands and HTTPS documentation links; no remote terminal launch, local execution, secrets, OAuth configuration, install detection, or false availability assertions.
- Keep Matrix consuming external MCP services separate from local clients connecting to Matrix.

## Implementation and validation

1. Add failing component, navigation, and checklist tests before implementation.
2. Share presentation and copy behavior through `@matrix-os/ui`; renderer adapters own navigation only.
3. Verify copy success/failure, navigation/deep links, unchanged checklist completion, responsive styling, package typechecks and builds.
4. Update the public docs in companion site PR #75, including the activation gate and local-computer distinction.

## Deferred scope

Production OAuth enablement and live-client tests remain governed by `docs/dev/hosted-mcp.md`. Official marketplace submissions and automatic installers are not part of this UI change. Native Mobile has no equivalent local-computer setup Settings surface in this change; users can open the public guide on their target computer.
