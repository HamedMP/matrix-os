# Data Model: Attached Terminal Rich Paste

## PasteTransaction

Represents one observed paste action during an attached CLI terminal session.

**Fields**:

- `transactionId`: Local unique identifier for logging and request correlation.
- `sessionName`: Target terminal session name.
- `rawText`: Text bytes received from stdin for the paste transaction, if any.
- `detectedCandidates`: Ordered list of local image candidates found in text.
- `clipboardCandidate`: Optional image candidate read from the local clipboard.
- `assetCount`: Number of unique image assets selected for upload.
- `state`: `collecting`, `validating`, `uploading`, `rewriting`, `forwarded`, or `failed`.
- `failureCode`: Safe local failure code when the transaction fails.

**Validation rules**:

- `sessionName` must match the existing safe terminal session name rules.
- `assetCount` must not exceed 5.
- A transaction with no image candidates must pass through as ordinary terminal input.
- A failed transaction must not forward detected local image paths.

## LocalImageCandidate

Represents a local image file path detected inside pasted text.

**Fields**:

- `sourceTextRange`: Start and end offsets in the pasted text.
- `displayText`: The exact text segment to replace, including quotes when present.
- `localPath`: Resolved local absolute path.
- `dedupeKey`: Stable key for avoiding repeated uploads within the same transaction.
- `sizeBytes`: Local file size.
- `mimeType`: Detected image type.

**Validation rules**:

- Must resolve to a regular local file.
- Must not be a directory, socket, FIFO, or symlink target outside the local path resolution policy.
- Must have an allowed image type.
- Must fit within the per-image size limit.

## ClipboardImageCandidate

Represents image bytes read from the local operating system clipboard during an observable paste transaction.

**Fields**:

- `capturedAt`: Local timestamp.
- `sizeBytes`: Clipboard image size.
- `mimeType`: Detected image type.
- `bytes`: Image payload held only long enough to upload.

**Validation rules**:

- Must only be read during a user paste transaction.
- Must not be used when text path rewriting already handled the current paste in a way that would duplicate the same user intent.
- Must fit within the per-image size limit.

## RemotePasteAsset

Represents a copied image inside the user's Matrix environment.

**Fields**:

- `assetId`: Server-generated unique identifier.
- `sessionName`: Terminal session associated with the paste transaction.
- `homeRelativePath`: Owner-home-relative path to the stored image.
- `absolutePath`: VPS-local absolute path suitable for terminal prompts.
- `mimeType`: Stored image MIME type.
- `sizeBytes`: Stored image size.
- `createdAt`: Server timestamp.

**Validation rules**:

- Filename is generated server-side and must not include local path fragments.
- Path must stay under `projects/.matrix-terminal-pastes/`.
- Writes must be atomic and exclusive.
- Assets are owned by the authenticated Matrix user.

## RewriteResult

Represents the final local outcome of a paste transaction.

**Fields**:

- `status`: `passthrough`, `rewritten`, or `failed`.
- `outgoingText`: Text to send over the terminal WebSocket when successful.
- `assets`: Uploaded remote assets referenced by `outgoingText`.
- `localMessage`: Safe local feedback shown to the user when failed.

**State transitions**:

```text
collecting -> validating -> passthrough
collecting -> validating -> uploading -> rewriting -> forwarded
collecting -> validating -> failed
collecting -> validating -> uploading -> failed
```

## PasteAssetCleanupPolicy

Represents retention limits for remote paste assets.

**Fields**:

- `maxAgeMs`: Maximum asset age before pruning.
- `maxAssetsPerSession`: Maximum retained asset files per session before oldest files are pruned.
- `lastSweepAt`: Last cleanup timestamp.

**Validation rules**:

- Cleanup must use `lstat()` and skip symlinks.
- Cleanup must only operate under the paste asset directory.
- Cleanup must run at startup or first use and recur while the gateway is alive.
- Shutdown must clear cleanup timers.
