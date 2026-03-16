# File Browser Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Finder-class shell-native file browser with directory browsing, file preview/editing (CodeMirror, markdown, images, PDF, audio/video), Quick Look, trash, and full search.

**Architecture:** Shell-native React components in `shell/src/components/file-browser/` and `shell/src/components/preview-window/`. New gateway REST endpoints for directory listing, file operations, search, and trash. Zustand stores for state management. Integrates with existing window manager, file watcher, Dock, and command palette.

**Tech Stack:** React 19, Next.js 16, Zustand 5, Hono, CodeMirror 6, react-markdown, Milkdown, pdfjs-dist, shadcn/ui, Vitest

**Spec:** `specs/048-file-browser/spec.md`

---

## Chunk 1: Gateway API -- File Operations

Foundation layer. All frontend work depends on these endpoints.

### Task 1: MIME Type Map + File Utilities

**Files:**
- Create: `packages/gateway/src/file-utils.ts`
- Test: `tests/gateway/file-utils.test.ts`

- [ ] **Step 1: Write failing test for MIME map**

```typescript
// tests/gateway/file-utils.test.ts
import { describe, it, expect } from "vitest";
import { getMimeType, isTextFile, isBinaryFile } from "../packages/gateway/src/file-utils.js";

describe("getMimeType", () => {
  it("returns correct MIME for markdown", () => {
    expect(getMimeType(".md")).toBe("text/markdown");
  });
  it("returns correct MIME for images", () => {
    expect(getMimeType(".png")).toBe("image/png");
    expect(getMimeType(".jpg")).toBe("image/jpeg");
    expect(getMimeType(".svg")).toBe("image/svg+xml");
  });
  it("returns correct MIME for code files", () => {
    expect(getMimeType(".ts")).toBe("text/typescript");
    expect(getMimeType(".py")).toBe("text/x-python");
  });
  it("returns octet-stream for unknown", () => {
    expect(getMimeType(".xyz")).toBe("application/octet-stream");
  });
  it("handles with or without leading dot", () => {
    expect(getMimeType("md")).toBe("text/markdown");
    expect(getMimeType(".md")).toBe("text/markdown");
  });
});

describe("isTextFile", () => {
  it("recognizes text files", () => {
    expect(isTextFile("readme.md")).toBe(true);
    expect(isTextFile("config.json")).toBe(true);
    expect(isTextFile("app.tsx")).toBe(true);
  });
  it("rejects binary files", () => {
    expect(isTextFile("photo.png")).toBe(false);
    expect(isTextFile("doc.pdf")).toBe(false);
    expect(isTextFile("song.mp3")).toBe(false);
  });
});

describe("isBinaryFile", () => {
  it("recognizes binary files", () => {
    expect(isBinaryFile("photo.png")).toBe(true);
    expect(isBinaryFile("doc.pdf")).toBe(true);
  });
  it("rejects text files", () => {
    expect(isBinaryFile("readme.md")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test tests/gateway/file-utils.test.ts`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement file-utils.ts**

```typescript
// packages/gateway/src/file-utils.ts
import { extname } from "node:path";

const MIME_MAP: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/toml",
  ".csv": "text/csv",
  ".log": "text/plain",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".jsx": "text/jsx",
  ".tsx": "text/tsx",
  ".py": "text/x-python",
  ".html": "text/html",
  ".css": "text/css",
  ".sh": "text/x-shellscript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const TEXT_EXTENSIONS = new Set(
  Object.entries(MIME_MAP)
    .filter(([, mime]) => mime.startsWith("text/") || mime === "application/json")
    .map(([ext]) => ext)
);

const BINARY_EXTENSIONS = new Set(
  Object.entries(MIME_MAP)
    .filter(([, mime]) =>
      mime.startsWith("image/") ||
      mime.startsWith("audio/") ||
      mime.startsWith("video/") ||
      mime === "application/pdf"
    )
    .map(([ext]) => ext)
);

export function getMimeType(extOrFilename: string): string {
  const ext = extOrFilename.startsWith(".")
    ? extOrFilename.toLowerCase()
    : `.${extOrFilename.toLowerCase()}`;
  return MIME_MAP[ext] ?? "application/octet-stream";
}

export function isTextFile(filename: string): boolean {
  return TEXT_EXTENSIONS.has(extname(filename).toLowerCase());
}

export function isBinaryFile(filename: string): boolean {
  return BINARY_EXTENSIONS.has(extname(filename).toLowerCase());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test tests/gateway/file-utils.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/file-utils.ts tests/gateway/file-utils.test.ts
git commit -m "feat(file-browser): add MIME type map and file utilities"
```

---

### Task 2: Extend Directory Listing Endpoint

Extend existing `GET /api/files/tree` (in `files-tree.ts`) with `modified`, `created`, `mime`, and `children` count. Add `/api/files/list` as alias.

**Files:**
- Modify: `packages/gateway/src/files-tree.ts` (lines 90-153)
- Modify: `packages/gateway/src/server.ts` (line 610-617, add alias route)
- Test: `tests/gateway/files-list.test.ts`

- [ ] **Step 1: Write failing test for extended listing**

```typescript
// tests/gateway/files-list.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listDirectory } from "../../packages/gateway/src/files-tree.js";

describe("listDirectory (extended)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `file-browser-test-${Date.now()}`);
    mkdirSync(join(testDir, "sub", "nested"), { recursive: true });
    writeFileSync(join(testDir, "readme.md"), "# Hello");
    writeFileSync(join(testDir, "config.json"), '{"key": "value"}');
    writeFileSync(join(testDir, "sub", "a.txt"), "a");
    writeFileSync(join(testDir, "sub", "b.txt"), "b");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns modified timestamp for files", async () => {
    const entries = await listDirectory(testDir, "");
    const readme = entries!.find((e) => e.name === "readme.md");
    expect(readme).toBeDefined();
    expect(readme!.modified).toBeDefined();
    expect(typeof readme!.modified).toBe("string");
    expect(new Date(readme!.modified!).getTime()).toBeGreaterThan(0);
  });

  it("returns created timestamp for files", async () => {
    const entries = await listDirectory(testDir, "");
    const readme = entries!.find((e) => e.name === "readme.md");
    expect(readme!.created).toBeDefined();
  });

  it("returns mime type for files", async () => {
    const entries = await listDirectory(testDir, "");
    const readme = entries!.find((e) => e.name === "readme.md");
    expect(readme!.mime).toBe("text/markdown");
    const config = entries!.find((e) => e.name === "config.json");
    expect(config!.mime).toBe("application/json");
  });

  it("returns children count for directories", async () => {
    const entries = await listDirectory(testDir, "");
    const sub = entries!.find((e) => e.name === "sub");
    expect(sub).toBeDefined();
    expect(sub!.type).toBe("directory");
    expect(sub!.children).toBe(3); // a.txt, b.txt, nested/
  });

  it("skips dotfiles and dotdirs", async () => {
    mkdirSync(join(testDir, ".hidden"));
    writeFileSync(join(testDir, ".env"), "SECRET=x");
    const entries = await listDirectory(testDir, "");
    const names = entries!.map((e) => e.name);
    expect(names).not.toContain(".hidden");
    expect(names).not.toContain(".env");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test tests/gateway/files-list.test.ts`
Expected: FAIL -- `modified`, `created`, `mime`, `children` properties don't exist on FileTreeEntry

- [ ] **Step 3: Extend FileTreeEntry type and listDirectory()**

In `packages/gateway/src/files-tree.ts`:
- Add `modified?: string`, `created?: string`, `mime?: string`, `children?: number` to `FileTreeEntry` interface
- In the file loop: call `stat()` to get `mtimeMs`/`birthtimeMs`, convert to ISO strings
- For files: add `getMimeType(ext)` call
- For directories: count children with `readdir()` and filter out dotfiles

- [ ] **Step 4: Add /api/files/list alias route**

In `packages/gateway/src/server.ts`, after the existing `/api/files/tree` route (~line 617):

```typescript
app.get("/api/files/list", async (c) => {
  // Same handler as /api/files/tree
});
```

Extract the handler into a shared function used by both routes.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test tests/gateway/files-list.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite to check nothing broke**

Run: `bun run test`
Expected: All existing tests still pass

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/files-tree.ts packages/gateway/src/server.ts tests/gateway/files-list.test.ts
git commit -m "feat(file-browser): extend directory listing with modified, created, mime, children"
```

---

### Task 3: File Stat Endpoint

**Files:**
- Modify: `packages/gateway/src/server.ts`
- Test: `tests/gateway/files-stat.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/gateway/files-stat.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileStat } from "../../packages/gateway/src/file-ops.js";

describe("fileStat", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `file-stat-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "hello.md"), "# Hello World");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns metadata for a file", async () => {
    const stat = await fileStat(testDir, "hello.md");
    expect(stat).toMatchObject({
      name: "hello.md",
      path: "hello.md",
      type: "file",
      mime: "text/markdown",
    });
    expect(stat!.size).toBeGreaterThan(0);
    expect(stat!.modified).toBeDefined();
    expect(stat!.created).toBeDefined();
  });

  it("returns metadata for a directory", async () => {
    mkdirSync(join(testDir, "subdir"));
    const stat = await fileStat(testDir, "subdir");
    expect(stat).toMatchObject({
      name: "subdir",
      path: "subdir",
      type: "directory",
    });
  });

  it("returns null for non-existent path", async () => {
    const stat = await fileStat(testDir, "nope.txt");
    expect(stat).toBeNull();
  });

  it("returns null for path traversal attempt", async () => {
    const stat = await fileStat(testDir, "../../../etc/passwd");
    expect(stat).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test tests/gateway/files-stat.test.ts`
Expected: FAIL -- module not found

- [ ] **Step 3: Create file-ops.ts with fileStat()**

```typescript
// packages/gateway/src/file-ops.ts
import { stat as fsStat } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { resolveWithinHome } from "./path-security.js";
import { getMimeType } from "./file-utils.js";

export interface FileStatResult {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modified: string;
  created: string;
  mime?: string;
}

export async function fileStat(
  homePath: string,
  requestedPath: string
): Promise<FileStatResult | null> {
  const resolved = resolveWithinHome(homePath, requestedPath);
  if (!resolved) return null;

  try {
    const stats = await fsStat(resolved);
    const name = basename(resolved);
    const type = stats.isDirectory() ? "directory" : "file";

    return {
      name,
      path: requestedPath,
      type,
      size: type === "file" ? stats.size : undefined,
      modified: new Date(stats.mtimeMs).toISOString(),
      created: new Date(stats.birthtimeMs).toISOString(),
      mime: type === "file" ? getMimeType(extname(name)) : undefined,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Wire up GET /api/files/stat in server.ts**

```typescript
// In packages/gateway/src/server.ts, after /api/files/list route
app.get("/api/files/stat", async (c) => {
  const pathParam = c.req.query("path");
  if (!pathParam) return c.json({ error: "path required" }, 400);
  const result = await fileStat(homePath, pathParam);
  if (!result) return c.json({ error: "not found" }, 404);
  return c.json(result);
});
```

- [ ] **Step 5: Run tests**

Run: `bun run test tests/gateway/files-stat.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/file-ops.ts packages/gateway/src/server.ts tests/gateway/files-stat.test.ts
git commit -m "feat(file-browser): add file stat endpoint"
```

---

### Task 4: File Create, Mkdir, Rename, Copy, Duplicate

**Files:**
- Modify: `packages/gateway/src/file-ops.ts`
- Modify: `packages/gateway/src/server.ts`
- Test: `tests/gateway/file-ops.test.ts`

- [ ] **Step 1: Write failing tests for all operations**

```typescript
// tests/gateway/file-ops.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  touchFile,
  mkdirp,
  renameFile,
  copyFile,
  duplicateFile,
} from "../../packages/gateway/src/file-ops.js";

describe("file operations", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `file-ops-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("touchFile", () => {
    it("creates an empty file", async () => {
      const result = await touchFile(testDir, "new.md");
      expect(result.ok).toBe(true);
      expect(existsSync(join(testDir, "new.md"))).toBe(true);
      expect(readFileSync(join(testDir, "new.md"), "utf-8")).toBe("");
    });

    it("creates a file with content", async () => {
      const result = await touchFile(testDir, "new.md", "# Hello");
      expect(result.ok).toBe(true);
      expect(readFileSync(join(testDir, "new.md"), "utf-8")).toBe("# Hello");
    });

    it("returns conflict if file exists", async () => {
      writeFileSync(join(testDir, "existing.md"), "x");
      const result = await touchFile(testDir, "existing.md");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("conflict");
    });

    it("creates parent directories", async () => {
      const result = await touchFile(testDir, "deep/nested/file.md");
      expect(result.ok).toBe(true);
      expect(existsSync(join(testDir, "deep/nested/file.md"))).toBe(true);
    });

    it("rejects path traversal", async () => {
      const result = await touchFile(testDir, "../escape.md");
      expect(result.ok).toBe(false);
    });
  });

  describe("mkdirp", () => {
    it("creates a directory", async () => {
      const result = await mkdirp(testDir, "newdir");
      expect(result.ok).toBe(true);
      expect(existsSync(join(testDir, "newdir"))).toBe(true);
    });

    it("creates nested directories", async () => {
      const result = await mkdirp(testDir, "a/b/c");
      expect(result.ok).toBe(true);
      expect(existsSync(join(testDir, "a/b/c"))).toBe(true);
    });

    it("succeeds if directory already exists", async () => {
      mkdirSync(join(testDir, "existing"));
      const result = await mkdirp(testDir, "existing");
      expect(result.ok).toBe(true);
    });
  });

  describe("renameFile", () => {
    it("renames a file", async () => {
      writeFileSync(join(testDir, "old.md"), "content");
      const result = await renameFile(testDir, "old.md", "new.md");
      expect(result.ok).toBe(true);
      expect(existsSync(join(testDir, "new.md"))).toBe(true);
      expect(existsSync(join(testDir, "old.md"))).toBe(false);
    });

    it("moves a file to a subdirectory", async () => {
      writeFileSync(join(testDir, "file.md"), "content");
      mkdirSync(join(testDir, "sub"));
      const result = await renameFile(testDir, "file.md", "sub/file.md");
      expect(result.ok).toBe(true);
      expect(existsSync(join(testDir, "sub/file.md"))).toBe(true);
    });

    it("returns error if source not found", async () => {
      const result = await renameFile(testDir, "nope.md", "new.md");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("not_found");
    });

    it("returns error if destination exists", async () => {
      writeFileSync(join(testDir, "a.md"), "a");
      writeFileSync(join(testDir, "b.md"), "b");
      const result = await renameFile(testDir, "a.md", "b.md");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("conflict");
    });
  });

  describe("copyFile", () => {
    it("copies a file", async () => {
      writeFileSync(join(testDir, "original.md"), "content");
      const result = await copyFile(testDir, "original.md", "copy.md");
      expect(result.ok).toBe(true);
      expect(readFileSync(join(testDir, "copy.md"), "utf-8")).toBe("content");
      expect(existsSync(join(testDir, "original.md"))).toBe(true);
    });

    it("copies a directory recursively", async () => {
      mkdirSync(join(testDir, "dir"));
      writeFileSync(join(testDir, "dir/a.txt"), "a");
      writeFileSync(join(testDir, "dir/b.txt"), "b");
      const result = await copyFile(testDir, "dir", "dir-copy");
      expect(result.ok).toBe(true);
      expect(readFileSync(join(testDir, "dir-copy/a.txt"), "utf-8")).toBe("a");
    });
  });

  describe("duplicateFile", () => {
    it("duplicates with ' copy' suffix", async () => {
      writeFileSync(join(testDir, "file.md"), "content");
      const result = await duplicateFile(testDir, "file.md");
      expect(result.ok).toBe(true);
      expect(result.newPath).toBe("file copy.md");
      expect(readFileSync(join(testDir, "file copy.md"), "utf-8")).toBe("content");
    });

    it("increments copy number if copy exists", async () => {
      writeFileSync(join(testDir, "file.md"), "content");
      writeFileSync(join(testDir, "file copy.md"), "content");
      const result = await duplicateFile(testDir, "file.md");
      expect(result.ok).toBe(true);
      expect(result.newPath).toBe("file copy 2.md");
    });

    it("duplicates a directory", async () => {
      mkdirSync(join(testDir, "mydir"));
      writeFileSync(join(testDir, "mydir/a.txt"), "a");
      const result = await duplicateFile(testDir, "mydir");
      expect(result.ok).toBe(true);
      expect(result.newPath).toBe("mydir copy");
      expect(existsSync(join(testDir, "mydir copy/a.txt"))).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test tests/gateway/file-ops.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement all operations in file-ops.ts**

Add `touchFile`, `mkdirp`, `renameFile`, `copyFile`, `duplicateFile` to `packages/gateway/src/file-ops.ts`. Each function:
- Takes `homePath` and relative paths
- Validates via `resolveWithinHome()`
- Returns `{ ok: boolean; error?: string; newPath?: string }`
- `duplicateFile` generates " copy" / " copy N" suffix before extension

- [ ] **Step 4: Wire up routes in server.ts**

Add `POST /api/files/touch`, `POST /api/files/mkdir`, `POST /api/files/rename`, `POST /api/files/copy`, `POST /api/files/duplicate` routes. Each parses JSON body, calls the corresponding function, returns JSON response with appropriate HTTP status codes (409 for conflict, 404 for not found).

- [ ] **Step 5: Run tests**

Run: `bun run test tests/gateway/file-ops.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/file-ops.ts packages/gateway/src/server.ts tests/gateway/file-ops.test.ts
git commit -m "feat(file-browser): add file create, mkdir, rename, copy, duplicate operations"
```

---

### Task 5: Trash System

**Files:**
- Create: `packages/gateway/src/trash.ts`
- Modify: `packages/gateway/src/server.ts`
- Modify: `packages/gateway/src/watcher.ts` (line 21-25: add `.trash` to ignore)
- Test: `tests/gateway/trash.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/gateway/trash.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { moveToTrash, listTrash, restoreFromTrash, emptyTrash } from "../../packages/gateway/src/trash.js";

describe("trash system", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `trash-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("moveToTrash", () => {
    it("moves file to .trash/", async () => {
      writeFileSync(join(testDir, "file.md"), "content");
      const result = await moveToTrash(testDir, "file.md");
      expect(result.ok).toBe(true);
      expect(result.trashPath).toBe(".trash/file.md");
      expect(existsSync(join(testDir, "file.md"))).toBe(false);
      expect(existsSync(join(testDir, ".trash/file.md"))).toBe(true);
    });

    it("handles name collision with timestamp suffix", async () => {
      writeFileSync(join(testDir, "file.md"), "v1");
      await moveToTrash(testDir, "file.md");
      writeFileSync(join(testDir, "file.md"), "v2");
      const result = await moveToTrash(testDir, "file.md");
      expect(result.ok).toBe(true);
      expect(result.trashPath).not.toBe(".trash/file.md");
    });

    it("records in manifest", async () => {
      writeFileSync(join(testDir, "file.md"), "content");
      await moveToTrash(testDir, "file.md");
      const manifest = JSON.parse(
        readFileSync(join(testDir, ".trash/.manifest.json"), "utf-8")
      );
      expect(manifest).toHaveLength(1);
      expect(manifest[0].originalPath).toBe("file.md");
      expect(manifest[0].deletedAt).toBeDefined();
    });

    it("moves directories to trash", async () => {
      mkdirSync(join(testDir, "mydir"));
      writeFileSync(join(testDir, "mydir/a.txt"), "a");
      const result = await moveToTrash(testDir, "mydir");
      expect(result.ok).toBe(true);
      expect(existsSync(join(testDir, ".trash/mydir/a.txt"))).toBe(true);
    });
  });

  describe("listTrash", () => {
    it("returns empty list when no trash", async () => {
      const entries = await listTrash(testDir);
      expect(entries).toEqual([]);
    });

    it("returns trashed items with metadata", async () => {
      writeFileSync(join(testDir, "file.md"), "content");
      await moveToTrash(testDir, "file.md");
      const entries = await listTrash(testDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        name: "file.md",
        originalPath: "file.md",
        type: "file",
      });
      expect(entries[0].deletedAt).toBeDefined();
      expect(entries[0].size).toBeGreaterThan(0);
    });
  });

  describe("restoreFromTrash", () => {
    it("restores file to original location", async () => {
      writeFileSync(join(testDir, "file.md"), "content");
      await moveToTrash(testDir, "file.md");
      const result = await restoreFromTrash(testDir, ".trash/file.md");
      expect(result.ok).toBe(true);
      expect(result.restoredTo).toBe("file.md");
      expect(existsSync(join(testDir, "file.md"))).toBe(true);
      expect(existsSync(join(testDir, ".trash/file.md"))).toBe(false);
    });

    it("returns conflict if original location occupied", async () => {
      writeFileSync(join(testDir, "file.md"), "v1");
      await moveToTrash(testDir, "file.md");
      writeFileSync(join(testDir, "file.md"), "v2");
      const result = await restoreFromTrash(testDir, ".trash/file.md");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("conflict");
    });

    it("removes entry from manifest", async () => {
      writeFileSync(join(testDir, "file.md"), "content");
      await moveToTrash(testDir, "file.md");
      await restoreFromTrash(testDir, ".trash/file.md");
      const manifest = JSON.parse(
        readFileSync(join(testDir, ".trash/.manifest.json"), "utf-8")
      );
      expect(manifest).toHaveLength(0);
    });
  });

  describe("concurrent operations", () => {
    it("handles concurrent deletes without corrupting manifest", async () => {
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(testDir, `file-${i}.md`), `content-${i}`);
      }
      await Promise.all(
        Array.from({ length: 10 }, (_, i) => moveToTrash(testDir, `file-${i}.md`))
      );
      const manifest = JSON.parse(
        readFileSync(join(testDir, ".trash/.manifest.json"), "utf-8")
      );
      expect(manifest).toHaveLength(10);
    });
  });

  describe("emptyTrash", () => {
    it("permanently deletes all trash", async () => {
      writeFileSync(join(testDir, "a.md"), "a");
      writeFileSync(join(testDir, "b.md"), "b");
      await moveToTrash(testDir, "a.md");
      await moveToTrash(testDir, "b.md");
      const result = await emptyTrash(testDir);
      expect(result.ok).toBe(true);
      expect(result.deleted).toBe(2);
      expect(existsSync(join(testDir, ".trash/a.md"))).toBe(false);
      expect(existsSync(join(testDir, ".trash/b.md"))).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test tests/gateway/trash.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement trash.ts**

Create `packages/gateway/src/trash.ts` with:
- `moveToTrash(homePath, path)`: move to `.trash/`, atomic manifest write (write `.manifest.json.tmp` then rename), collision handling with timestamp suffix
- `listTrash(homePath)`: read manifest, stat each file for size
- `restoreFromTrash(homePath, trashPath)`: move back, check conflict, update manifest atomically
- `emptyTrash(homePath)`: rm -rf `.trash/` contents, clear manifest
- Internal `withTrashLock(fn)` mutex to serialize operations

- [ ] **Step 4: Wire up trash routes in server.ts**

Add `POST /api/files/delete`, `GET /api/files/trash`, `POST /api/files/trash/restore`, `POST /api/files/trash/empty`.

- [ ] **Step 5: Update watcher.ts ignore list**

In `packages/gateway/src/watcher.ts` line 21-25, add `"**/.trash/**"` to the ignored array.

- [ ] **Step 6: Run tests**

Run: `bun run test tests/gateway/trash.test.ts`
Expected: PASS

- [ ] **Step 7: Run full suite**

Run: `bun run test`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/trash.ts packages/gateway/src/server.ts packages/gateway/src/watcher.ts tests/gateway/trash.test.ts
git commit -m "feat(file-browser): add trash system with atomic manifest and mutex"
```

---

### Task 6: Search Endpoint

**Files:**
- Create: `packages/gateway/src/file-search.ts`
- Modify: `packages/gateway/src/server.ts`
- Test: `tests/gateway/file-search.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/gateway/file-search.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { searchFiles } from "../../packages/gateway/src/file-search.js";

describe("searchFiles", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `search-test-${Date.now()}`);
    mkdirSync(join(testDir, "agents"), { recursive: true });
    mkdirSync(join(testDir, ".trash"), { recursive: true });
    writeFileSync(join(testDir, "readme.md"), "# Welcome to Matrix OS");
    writeFileSync(join(testDir, "agents/builder.md"), "Build apps with telegram integration");
    writeFileSync(join(testDir, "config.json"), '{"telegram": {"enabled": true}}');
    writeFileSync(join(testDir, ".trash/old.md"), "trashed file");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("searches file names", async () => {
    const results = await searchFiles(testDir, "readme", "");
    expect(results.results.length).toBeGreaterThanOrEqual(1);
    expect(results.results[0].name).toBe("readme.md");
  });

  it("searches file content when content=true", async () => {
    const results = await searchFiles(testDir, "telegram", "", true);
    expect(results.results.length).toBe(2);
    const paths = results.results.map((r) => r.path);
    expect(paths).toContain("agents/builder.md");
    expect(paths).toContain("config.json");
  });

  it("returns match line and text for content matches", async () => {
    const results = await searchFiles(testDir, "telegram", "", true);
    const config = results.results.find((r) => r.path === "config.json");
    expect(config!.matches.length).toBeGreaterThanOrEqual(1);
    expect(config!.matches[0].type).toBe("content");
    expect(config!.matches[0].text).toContain("telegram");
  });

  it("skips .trash directory", async () => {
    const results = await searchFiles(testDir, "trashed", "", true);
    expect(results.results).toHaveLength(0);
  });

  it("respects limit", async () => {
    const results = await searchFiles(testDir, "", "", false, 1);
    expect(results.results.length).toBeLessThanOrEqual(1);
    expect(results.truncated).toBe(true);
  });

  it("searches within a subdirectory", async () => {
    const results = await searchFiles(testDir, "builder", "agents");
    expect(results.results).toHaveLength(1);
  });

  it("skips files larger than 1MB for content search", async () => {
    writeFileSync(join(testDir, "huge.txt"), "needle " + "x".repeat(1024 * 1024 + 100));
    const results = await searchFiles(testDir, "needle", "", true);
    const huge = results.results.find((r) => r.path === "huge.txt");
    // Should only match by name if applicable, not by content
    expect(huge?.matches.every((m) => m.type === "name") ?? true).toBe(true);
  });

  it("supports cancellation via AbortSignal", async () => {
    const controller = new AbortController();
    controller.abort();
    const results = await searchFiles(testDir, "readme", "", false, 100, controller.signal);
    expect(results.results).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test tests/gateway/file-search.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement file-search.ts**

Create `packages/gateway/src/file-search.ts` with:
- `searchFiles(homePath, query, subPath, contentSearch, limit)`: recursive readdir, match file names (case-insensitive includes), optionally read text files line-by-line for content matches
- Skip `.trash/`, `.git/`, `node_modules/`, all dotdirs
- Skip files > 1MB for content search
- Accept `AbortSignal` parameter for cancellation
- 5 second timeout via `AbortSignal.timeout(5000)` merged with caller signal
- Return `{ query, results, truncated }`

- [ ] **Step 4: Wire up GET /api/files/search in server.ts**

```typescript
app.get("/api/files/search", async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: "q required" }, 400);
  const path = c.req.query("path") ?? "";
  const content = c.req.query("content") === "true";
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  const results = await searchFiles(homePath, q, path, content, limit);
  return c.json(results);
});
```

- [ ] **Step 5: Run tests**

Run: `bun run test tests/gateway/file-search.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/file-search.ts packages/gateway/src/server.ts tests/gateway/file-search.test.ts
git commit -m "feat(file-browser): add file search endpoint with name and content search"
```

---

## Chunk 2: Zustand Stores + Shell Integration

### Task 7: useFileBrowser Store

**Files:**
- Create: `shell/src/hooks/useFileBrowser.ts`
- Test: `tests/shell/useFileBrowser.test.ts`

- [ ] **Step 1: Write failing tests**

Test the store in isolation with mocked `fetch`:
- `navigate(path)` sets `currentPath`, pushes to `history`, calls `/api/files/list?path=...`
- `goBack()` / `goForward()` move through history
- `select(path)` / `select(path, true)` for multi-select / `select(path, false, true)` for range
- `setViewMode()` updates view
- `copy()` / `cut()` / `paste()` clipboard operations
- `search(query)` sets `searching`, calls `/api/files/search`, sets results
- `toggleFavorite()` adds/removes from favorites
- `createFolder()`, `createFile()`, `delete()`, `duplicate()`, `rename()` call correct API endpoints

- [ ] **Step 2: Run to verify fails**

- [ ] **Step 3: Implement useFileBrowser.ts**

Zustand store with all state and actions. Actions call gateway API via fetch and update state. Include `refresh()` that re-fetches current directory. Debounced persistence of preferences (viewMode, sortBy, favorites, sidebarCollapsed, showPreviewPanel) to `/api/bridge/data` with app key `file-browser`.

- [ ] **Step 4: Run tests to verify pass**

- [ ] **Step 5: Commit**

```bash
git add shell/src/hooks/useFileBrowser.ts tests/shell/useFileBrowser.test.ts
git commit -m "feat(file-browser): add useFileBrowser Zustand store"
```

---

### Task 8: usePreviewWindow Store

**Files:**
- Create: `shell/src/hooks/usePreviewWindow.ts`
- Test: `tests/shell/usePreviewWindow.test.ts`

- [ ] **Step 1: Write failing tests**

- `openFile(path)` adds a tab if not already open, focuses it if exists
- `closeTab(id)` removes tab, selects adjacent tab
- `setActiveTab(id)` switches active
- `setMode(id, mode)` only works for text/code/markdown types, no-ops for others
- `markUnsaved(id)` / `markSaved(id)` track dirty state
- `reorderTabs(from, to)` swaps tab positions
- File type detection: `.md` -> markdown, `.ts` -> code, `.png` -> image, `.pdf` -> pdf, `.mp3` -> audio, `.mp4` -> video, `.txt` -> text

- [ ] **Step 2: Run to verify fails**

- [ ] **Step 3: Implement usePreviewWindow.ts**

Zustand store. `openFile` detects file type from extension and creates tab. Persistence of open tabs to bridge data on change.

- [ ] **Step 4: Run tests to verify pass**

- [ ] **Step 5: Commit**

```bash
git add shell/src/hooks/usePreviewWindow.ts tests/shell/usePreviewWindow.test.ts
git commit -m "feat(file-browser): add usePreviewWindow Zustand store"
```

---

### Task 9: Register File Browser in Shell

Register the file browser as a built-in app: Dock icon, window manager support, command palette action.

**Files:**
- Modify: `shell/src/components/Desktop.tsx` (add file browser window type + Dock registration)
- Modify: `shell/src/stores/commands.ts` or Desktop.tsx command registration
- Test: `tests/shell/file-browser-registration.test.ts`

- [ ] **Step 1: Write failing test**

Test that opening a window with path `__file-browser__` renders the FileBrowser component (similar to how `__terminal__` renders TerminalApp at Desktop.tsx line 1004).

- [ ] **Step 2: Run to verify fails**

- [ ] **Step 3: Add file browser to Desktop.tsx**

In the window rendering switch (around line 1000-1010 in Desktop.tsx):
```typescript
if (win.path.startsWith("__file-browser__")) {
  return <FileBrowser windowId={win.id} />;
}
```

Add file browser to built-in apps list (around line 512-514):
```typescript
addApp("Files", "__file-browser__");
```

Register command palette action:
```typescript
register([{
  id: "open-file-browser",
  label: "Open File Browser",
  group: "Actions",
  shortcut: "Cmd+Shift+F",
  execute: () => openWindow("Files", "__file-browser__"),
}]);
```

- [ ] **Step 4: Create placeholder FileBrowser component**

Create `shell/src/components/file-browser/FileBrowser.tsx` with a minimal placeholder that renders "File Browser" text. Full implementation comes in Chunk 3.

- [ ] **Step 5: Run tests to verify pass**

- [ ] **Step 6: Run full suite**

Run: `bun run test`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add shell/src/components/Desktop.tsx shell/src/components/file-browser/FileBrowser.tsx tests/shell/file-browser-registration.test.ts
git commit -m "feat(file-browser): register file browser in shell with Dock and command palette"
```

---

## Chunk 3: File Browser UI Components

### Task 10: FileBrowser Main Container

**Files:**
- Create: `shell/src/components/file-browser/FileBrowser.tsx`
- Create: `shell/src/components/file-browser/index.ts`
- Test: `tests/shell/file-browser/FileBrowser.test.tsx`

- [ ] **Step 1: Write failing test**

Test that `<FileBrowser>` renders toolbar, sidebar, content area, and status bar. Test that it has a focus container with `tabIndex={0}`.

- [ ] **Step 2: Implement FileBrowser.tsx**

Main layout component using CSS Grid:
```
grid-template-columns: [sidebar] auto [content] 1fr [preview] auto
grid-template-rows: [toolbar] auto [main] 1fr [status] auto
```

Renders: `<FileBrowserToolbar>`, `<FileBrowserSidebar>`, `<FileBrowserContent>`, `<PreviewPanel>`, status bar div. Wraps everything in a focus container `<div tabIndex={0} onKeyDown={handleKeyDown}>`.

- [ ] **Step 3: Run tests, commit**

---

### Task 11: FileBrowserToolbar

**Files:**
- Create: `shell/src/components/file-browser/FileBrowserToolbar.tsx`
- Test: `tests/shell/file-browser/FileBrowserToolbar.test.tsx`

- [ ] **Step 1: Write failing test**

Test renders: back/forward buttons (disabled when no history), breadcrumb path segments (clickable), view mode toggle (Icon/List/Columns), search input.

- [ ] **Step 2: Implement**

Uses `useFileBrowser` store for `currentPath`, `history`, `historyIndex`, `viewMode`, `searchQuery`. Breadcrumbs split path by `/` and each segment calls `navigate()`. View toggle uses shadcn button group pattern. Search input with debounced onChange (300ms).

- [ ] **Step 3: Run tests, commit**

---

### Task 12: FileBrowserSidebar

**Files:**
- Create: `shell/src/components/file-browser/FileBrowserSidebar.tsx`
- Test: `tests/shell/file-browser/FileBrowserSidebar.test.tsx`

- [ ] **Step 1: Write failing test**

Test renders four sections: Favorites, Locations, Smart Filters, Trash. Test clicking a location navigates. Test collapsible state.

- [ ] **Step 2: Implement**

Favorites from store, Locations hardcoded (Agents, Apps, System, Plugins, Modules, Data), Smart Filters (Recent, Markdown, Media -- these set search filters), Trash link navigates to trash view. Uses shadcn Collapsible for sidebar collapse.

- [ ] **Step 3: Run tests, commit**

---

### Task 13: IconView

**Files:**
- Create: `shell/src/components/file-browser/IconView.tsx`
- Create: `shell/src/components/file-browser/FileIcon.tsx`
- Test: `tests/shell/file-browser/IconView.test.tsx`

- [ ] **Step 1: Write failing test**

Test renders grid of FileIcon components from entries. Test click selects, Cmd+click multi-selects, double-click calls openFile.

- [ ] **Step 2: Implement IconView and FileIcon**

IconView: CSS grid with `grid-template-columns: repeat(auto-fill, 96px)`. Maps entries to FileIcon components.

FileIcon: renders icon (folder gradient for dirs, file type icon for files, `<img>` thumbnail for images via `/files/{path}`), file name below truncated with `text-overflow: ellipsis`. Selection state via blue border/background. Uses lucide-react icons (Folder, File, FileText, Image, Film, Music, FileCode).

- [ ] **Step 3: Run tests, commit**

---

### Task 14: ListView

**Files:**
- Create: `shell/src/components/file-browser/ListView.tsx`
- Test: `tests/shell/file-browser/ListView.test.tsx`

- [ ] **Step 1: Write failing test**

Test renders table with columns (Name, Size, Modified, Type). Test clicking column header sorts. Test row click selects. Test disclosure triangles for folders.

- [ ] **Step 2: Implement**

Table with `<thead>` sortable columns (click toggles sort direction via store). Rows render file info with appropriate formatting (human-readable size, relative date). Disclosure triangle on folders: click expands inline (fetches subdirectory). Uses shadcn ScrollArea for overflow.

- [ ] **Step 3: Run tests, commit**

---

### Task 15: ColumnView

**Files:**
- Create: `shell/src/components/file-browser/ColumnView.tsx`
- Test: `tests/shell/file-browser/ColumnView.test.tsx`

- [ ] **Step 1: Write failing test**

Test renders columns for path segments. Test selecting a folder adds a new column. Test max 5 visible columns with horizontal scroll. Test column width minimum 180px.

- [ ] **Step 2: Implement**

Horizontal flex container with `overflow-x: auto`. Each column fetches its directory listing. Selecting a folder loads next column. Selecting a file shows preview in rightmost column. Column dividers draggable for resize. Limit to 5 visible columns, earlier ones scroll off.

- [ ] **Step 3: Run tests, commit**

---

### Task 16: FileBrowserContent (view switcher)

**Files:**
- Create: `shell/src/components/file-browser/FileBrowserContent.tsx`
- Test: `tests/shell/file-browser/FileBrowserContent.test.tsx`

- [ ] **Step 1: Write failing test**

Test switches between IconView, ListView, ColumnView based on store `viewMode`.

- [ ] **Step 2: Implement**

Simple switch component that reads `viewMode` from store and renders the corresponding view. Passes entries and selection handlers.

- [ ] **Step 3: Run tests, commit**

---

### Task 17: PreviewPanel

**Files:**
- Create: `shell/src/components/file-browser/PreviewPanel.tsx`
- Test: `tests/shell/file-browser/PreviewPanel.test.tsx`

- [ ] **Step 1: Write failing test**

Test renders file info (name, type, size, dates, path) for selected file. Test shows text preview snippet for text files. Test shows thumbnail for images. Test toggle-able via store.

- [ ] **Step 2: Implement**

Right sidebar. Fetches file stat via `/api/files/stat`. For text files: fetches first 20 lines via `GET /files/{path}` and displays in monospace box. For images: renders `<img src="/files/{path}">` as thumbnail. Toggle controlled by `showPreviewPanel` in store.

- [ ] **Step 3: Run tests, commit**

---

### Task 18: ContextMenu

**Files:**
- Create: `shell/src/components/file-browser/ContextMenu.tsx`
- Test: `tests/shell/file-browser/ContextMenu.test.tsx`

- [ ] **Step 1: Write failing test**

Test right-click on file shows file context menu items. Test right-click on empty space shows creation menu. Test right-click on multiple selection shows bulk actions.

- [ ] **Step 2: Implement**

Uses shadcn `ContextMenu` component. Menu items determined by selection state (file, folder, empty, multi). Actions call store methods (copy, cut, delete, rename, duplicate, etc.). Submenu for "New File" with type options (.md, .txt, .json, .html, .js, .ts). Submenu for "Sort By" and "View As" on empty space.

- [ ] **Step 3: Run tests, commit**

---

### Task 19: SearchResults

**Files:**
- Create: `shell/src/components/file-browser/SearchResults.tsx`
- Test: `tests/shell/file-browser/SearchResults.test.tsx`

- [ ] **Step 1: Write failing test**

Test renders flat list of search results with file name, path, and match highlights. Test clicking a result navigates to its directory and selects it.

- [ ] **Step 2: Implement**

Flat list replacing the content area when `searchResults` is non-null in store. Each result shows file icon, name, path, and matched text with query highlighted in bold/accent color. Click navigates to parent directory and selects the file. Enter opens in Preview Window.

- [ ] **Step 3: Run tests, commit**

---

### Task 20: TrashView

**Files:**
- Create: `shell/src/components/file-browser/TrashView.tsx`
- Test: `tests/shell/file-browser/TrashView.test.tsx`

- [ ] **Step 1: Write failing test**

Test renders trashed items with original path and deletion date. Test restore button. Test empty trash button with confirmation dialog.

- [ ] **Step 2: Implement**

Replaces content area when viewing trash. Fetches from `GET /api/files/trash`. Each item shows name, original path, deletion date, size. "Restore" button per item calls `POST /api/files/trash/restore`. "Empty Trash" button in toolbar with shadcn AlertDialog confirmation calls `POST /api/files/trash/empty`.

- [ ] **Step 3: Run tests, commit**

---

### Task 21: Keyboard Shortcuts

**Files:**
- Modify: `shell/src/components/file-browser/FileBrowser.tsx` (add onKeyDown handler)
- Test: `tests/shell/file-browser/keyboard.test.tsx`

- [ ] **Step 1: Write failing test**

Test all keyboard shortcuts defined in spec:
- Arrow keys for navigation
- Space for Quick Look toggle
- Enter for rename (300ms delay after selection, only single already-selected item) / open in Quick Look mode
- Cmd+C/X/V for clipboard
- Cmd+Delete for trash
- Cmd+Shift+N for new folder
- Cmd+Shift+D for duplicate
- Cmd+Shift+I for toggle preview panel
- Cmd+A for select all
- Cmd+[ / Cmd+] for history
- Cmd+Up / Cmd+Down for parent / open
- F2 for rename
- Escape for dismiss Quick Look

- [ ] **Step 2: Implement onKeyDown handler**

In FileBrowser.tsx, the focus container's `onKeyDown` calls `e.preventDefault()` for handled shortcuts and dispatches to store actions. Quick Look state checked for Enter/Space/Escape context.

- [ ] **Step 3: Run tests, commit**

---

### Task 22: File Watcher Integration

**Files:**
- Modify: `shell/src/components/file-browser/FileBrowser.tsx`
- Test: `tests/shell/file-browser/watcher.test.tsx`

- [ ] **Step 1: Write failing test**

Test that file:change events for current directory trigger a refresh of the entries list.

- [ ] **Step 2: Implement**

Use `useFileWatcher` hook in FileBrowser. Filter events where `path` starts with `currentPath`. On `add`/`unlink`/`change`: call `refresh()` on the store.

- [ ] **Step 3: Run tests, commit**

---

### Task 22b: Inline Rename UI

**Files:**
- Create: `shell/src/components/file-browser/InlineRename.tsx`
- Test: `tests/shell/file-browser/InlineRename.test.tsx`

- [ ] **Step 1: Write failing test**

Test that when rename is triggered (Enter with 300ms delay on selected item, or F2), an `<input>` replaces the file name text. Test the input auto-selects the filename without extension. Test Enter commits rename (calls `rename()` on store). Test Escape cancels and restores original name. Test blur commits. Test validation (empty name, invalid characters, name conflicts).

- [ ] **Step 2: Implement InlineRename.tsx**

Component that renders an `<input>` in place of the file name. Props: `name: string`, `onCommit: (newName: string) => void`, `onCancel: () => void`. On mount: auto-focus input, select text up to last `.` (filename without extension). On Enter/blur: validate and call onCommit. On Escape: call onCancel. Used by FileIcon (IconView) and ListView row. Store tracks `renamingPath: string | null`.

- [ ] **Step 3: Run tests, commit**

---

### Task 22c: Accessibility

**Files:**
- Modify: `shell/src/components/file-browser/IconView.tsx`
- Modify: `shell/src/components/file-browser/ListView.tsx`
- Modify: `shell/src/components/file-browser/ColumnView.tsx`
- Modify: `shell/src/components/file-browser/FileBrowserToolbar.tsx`
- Modify: `shell/src/components/file-browser/FileBrowser.tsx` (status bar)
- Test: `tests/shell/file-browser/accessibility.test.tsx`

- [ ] **Step 1: Write failing test**

Test `role="grid"` on IconView and ListView containers. Test `role="row"` + `role="gridcell"` on items. Test `role="tree"` on ColumnView. Test `role="treeitem"` on column entries. Test `aria-label` on all toolbar buttons. Test status bar has `aria-live="polite"`. Test file operation results announced via `aria-live` region.

- [ ] **Step 2: Add ARIA attributes to all view components**

Add roles, labels, and live regions as specified in the spec's Accessibility section.

- [ ] **Step 3: Run tests, commit**

---

## Chunk 4: Dependencies + Quick Look

### Task 23: Install Dependencies

**Files:**
- Modify: `shell/package.json`

- [ ] **Step 1: Install CodeMirror packages**

```bash
cd shell && pnpm add @codemirror/view @codemirror/state @codemirror/language @codemirror/commands @codemirror/search @codemirror/autocomplete @codemirror/lang-javascript @codemirror/lang-json @codemirror/lang-markdown @codemirror/lang-html @codemirror/lang-css @codemirror/lang-python @codemirror/theme-one-dark
```

- [ ] **Step 2: Install markdown packages**

```bash
cd shell && pnpm add react-markdown rehype-highlight remark-gfm
```

- [ ] **Step 3: Install WYSIWYG and PDF packages**

```bash
cd shell && pnpm add @milkdown/core @milkdown/preset-commonmark @milkdown/preset-gfm @milkdown/theme-nord @milkdown/react pdfjs-dist
```

- [ ] **Step 4: Verify build succeeds**

```bash
cd shell && pnpm build
```

- [ ] **Step 5: Commit**

```bash
git add shell/package.json shell/pnpm-lock.yaml
git commit -m "chore(file-browser): add CodeMirror, react-markdown, Milkdown, pdfjs-dist deps"
```

---

### Task 24: QuickLook Component

**Files:**
- Create: `shell/src/components/file-browser/QuickLook.tsx`
- Test: `tests/shell/file-browser/QuickLook.test.tsx`

- [ ] **Step 1: Write failing test**

Test renders modal when `quickLookPath` is set. Test dismisses on Space/Escape. Test shows file name, size, path in header. Test "Open" button opens in Preview Window. Test arrow key navigation changes file while staying open. Test focus trap within modal. Test animation classes applied.

- [ ] **Step 2: Implement QuickLook.tsx**

Portal-rendered modal overlay with:
- Backdrop: `backdrop-filter: blur(8px)` + dark overlay
- Content: centered card (75% width, max 600px) with header, preview area, footer
- Header: file icon, name, size/type, "Open" button
- Preview: renders content based on file type:
  - Text/code/markdown: fetch first 100 lines from `GET /files/{path}`, render with basic syntax highlighting or markdown rendering
  - Images: `<img>` tag with `object-fit: contain`
  - PDF: first page via pdfjs (lazy loaded)
  - Audio/video: native `<audio>`/`<video>` with controls
- Footer: keyboard hints
- Animation: `scale(0.95)` + `opacity(0)` -> `scale(1)` + `opacity(1)` (200ms ease-out)
- Focus trap: Tab stays within modal, Escape/Space dismiss
- Arrow Up/Down: change `quickLookPath` in store to adjacent entry, content crossfades

- [ ] **Step 3: Run tests, commit**

---

## Chunk 5: Preview Window + Editors

### Task 25: PreviewWindow Container + Tab Bar

**Files:**
- Create: `shell/src/components/preview-window/PreviewWindow.tsx`
- Create: `shell/src/components/preview-window/index.ts`
- Modify: `shell/src/components/Desktop.tsx` (add preview window type)
- Test: `tests/shell/preview-window/PreviewWindow.test.tsx`

- [ ] **Step 1: Write failing test**

Test renders tab bar with open tabs. Test active tab has blue border. Test clicking tab switches active. Test close button removes tab. Test middle-click closes tab. Test unsaved indicator (amber dot). Test closing last tab closes the window. Test closing tab with unsaved changes shows confirmation dialog (Save / Don't Save / Cancel). Test closing window with multiple unsaved tabs lists all unsaved files in confirmation.

- [ ] **Step 2: Implement PreviewWindow.tsx**

Window container registered in Desktop.tsx as `__preview-window__` path (follows Terminal pattern, NOT MissionControl/Settings which are panel-based overlays). Tab bar at top. Renders `<PreviewTab>` for active tab content. Tab bar shows file icons, names, close buttons. Unsaved tabs show amber dot. Drag to reorder tabs. Keyboard: Cmd+Shift+W closes tab, Cmd+Shift+[/] switches tabs. Unsaved confirmation: closing a tab with unsaved changes shows shadcn AlertDialog with Save/Don't Save/Cancel. Closing window with multiple unsaved tabs lists all unsaved files.

- [ ] **Step 3: Register in Desktop.tsx**

Add window type check:
```typescript
if (win.path.startsWith("__preview-window__")) {
  return <PreviewWindow windowId={win.id} />;
}
```

- [ ] **Step 4: Run tests, commit**

---

### Task 26: PreviewTab + File Type Router

**Files:**
- Create: `shell/src/components/preview-window/PreviewTab.tsx`
- Test: `tests/shell/preview-window/PreviewTab.test.tsx`

- [ ] **Step 1: Write failing test**

Test routes to correct viewer based on file type. Test renders editor toolbar with mode toggle appropriate to type. Test Save button calls PUT endpoint. Test unsaved indicator on edit.

- [ ] **Step 2: Implement PreviewTab.tsx**

Detects file type from tab state, lazy-loads appropriate viewer via `React.lazy()`:
- `markdown` -> MarkdownViewer (preview mode) or CodeEditor (source) or WysiwygEditor
- `code`/`text` -> CodeEditor
- `image` -> ImageViewer
- `pdf` -> PdfViewer
- `audio`/`video` -> MediaPlayer

Editor toolbar: mode toggle (Source/Preview/WYSIWYG for markdown, Source/Preview for code), encoding label, Save button. Save calls `PUT /files/{path}`.

- [ ] **Step 3: Run tests, commit**

---

### Task 27: CodeEditor (CodeMirror 6)

**Files:**
- Create: `shell/src/components/preview-window/CodeEditor.tsx`
- Test: `tests/shell/preview-window/CodeEditor.test.tsx`

- [ ] **Step 1: Write failing test**

Test renders CodeMirror editor. Test loads content from path. Test language detection from extension. Test Cmd+S triggers save callback. Test onChange marks tab as unsaved.

- [ ] **Step 2: Implement CodeEditor.tsx**

React wrapper around CodeMirror 6:
- `EditorView` with `EditorState` created from fetched file content
- Language extension selected by file extension (js/ts -> javascript, json, markdown, html, css, python, shell -> StreamLanguage)
- `oneDark` theme (or custom Matrix OS theme mapping)
- Extensions: line numbers, active line highlight, bracket matching, search (Cmd+F), word wrap toggle
- `updateListener` dispatches onChange callback for unsaved tracking
- `keymap` with Cmd+S bound to save callback
- Props: `path: string`, `content: string`, `onChange: (content: string) => void`, `onSave: (content: string) => void`, `language: string`

- [ ] **Step 3: Run tests, commit**

---

### Task 28: MarkdownViewer

**Files:**
- Create: `shell/src/components/preview-window/MarkdownViewer.tsx`
- Test: `tests/shell/preview-window/MarkdownViewer.test.tsx`

- [ ] **Step 1: Write failing test**

Test renders markdown as HTML. Test headings, lists, code blocks, tables, task lists render correctly. Test GFM extensions work.

- [ ] **Step 2: Implement**

```tsx
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

export function MarkdownViewer({ content }: { content: string }) {
  return (
    <div className="prose prose-invert max-w-none px-12 py-8">
      <ReactMarkdown rehypePlugins={[rehypeHighlight]} remarkPlugins={[remarkGfm]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
```

Style with Tailwind prose classes matching Matrix OS theme.

- [ ] **Step 3: Run tests, commit**

---

### Task 29: WysiwygEditor (Milkdown)

**Files:**
- Create: `shell/src/components/preview-window/WysiwygEditor.tsx`
- Test: `tests/shell/preview-window/WysiwygEditor.test.tsx`

- [ ] **Step 1: Write failing test**

Test renders rich editor. Test outputs markdown on change. Test bold/italic/heading controls work.

- [ ] **Step 2: Implement**

Lazy-loaded Milkdown editor with:
- `@milkdown/preset-commonmark` + `@milkdown/preset-gfm`
- `@milkdown/react` for React integration
- Toolbar: bold, italic, headings (1-3), bullet list, ordered list, code block, link
- onChange outputs markdown string
- Theme styled to match Matrix OS

- [ ] **Step 3: Run tests, commit**

---

### Task 30: ImageViewer

**Files:**
- Create: `shell/src/components/preview-window/ImageViewer.tsx`
- Test: `tests/shell/preview-window/ImageViewer.test.tsx`

- [ ] **Step 1: Write failing test**

Test renders image from path. Test zoom controls (+, -, Fit). Test displays dimensions and file size. Test checkerboard background for transparency.

- [ ] **Step 2: Implement**

- `<img>` with `object-fit: contain` inside scrollable container
- Checkerboard CSS background via `repeating-conic-gradient`
- Zoom: state-tracked scale factor, scroll wheel zoom, +/- buttons, Fit button resets
- Pan: drag to scroll when zoomed past container bounds
- Toolbar: dimensions (from naturalWidth/naturalHeight), format, size, zoom controls

- [ ] **Step 3: Run tests, commit**

---

### Task 31: PdfViewer

**Files:**
- Create: `shell/src/components/preview-window/PdfViewer.tsx`
- Test: `tests/shell/preview-window/PdfViewer.test.tsx`

- [ ] **Step 1: Write failing test**

Test renders first page of PDF. Test page navigation (prev/next). Test zoom controls.

- [ ] **Step 2: Implement**

Lazy-loaded `pdfjs-dist` viewer:
- Load PDF from `/files/{path}` as ArrayBuffer
- Render page to `<canvas>` element
- Page navigation: state tracks current page, render on change
- Zoom: scale factor applied to viewport
- Toolbar: prev/next buttons, page number display, zoom controls

- [ ] **Step 3: Run tests, commit**

---

### Task 32: MediaPlayer

**Files:**
- Create: `shell/src/components/preview-window/MediaPlayer.tsx`
- Test: `tests/shell/preview-window/MediaPlayer.test.tsx`

- [ ] **Step 1: Write failing test**

Test renders `<audio>` for audio files. Test renders `<video>` for video files. Test controls attribute present.

- [ ] **Step 2: Implement**

Simple wrapper:
```tsx
export function MediaPlayer({ path, type }: { path: string; type: "audio" | "video" }) {
  const Element = type === "audio" ? "audio" : "video";
  return (
    <div className="flex items-center justify-center h-full">
      <Element src={`/files/${path}`} controls className="max-w-full max-h-full" />
    </div>
  );
}
```

- [ ] **Step 3: Run tests, commit**

---

## Chunk 6: Integration + Polish

### Task 33: Preview Window Keyboard Shortcuts

**Files:**
- Modify: `shell/src/components/preview-window/PreviewWindow.tsx`
- Test: `tests/shell/preview-window/keyboard.test.tsx`

- [ ] **Step 1: Write failing test**

Test Cmd+S saves current tab. Test Cmd+Shift+W closes tab. Test Cmd+Shift+[/] switches tabs. Test Cmd+Shift+P toggles preview mode.

- [ ] **Step 2: Implement onKeyDown in PreviewWindow**

Focus container with scoped keyboard handler. Cmd+S calls save on active tab's editor. Other shortcuts dispatch to store.

- [ ] **Step 3: Run tests, commit**

---

### Task 34: External File Change Banner

**Files:**
- Modify: `shell/src/components/preview-window/PreviewTab.tsx`
- Test: `tests/shell/preview-window/external-change.test.tsx`

- [ ] **Step 1: Write failing test**

Test that when a file:change event fires for an open tab's path, a banner appears with "Reload" and "Ignore" buttons.

- [ ] **Step 2: Implement**

Use `useFileWatcher` in PreviewTab. When file changes externally and tab has unsaved changes, show banner. "Reload" re-fetches content and replaces editor state. "Ignore" dismisses banner.

- [ ] **Step 3: Run tests, commit**

---

### Task 35: Drag and Drop

**Files:**
- Modify: `shell/src/components/file-browser/IconView.tsx`
- Modify: `shell/src/components/file-browser/ListView.tsx`
- Modify: `shell/src/components/file-browser/FileBrowserSidebar.tsx`
- Test: `tests/shell/file-browser/dnd.test.tsx`

- [ ] **Step 1: Write failing test**

Test dragging files onto a folder triggers move. Test visual feedback (blue highlight on valid drop target).

- [ ] **Step 2: Implement**

Use native HTML drag and drop API:
- `draggable` on file/folder items
- `onDragStart` sets data transfer with file paths
- `onDragOver` on folder items/sidebar highlights drop target
- `onDrop` calls `renameFile` (move) with new path
- Ghost preview shows dragged item count

- [ ] **Step 3: Run tests, commit**

---

### Task 36: Persistence

**Files:**
- Modify: `shell/src/hooks/useFileBrowser.ts`
- Modify: `shell/src/hooks/usePreviewWindow.ts`
- Test: `tests/shell/file-browser/persistence.test.ts`

- [ ] **Step 1: Write failing test**

Test that viewMode, favorites, sidebarCollapsed, showPreviewPanel are saved to bridge data and restored on mount. Test Preview Window tabs are saved and restored.

- [ ] **Step 2: Implement**

On store init: fetch persisted state from `/api/bridge/data` (app: `file-browser`). On state change: debounce 500ms save to bridge data. Preview Window: save/restore open tab paths.

- [ ] **Step 3: Run tests, commit**

---

### Task 37: Full Integration Test

**Files:**
- Test: `tests/integration/file-browser.test.ts`

- [ ] **Step 1: Write integration test**

End-to-end flow using gateway:
1. Create a temp home directory
2. Start gateway pointing to it
3. Call `GET /api/files/list` -- verify directory listing
4. Call `POST /api/files/touch` -- create file
5. Call `GET /api/files/stat` -- verify metadata
6. Call `POST /api/files/rename` -- rename
7. Call `POST /api/files/copy` -- copy
8. Call `POST /api/files/duplicate` -- duplicate
9. Call `POST /api/files/delete` -- trash
10. Call `GET /api/files/trash` -- verify in trash
11. Call `POST /api/files/trash/restore` -- restore
12. Call `GET /api/files/search?q=...&content=true` -- search
13. Call `POST /api/files/trash/empty` -- empty trash
14. Clean up temp directory

- [ ] **Step 2: Run integration test**

Run: `bun run test tests/integration/file-browser.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/integration/file-browser.test.ts
git commit -m "test(file-browser): add full integration test for file operations"
```

---

### Task 38: Run Full Test Suite + Coverage

- [ ] **Step 1: Run all tests**

```bash
bun run test
```

Expected: All existing + new tests pass

- [ ] **Step 2: Run coverage**

```bash
bun run test:coverage
```

Expected: 99%+ coverage on new files. Fix any gaps.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat(file-browser): complete file browser implementation"
```

---

## Summary

| Chunk | Tasks | Description |
|-------|-------|-------------|
| 1 | 1-6 | Gateway API: file utils, listing, stat, CRUD, trash, search |
| 2 | 7-9 | Zustand stores + shell registration |
| 3 | 10-22c | File browser UI: views, sidebar, toolbar, context menu, search, trash, shortcuts, watcher, inline rename, accessibility |
| 4 | 23-24 | Install deps + Quick Look overlay |
| 5 | 25-32 | Preview Window + editors/viewers (CodeMirror, markdown, WYSIWYG, image, PDF, media) |
| 6 | 33-38 | Integration: Preview Window shortcuts, external changes, drag-and-drop, persistence, integration test |

**Total: 40 tasks across 6 chunks**

**Dependencies:** Chunk 1 must complete first (API foundation). Chunk 2 depends on Chunk 1 (stores call API). Chunk 3 depends on Chunk 2 (components use stores). Chunk 4 can start after Chunk 2 (Quick Look uses stores + deps). Chunk 5 can start after Chunk 4 (deps installed). Chunk 6 requires all others.

**Parallelism within chunks:** Tasks 7-8 (stores) can run in parallel. Tasks 13-20 (UI components) can parallel after Task 10. Tasks 27-32 (editors/viewers) can parallel after Task 26.

**Notes:**
- Line numbers in file references are approximate -- search for code patterns rather than exact lines
- The file browser follows the Terminal integration pattern (AppWindow-based), not MissionControl/Settings (which are overlay panels)
- Context menu "Open in Terminal" spawns a terminal window and sends `cd` command via WebSocket
- Context menu "Copy Path" uses `navigator.clipboard.writeText()`
- Smart Filters (Recent, Markdown, Media) use `/api/files/search` with extension/date filters client-side
