import { readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { writeUtf8FileAtomic } from "./atomic-write.js";
import { shellError } from "./errors.js";
import { validateLayoutName } from "./names.js";

export interface LayoutAdapter {
  validateLayout(path: string): Promise<void>;
}

export interface LayoutStoreOptions {
  homePath: string;
  adapter: LayoutAdapter;
  maxBytes?: number;
  layoutsDir?: string;
}

export interface LayoutMetadata {
  name: string;
  modifiedAt: string;
}

export class LayoutStore {
  private readonly layoutsDir: string;
  private readonly maxBytes: number;

  constructor(private readonly options: LayoutStoreOptions) {
    this.layoutsDir = options.layoutsDir ?? join(options.homePath, "system", "layouts");
    this.maxBytes = options.maxBytes ?? 100_000;
  }

  async list(): Promise<LayoutMetadata[]> {
    try {
      const files = await readdir(this.layoutsDir);
      const layouts = await Promise.all(
        files
          .filter((file) => file.endsWith(".kdl"))
          .map(async (file) => {
            const info = await stat(join(this.layoutsDir, file));
            return {
              name: file.slice(0, -4),
              modifiedAt: info.mtime.toISOString(),
            };
          }),
      );
      return layouts.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return [];
      }
      throw err;
    }
  }

  async show(name: string): Promise<{ name: string; kdl: string }> {
    const safeName = validateLayoutName(name);
    try {
      return {
        name: safeName,
        kdl: await readFile(this.pathFor(safeName), "utf-8"),
      };
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        throw shellError("layout_not_found", "Layout not found", 404);
      }
      throw err;
    }
  }

  async save(name: string, kdl: string): Promise<void> {
    const safeName = validateLayoutName(name);
    if (Buffer.byteLength(kdl) > this.maxBytes) {
      throw shellError("layout_too_large", "Layout is too large", 413);
    }

    const tmp = join(
      this.layoutsDir,
      `.${safeName}.${randomBytes(8).toString("hex")}.tmp-${process.pid}`,
    );
    try {
      await writeUtf8FileAtomic(tmp, kdl);
      await this.options.adapter.validateLayout(tmp);
      await rename(tmp, this.pathFor(safeName));
    } catch (err) {
      await unlink(tmp).catch((cleanupErr: unknown) => {
        if (
          !(cleanupErr instanceof Error) ||
          !("code" in cleanupErr) ||
          (cleanupErr as NodeJS.ErrnoException).code !== "ENOENT"
        ) {
          console.warn(
            "[shell] failed to clean layout validation temp file:",
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          );
        }
      });
      if (err instanceof Error && "code" in err && "safeMessage" in err) {
        throw err;
      }
      throw shellError("invalid_layout", "Invalid layout", 400);
    }
  }

  async delete(name: string): Promise<void> {
    const safeName = validateLayoutName(name);
    await rm(this.pathFor(safeName), { force: true });
  }

  private pathFor(name: string): string {
    return join(this.layoutsDir, `${name}.kdl`);
  }
}
