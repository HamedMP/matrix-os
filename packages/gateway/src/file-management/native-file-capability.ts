import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type NativeFileCapabilityCode =
  | "ok"
  | "destination_conflict"
  | "source_missing"
  | "invalid_path"
  | "cross_device"
  | "limit_exceeded"
  | "partial"
  | "unsupported_platform"
  | "failed";

export interface NativeFileCapabilityResult {
  ok: boolean;
  code: NativeFileCapabilityCode;
}

export interface NativeFileCapability {
  create(
    homePath: string,
    relativePath: string,
    kind: "file" | "directory",
    content: string,
    createParents: boolean,
    allowExisting: boolean,
  ): Promise<NativeFileCapabilityResult>;
  copy(
    homePath: string,
    sourcePath: string,
    targetPath: string,
    createParents: boolean,
  ): Promise<NativeFileCapabilityResult>;
  move(
    homePath: string,
    sourcePath: string,
    targetPath: string,
    createParents: boolean,
  ): Promise<NativeFileCapabilityResult>;
}

interface NativeAddon {
  create(
    homePath: string,
    relativePath: string,
    directory: boolean,
    content: string,
    createParents: boolean,
    allowExisting: boolean,
  ): Promise<NativeFileCapabilityResult>;
  copy(homePath: string, sourcePath: string, targetPath: string, createParents: boolean): Promise<NativeFileCapabilityResult>;
  move(homePath: string, sourcePath: string, targetPath: string, createParents: boolean): Promise<NativeFileCapabilityResult>;
}

export class NativeFileCapabilityUnavailableError extends Error {
  readonly code = "unsupported_platform";

  constructor(message = "Native file-management capability is unavailable") {
    super(message);
    this.name = "NativeFileCapabilityUnavailableError";
  }
}

function hasGlibcRuntime(): boolean {
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } };
  const header = report.header ?? {};
  return typeof header.glibcVersionRuntime === "string" && header.glibcVersionRuntime.length > 0;
}

export function isNativeFileCapabilityTarget(): boolean {
  return process.platform === "linux" && process.arch === "x64" && hasGlibcRuntime();
}

let cachedCapability: NativeFileCapability | undefined;

function loadAddon(): NativeAddon {
  if (!isNativeFileCapabilityTarget()) throw new NativeFileCapabilityUnavailableError();
  const candidates = [
    new URL("../../dist/native/linux-x64-glibc/matrix-fs.node", import.meta.url),
    new URL("../native/linux-x64-glibc/matrix-fs.node", import.meta.url),
  ];
  const addonUrl = candidates.find((candidate) => existsSync(fileURLToPath(candidate)));
  if (!addonUrl) throw new NativeFileCapabilityUnavailableError("Native file-management binary is missing");
  try {
    return createRequire(import.meta.url)(fileURLToPath(addonUrl)) as NativeAddon;
  } catch (error: unknown) {
    console.error("[file-ops] Native file-management binary failed to load:", error instanceof Error ? error.message : String(error));
    throw new NativeFileCapabilityUnavailableError("Native file-management binary could not be loaded");
  }
}

export function getNativeFileCapability(): NativeFileCapability {
  if (cachedCapability) return cachedCapability;
  const addon = loadAddon();
  cachedCapability = {
    create: (homePath, relativePath, kind, content, createParents, allowExisting) =>
      addon.create(homePath, relativePath, kind === "directory", content, createParents, allowExisting),
    copy: (homePath, sourcePath, targetPath, createParents) =>
      addon.copy(homePath, sourcePath, targetPath, createParents),
    move: (homePath, sourcePath, targetPath, createParents) =>
      addon.move(homePath, sourcePath, targetPath, createParents),
  };
  return cachedCapability;
}
