# Settings

Settings is a full-screen overlay with a sections sidebar. It holds provider setup, appearance, billing, and system info for the owner's Matrix computer.

## Sub-features

- `settings-open` opens the overlay from the Desktop icon.
- `settings-sections` switches sections from `navigation "Settings sections"`.
- `settings-appearance` changes a visual preference and keeps it after reload.
- `settings-close` returns to the Desktop.

## How to get to it (user POV)

- Double-click `Settings` in `navigation "Desktop apps"`.
- App Launcher > `Settings`.

## Driving it with matrix-verify

Preconditions:

- Baseline from `README.md`.

- **Open.** Double-click `Settings`. `heading "Settings"` (level 1) and `navigation "Settings sections"` appear. Sections observed locally: `Agents & providers`, `Connect Apps`, `Messaging`, `AI usage`, `Import chats`, `Appearance`, `Organization`, `Identity & personality`, `Billing`, `System`.
- **Switch section.** Click `button "Appearance"` in `navigation "Settings sections"`. `main` shows `heading "Appearance"` (level 2).
- **Appearance change.** Change one preference, reload, reopen Settings > Appearance, and confirm it stuck. Side effect: `home("system/theme.json")` or the related file under `system/` changes. Record the exact control name in this file after the first run.
- **Close.** Click `button "Close settings"`. The Desktop icons are clickable again.

## Gotchas

- Locally Settings opens on `Billing` (no VPS provisioned) showing plan cards and `Start 14-day trial`. Never click checkout buttons.
- The overlay intercepts pointer events for the whole Desktop. Close it before driving other apps.
- `Agents & providers` and `AI usage` show unavailable states without Matrix AI and platform; do not treat those as regressions locally.
