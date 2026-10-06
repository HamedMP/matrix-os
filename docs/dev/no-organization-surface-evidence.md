# No-organization surface evidence

This evidence accompanies the organization-membership UI change. It uses an authoritative complete empty membership listing and focuses on the controls changed by the feature instead of unrelated Files views.

| Surface and state | Evidence | What it demonstrates |
| --- | --- | --- |
| Electron Desktop — Chat Add menu | [`electron-desktop-chat-context.png`](../pr-evidence/no-organization-surfaces/electron-desktop-chat-context.png) | Personal project, folder, file, and attachment context remains available; company-drive context is absent. **Shared with me** is also absent from the Chat rail. |
| Electron Desktop — Chat Share | [`electron-desktop-chat-snapshot.png`](../pr-evidence/no-organization-surfaces/electron-desktop-chat-snapshot.png) | **Share** opens the snapshot dialog directly. The organization collaboration choice is absent, while snapshot sharing remains. |
| Electron Desktop — Terminal | [`electron-desktop-terminal.png`](../pr-evidence/no-organization-surfaces/electron-desktop-terminal.png) | The active Terminal header has no organization sharing action. |
| Web Desktop — Chat context | [`web-desktop-chat-context.png`](../pr-evidence/no-organization-surfaces/web-desktop-chat-context.png) | Typing `@` does not expose company-drive context, and **Shared with me** is absent. |
| Web Desktop — Terminal | [`web-desktop-terminal.png`](../pr-evidence/no-organization-surfaces/web-desktop-terminal.png) | The active Terminal has no organization sharing action. |
| Web Mobile — Chat context | [`web-mobile-chat-context.png`](../pr-evidence/no-organization-surfaces/web-mobile-chat-context.png) | The compact Chat composer matches the Web behavior and does not expose company-drive context. |

The screenshots represent the confirmed `none` state. Loading, failed, or incomplete membership discovery is deliberately not treated as proof that a person has no organizations. Organization sharing actions remain unavailable without a verified organization. Navigation behaves separately: **Shared with me** can remain clickable when its other requirements are met, while the Electron Desktop organization menu is hidden during loading. Chat snapshot sharing remains available because it does not require an organization. Web Canvas uses the same Chat and Terminal components as Web Desktop; the surface-parity tests in #2132 cover Web Canvas explicitly.
