import {
  stat as fsStat,
  mkdir,
  writeFile,
  rename,
  cp,
  access,
  readdir,
} from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { existsSync } from "node:fs";
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
  requestedPath: string,
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

export async function fileMkdir(
  homePath: string,
  requestedPath: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const resolved = resolveWithinHome(homePath, requestedPath);
  if (!resolved) return { ok: false, error: "Invalid path" };

  try {
    await mkdir(resolved, { recursive: true });
    return { ok: true, path: requestedPath };
  } catch {
    return { ok: false, error: "Failed to create directory" };
  }
}

export async function fileTouch(
  homePath: string,
  requestedPath: string,
  content = "",
): Promise<{ ok: boolean; path?: string; error?: string; status?: number }> {
  const resolved = resolveWithinHome(homePath, requestedPath);
  if (!resolved) return { ok: false, error: "Invalid path" };

  if (existsSync(resolved)) {
    return { ok: false, error: "File already exists", status: 409 };
  }

  try {
    const dir = dirname(resolved);
    await mkdir(dir, { recursive: true });
    await writeFile(resolved, content);
    return { ok: true, path: requestedPath };
  } catch {
    return { ok: false, error: "Failed to create file" };
  }
}

export async function fileRename(
  homePath: string,
  from: string,
  to: string,
): Promise<{ ok: boolean; error?: string; status?: number }> {
  const resolvedFrom = resolveWithinHome(homePath, from);
  const resolvedTo = resolveWithinHome(homePath, to);
  if (!resolvedFrom || !resolvedTo) return { ok: false, error: "Invalid path" };

  if (!existsSync(resolvedFrom)) {
    return { ok: false, error: "Source not found", status: 404 };
  }
  if (existsSync(resolvedTo)) {
    return { ok: false, error: "Destination already exists", status: 409 };
  }

  try {
    const dir = dirname(resolvedTo);
    await mkdir(dir, { recursive: true });
    await rename(resolvedFrom, resolvedTo);
    return { ok: true };
  } catch {
    return { ok: false, error: "Failed to rename" };
  }
}

export async function fileCopy(
  homePath: string,
  from: string,
  to: string,
): Promise<{ ok: boolean; error?: string; status?: number }> {
  const resolvedFrom = resolveWithinHome(homePath, from);
  const resolvedTo = resolveWithinHome(homePath, to);
  if (!resolvedFrom || !resolvedTo) return { ok: false, error: "Invalid path" };

  if (!existsSync(resolvedFrom)) {
    return { ok: false, error: "Source not found", status: 404 };
  }

  try {
    const dir = dirname(resolvedTo);
    await mkdir(dir, { recursive: true });
    await cp(resolvedFrom, resolvedTo, { recursive: true });
    return { ok: true };
  } catch {
    return { ok: false, error: "Failed to copy" };
  }
}

export async function fileDuplicate(
  homePath: string,
  requestedPath: string,
): Promise<{ ok: boolean; newPath?: string; error?: string; status?: number }> {
  const resolved = resolveWithinHome(homePath, requestedPath);
  if (!resolved) return { ok: false, error: "Invalid path" };

  if (!existsSync(resolved)) {
    return { ok: false, error: "Source not found", status: 404 };
  }

  const stats = await fsStat(resolved);
  const dir = dirname(requestedPath);
  const name = basename(requestedPath);

  let newName: string;
  if (stats.isDirectory()) {
    newName = `${name} copy`;
    let counter = 2;
    while (existsSync(join(dirname(resolved), newName))) {
      newName = `${name} copy ${counter}`;
      counter++;
    }
  } else {
    const ext = extname(name);
    const base = ext ? name.slice(0, -ext.length) : name;
    newName = ext ? `${base} copy${ext}` : `${base} copy`;
    let counter = 2;
    while (existsSync(join(dirname(resolved), newName))) {
      newName = ext ? `${base} copy ${counter}${ext}` : `${base} copy ${counter}`;
      counter++;
    }
  }

  const newPath = dir && dir !== "." ? `${dir}/${newName}` : newName;
  const resolvedNew = join(dirname(resolved), newName);

  try {
    await cp(resolved, resolvedNew, { recursive: true });
    return { ok: true, newPath };
  } catch {
    return { ok: false, error: "Failed to duplicate" };
  }
}
