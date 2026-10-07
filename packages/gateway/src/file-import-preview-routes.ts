import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { Hono, type Context } from "hono";
import { z } from "zod/v4";
import { isSafeUploadDirectory } from "@matrix-os/contracts/file-upload";
import { ImportPreviewError, MAX_IMPORT_PREVIEW_BYTES, parseSelectedImportPreview } from "@matrix-os/contracts/selected-import-preview";
import { resolveExistingFileApiPath } from "./path-security.js";
import { isRequestPrincipalError, mapRequestPrincipalError, type RequestPrincipal } from "./request-principal.js";

const Query = z.object({ path: z.string().min(1).max(4096).refine(isSafeUploadDirectory) }).strict();
export function createFileImportPreviewRoutes(options: {
  homePath: string;
  getPrincipal?: (c: Context) => RequestPrincipal;
}): Hono {
  const app = new Hono();
  app.get("/import-preview", async c => {
    if (!options.getPrincipal) return c.json({ error: "Import preview unavailable." }, 503);
    const parsed = Query.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "Invalid import selection." }, 400);
    try {
      options.getPrincipal(c);
      const path = resolveExistingFileApiPath(options.homePath, parsed.data.path);
      if (!path) return c.json({ error: "Import preview unavailable." }, 404);
      // Pin the regular file and read at most cap+1 even if it changes after stat.
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_IMPORT_PREVIEW_BYTES) return c.json({ error: "Import preview unavailable." }, 413);
        const bytes = Buffer.alloc(Math.min(info.size + 1, MAX_IMPORT_PREVIEW_BYTES + 1));
        let read = 0;
        while (read < bytes.length) {
          if (c.req.raw.signal.aborted) return c.json({ error: "Import preview unavailable." }, 408);
          const result = await handle.read(bytes, read, bytes.length - read, read);
          if (result.bytesRead === 0) break;
          read += result.bytesRead;
        }
        if (read > MAX_IMPORT_PREVIEW_BYTES) return c.json({ error: "Import preview unavailable." }, 413);
        const after = await handle.stat();
        if (read !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
          return c.json({ error: "Import preview unavailable." }, 409);
        }
        const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, read));
        const preview = parseSelectedImportPreview(basename(parsed.data.path), source);
        c.header("Cache-Control", "private, no-store");
        return c.json(preview);
      } finally { await handle.close(); }
    } catch (error: unknown) {
      if (isRequestPrincipalError(error)) {
        const mapped = mapRequestPrincipalError(error, "Import preview unavailable.");
        return c.json(mapped.body, mapped.status);
      }
      if (error instanceof ImportPreviewError || error instanceof TypeError) return c.json({ error: "Import preview unavailable." }, 400);
      if (error instanceof Error && "code" in error && ["ENOENT", "ELOOP"].includes(String(error.code))) {
        return c.json({ error: "Import preview unavailable." }, 404);
      }
      console.warn("[import-preview] read failed", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Import preview unavailable." }, 503);
    }
  });
  return app;
}
