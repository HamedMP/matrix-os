# Quickstart: Attached Terminal Rich Paste

## 1. Start With Failing Tests

From the repository root:

```bash
pnpm --filter @finnaai/matrix test -- tests/unit/rich-paste.test.ts tests/unit/shell-client.test.ts
bun run test tests/gateway/shell-routes.test.ts
```

Expected initial failures before implementation:

- Embedded quoted image path inside prompt is not detected and rewritten.
- Multiple image paths in one paste are not deduped and uploaded as one transaction.
- Upload failure still allows local-only paths to reach the remote session.
- Pure image clipboard paste has no observable best-effort handling.
- Gateway has no terminal paste asset route.

## 2. Implement Gateway Contract First

Add route and helper tests for:

- Authenticated `POST /api/terminal/sessions/:name/paste-assets`.
- Body limit before parsing.
- Session-name validation.
- Image count and size limits.
- Server-generated owner-scoped paths.
- Atomic writes and generic error responses.
- Symlink-safe cleanup behavior.

## 3. Implement Local Parser/Rewriter

Add sync-client tests for:

- Quoted macOS screenshot paths with spaces and surrounding text.
- Unquoted image paths with trailing punctuation.
- Multiple and repeated image references.
- Non-image path passthrough.
- Missing, unreadable, unsupported, and oversized local files.
- No forwarding of detected local image paths on failure.

## 4. Integrate With Attach Loop

Extend the attach loop so rich paste processing happens before `{ type: "input", data }` frames are sent. Preserve:

- Detach sequence behavior.
- Ctrl-C behavior before and after attach.
- Reconnect behavior.
- Existing terminal input filtering.
- Ordinary non-image paste behavior.

## 5. Manual Validation

1. Start a local Matrix gateway and shell session.
2. Attach from macOS with `mos shell attach main`.
3. Paste a prompt like:

   ```text
   "/var/folders/.../Screenshot 2026-07-08 at 10.31.00.png" what about this?
   ```

4. Verify the remote terminal receives a prompt with a `/home/matrix/home/projects/.matrix-terminal-pastes/...` path and the original question text.
5. Copy an image to the macOS clipboard and paste during attach.
6. Verify best-effort upload succeeds when the terminal emits an observable paste transaction, or local feedback explains that the paste event was not observable.

## 6. Documentation

Update public CLI/terminal docs under `www/content/docs/` to explain:

- Pasting screenshots while attached.
- Supported image path and clipboard behavior.
- Size limits and safe failure behavior.
- The limitation when a terminal sends no paste bytes or paste boundary.

## US1 Validation

Validated the screenshot-path MVP after implementation:

```bash
cd packages/sync-client
vitest run tests/unit/rich-paste.test.ts tests/unit/shell-client.test.ts

cd ../..
vitest run tests/gateway/shell-routes.test.ts
```

Results:

- Sync-client rich paste/parser and attach-loop tests: 12 passed.
- Gateway shell route tests, including terminal paste asset upload: 25 passed.

## US2 Validation

Validated observable paste and macOS clipboard image support after implementation:

```bash
cd packages/sync-client
vitest run tests/unit/clipboard-image.test.ts tests/unit/shell-client.test.ts tests/unit/rich-paste.test.ts
```

Results:

- Clipboard image reader, rich paste parser, and attach-loop bracketed paste tests: 19 passed.

## US3 Validation

Validated failure-safe handling and cleanup after implementation:

```bash
cd packages/sync-client
vitest run tests/unit/rich-paste.test.ts tests/unit/clipboard-image.test.ts tests/unit/shell-client.test.ts

cd ../..
vitest run tests/gateway/shell-routes.test.ts
```

Results:

- Sync-client rich paste, clipboard, and attach-loop tests: 26 passed.
- Gateway shell route tests, including limits, generic errors, and cleanup sweep: 28 passed.
