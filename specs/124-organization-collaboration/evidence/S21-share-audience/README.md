# S21 evidence: share audience (member grants, access before sharing, member names)

These captures show the real `@matrix-os/ui` collaboration components rendered by the shell's Next.js
dev server, with the shell's global styles, on 2026-10-03. They were rendered from a temporary,
uncommitted page (`shell/src/app/capture-collaboration/page.tsx`) that gives the components a fixed
in-memory `CollaborationApi`. A live run needs an enrolled Matrix computer, a Clerk organization
with several members, and a second signed-in account, and was not available. These images are
therefore component renders on the real shell, not a live two-account journey.

| File | PR | What it shows |
| --- | --- | --- |
| `web-shared-with-you-pending.png` | #2144 | Shared with me with two unopened pending grants (one addressed to this member, one organization-wide), both labelled "Shared with you" |
| `web-mobile-shared-with-you-pending.png` | #2144 | The same at a 390×844 phone viewport |
