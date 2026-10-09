# Figma-aligned project sharing evidence

Captured from the implementation worktree at merge head `e016cb22c` on Linux with synthetic, schema-valid collaboration fixtures. No customer accounts, messages, identifiers, or credentials were used.

## Captures

### First project share — Web Desktop presentation

`01-first-share-web-desktop.png` mounts the production `ProjectSharingButton` and opens its real `ProjectSharingDialog`. It shows the first-open baseline: the selected organization name (**Aperture Research**), **Everyone · Editor**, immutable owner, concise whole-project warning, revision-bound complete inventory, project Chat roots/Git status, and an external reference that stays private.

### Published access manager

`02-published-access-manager.png` mounts the published state of the same production dialog. It shows immutable **Owner**, organization-wide **Editor** access, active inherited Editors, a direct pending Viewer grant, and revocation controls. Chromium computed a real `20px` flex gap between the warning header and **People with access** (`header bottom = 419px`, section top = `439px`); the close appearance in a reduced preview is not an overlap.

### Shared Chat — Editor

`03-shared-chat-editor.png` mounts the current production `SharedChatPanel` with an inherited project Chat scope and an available owner runtime. It shows named human prompts on the right, assistant and tool output on the left, **Project access**, and the enabled Editor AI composer. The synthetic conversation is shared group-history evidence, not a product mockup.

## Capture commands and URLs

The two dialog states and the shared Chat were rendered from a temporary Vite evidence harness that imported the production components directly and reused the same typed state shapes covered by `tests/ui/project-sharing-figma-dialog.test.tsx` and `shell/e2e/shared-chat.spec.ts`. The temporary harness was removed after capture.

```bash
pnpm exec vite --config docs/pr-evidence/project-sharing-figma/_capture/vite.config.ts \
  docs/pr-evidence/project-sharing-figma/_capture --host 127.0.0.1 --port 4187

# Chromium viewport 1440×1200
http://127.0.0.1:4187/?state=initial
http://127.0.0.1:4187/?state=published

# Chromium viewport 1440×980
http://127.0.0.1:4187/?state=chat
```

The first state was opened through the real **Share project** button before capture. Each PNG was inspected at original resolution after Playwright wrote it.

## Limitation

The existing full Web Desktop shell journey was attempted first:

```bash
PLAYWRIGHT_DEV_SERVER=1 pnpm --dir shell exec playwright test shared-chat.spec.ts \
  --grep "shared Chat stays an ordinary Chat"
```

Its first two runs exceeded the 60-second test timeout while Next.js cold-compiled the shared-Chat route. After compilation, the warmed run reached the shell but could not open the shared Chat because the local keyless Clerk script timed out. The final Chat image therefore uses the allowed production-component harness fallback, not an authenticated full-shell or Electron capture. Product/source files were not changed for these captures.
