# Desktop OTA Update Entry Placement

**Linear:** MAT-291  
**Status:** Approved for implementation  
**Scope:** Renderer-only placement refinement for the existing Desktop OTA flow

## Problem

The ready-to-install update action currently shares the account row with the avatar, identity text, sidebar toggle, and sign-out action. At the expanded sidebar width, the extra circular action compresses the identity area and makes the footer feel crowded. The account row should remain stable regardless of update availability.

## Goals

- Keep the ready-to-install update action discoverable in the familiar lower-left utility area.
- Restore the full account row width and prevent update state from shifting account controls.
- Preserve the existing one-click behavior: selecting Update immediately restarts and installs the downloaded release.
- Preserve a useful update entry when the sidebar is collapsed.
- Avoid adding persistent chrome when no update is ready.

## Approved Design

When the update snapshot is `ready`, render the update action as its own footer row between Settings and the account row.

Expanded footer order:

1. Runtime computer selector
2. Settings
3. Update action, only while an update is ready
4. Account row

The expanded action is a compact blue row with a download icon, the label `Update`, and the target version aligned to the trailing edge. The button uses the same footer width and corner radius as the surrounding utility rows, while its blue treatment communicates that it is a temporary primary action.

In the collapsed sidebar, the same footer position renders as a centered blue icon button. Its accessible name and tooltip include the target version.

## Interaction and State

- `disabled`, `idle`, `checking`, `available`, `downloading`, and `error` states render no update action.
- `ready` with a valid target version renders the action.
- Selecting the action calls the existing install operation immediately; no confirmation dialog is added.
- While installation is starting, the action is disabled and shows the existing spinner treatment.
- The OTA download, IPC contract, persistence, restart/install behavior, and post-update What's New flow do not change.

## Accessibility

- The expanded and collapsed controls use the accessible label `Update Matrix OS to {version}`.
- The collapsed control exposes the same text as a tooltip.
- Disabled installation state remains perceivable through the spinner and disabled semantics.
- Keyboard activation follows native button behavior.

## Responsive Behavior

- Expanded mode uses the complete row with label and version.
- Collapsed mode uses a fixed-size icon button centered in the footer.
- The account row does not change width or composition when the update action appears or disappears.

## Testing

- Add a failing renderer test proving the ready action is rendered after Settings and before the account row.
- Prove the update action is absent outside the `ready` state.
- Prove expanded mode shows the label and target version.
- Prove collapsed mode keeps the accessible label while omitting visible text.
- Preserve existing tests for immediate installation and installing-state feedback.
- Run the focused update and sidebar suites, the complete Desktop suite, typecheck, production Desktop build, and the existing Desktop update-experience E2E test.
- Manually inspect expanded and collapsed layouts in the packaged-style Desktop preview.

## Non-goals

- Moving update controls into Settings.
- Adding a confirmation dialog or deferring installation after a click.
- Changing the update feed, release channels, download behavior, or changelog schema.
- Adding update progress to the sidebar before the release is ready.
- Refactoring unrelated sidebar navigation or account behavior.

## Documentation

The existing public documentation PR for MAT-291 already describes background download, one-click restart/install, and post-update What's New. This placement-only refinement does not change that public behavior, so no additional public documentation text is required.
