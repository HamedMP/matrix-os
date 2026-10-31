# Contract: `matrix-app-bundle/1`

A bundle is a gzip-compressed UTF-8 JSON document. Only `kind: "source"` is a published artifact; installer output remains local. Matrix does not use tar here: JSON avoids tar's link, device and path-traversal entry types and is parsed with bounded schemas.

```jsonc
{
  "format": "matrix-app-bundle/1",
  "kind": "source",
  "files": [
    { "path": "src/App.tsx", "size": 1234, "sha256": "<hex>", "data": "<base64>" }
  ]
}
```

## Rules

- `files` is sorted by `path` using byte order and has no duplicate entries.
- `path` is relative POSIX, at most 240 bytes and at most 12 segments. Each segment matches `^[A-Za-z0-9._@+-]{1,128}$` and is neither `.` nor `..`. Paths contain no backslashes, control characters or leading `/`.
- The source kind has extra exclusions. It is rejected if any segment is `node_modules`, `.git`, `dist` (at the root) or `.matrix-store`, or if any file name matches `.env*`, `.build-stamp`, `.build.log` or `*.log`.
- `size` equals the decoded length, and `sha256` equals the SHA-256 of the decoded bytes.
- Limits:
  - 512 files
  - 8 MiB per file
  - 24 MiB total decoded
  - 16 MiB compressed
  - 40 MiB JSON text after decompression, enforced while inflating.
- The **bundle digest** is the SHA-256 of the compressed bytes. That digest is what clients declare and servers verify.
- Encoding is deterministic. Files are sorted, the JSON uses fixed key order (`format`, `kind`, `files`; `path`, `size`, `sha256`, `data`) and no whitespace, and compression is gzip level 9 with a zeroed mtime and OS byte `0xff`. The same files therefore always produce the same digest.
- A source bundle MUST contain `matrix.json`, `package.json`, `pnpm-lock.yaml` and `index.html`. It MAY contain `store/icon.png` or `store/icon.svg` (≤ 256 KiB) and `README.md`/`LICENSE`.
- Store intake and download reject a dist artifact; no platform output distribution exists. A generic codec may retain an internal dist kind only if it is inaccessible to store publication APIs.

The shared implementation is `packages/contracts/src/app-store-bundle.ts`: `encodeAppBundle(kind, files)` and `decodeAppBundle(bytes, { kind })`. It throws `AppBundleError` with a stable `code`.
