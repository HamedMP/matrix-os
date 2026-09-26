import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AiProviderLocalObservation } from "@matrix-os/contracts";

type Harness = "pi" | "opencode";
type ObjectValue = Record<string, unknown>;
const MAX_BYTES = 128 * 1024;
const OBSERVATION_TTL_MS = 5_000;
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as ObjectValue : null;
const within = (home: string, path: string) => { const value = relative(home, path); return value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value); };

/** Fixed owner-local metadata reads. Credential values never leave this reader. */
async function readObject(home: string, path: string): Promise<ObjectValue | null> {
  try {
    const root = await realpath(home);
    if (!within(resolve(home), resolve(path))) return null;
    const parts = relative(resolve(home), resolve(path)).split(sep);
    if (parts.length > 32) return null;
    let parent = resolve(home);
    for (const [index, part] of parts.entries()) {
      parent = join(parent, part);
      const stat = await lstat(parent);
      if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) return null;
    }
    const canonical = await realpath(path);
    if (!within(root, canonical)) return null;
    const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) return null;
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      const result = await file.read(bytes, 0, bytes.length, 0);
      if (result.bytesRead > MAX_BYTES) return null;
      return object(JSON.parse(bytes.subarray(0, result.bytesRead).toString("utf8")));
    } finally { await file.close(); }
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn("[provider-settings] Native profile metadata unavailable", { errorClass: error instanceof Error ? error.name : "Unknown" });
    }
    return null;
  }
}

async function hasUnsupportedDefaultFile(directory: string): Promise<boolean> {
  for (const name of ["opencode.jsonc", "config"]) {
    try { await lstat(join(directory, name)); return true; }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.warn("[provider-settings] Native default metadata unavailable", { errorClass: error instanceof Error ? error.name : "Unknown" });
        return true;
      }
    }
  }
  return false;
}

function present(harness: Harness, value: unknown): boolean {
  const credential = object(value);
  if (!credential) return false;
  const key = credential.key;
  if (credential.type === (harness === "pi" ? "api_key" : "api")) {
    // Pi permits shell commands/environment references here. Observing those is
    // not observing a credential; never execute or resolve them during discovery.
    return typeof key === "string" && key.trim().length > 0 && !key.startsWith("!") && !key.includes("$");
  }
  return credential.type === "oauth" && typeof credential.access === "string" && credential.access.length > 0
    && typeof credential.refresh === "string" && credential.refresh.length > 0
    && typeof credential.expires === "number" && Number.isFinite(credential.expires);
}

async function readGenericNativeProfile(input: {
  homePath: string; harness: Harness; providerIds: readonly string[]; env: Record<string, string>; now: Date;
}): Promise<{ defaultModel: string | null; observations: Record<string, AiProviderLocalObservation> }> {
  const { homePath, harness, env, now } = input;
  const configDirectory = harness === "pi" ? join(homePath, ".pi", "agent")
    : join(env.XDG_CONFIG_HOME || join(homePath, ".config"), "opencode");
  const dataDirectory = harness === "pi" ? configDirectory
    : join(env.XDG_DATA_HOME || join(homePath, ".local", "share"), "opencode");
  const [config, credentials, ambiguousDefault] = await Promise.all([
    readObject(homePath, join(configDirectory, harness === "pi" ? "settings.json" : "opencode.json")),
    readObject(homePath, join(dataDirectory, "auth.json")),
    harness === "opencode" ? hasUnsupportedDefaultFile(configDirectory) : Promise.resolve(false),
  ]);
  // Unsupported/JSONC/ambiguous defaults remain unbound rather than guessing a
  // provider from model-listing order. Project overrides are never inferred.
  let defaultModel: string | null = null;
  if (harness === "pi" && typeof config?.defaultProvider === "string" && typeof config.defaultModel === "string") {
    defaultModel = `${config.defaultProvider}:${config.defaultModel}`;
  } else if (harness === "opencode" && !ambiguousDefault && typeof config?.model === "string") {
    const slash = config.model.indexOf("/");
    if (slash > 0) defaultModel = `${config.model.slice(0, slash)}:${config.model.slice(slash + 1)}`;
  }
  const observations: Record<string, AiProviderLocalObservation> = {};
  for (const provider of input.providerIds.slice(0, 24)) observations[provider] = {
    state: credentials === null ? "unknown" : present(harness, credentials[provider]) ? "present_unverified" : "absent",
    checkedAt: now.toISOString(), staleAfter: new Date(now.getTime() + OBSERVATION_TTL_MS).toISOString(),
  };
  return { defaultModel, observations };
}

/** One unfinished owner/source-bound metadata read; timeouts never create a new parallel read. */
export function createGenericNativeProfileObserver(
  read: typeof readGenericNativeProfile = readGenericNativeProfile,
) {
  let pending: Promise<Awaited<ReturnType<typeof readGenericNativeProfile>>> | null = null;
  let pendingScope = "";
  return async (input: Parameters<typeof readGenericNativeProfile>[0]) => {
    if ([input.homePath, input.env.XDG_CONFIG_HOME ?? "", input.env.XDG_DATA_HOME ?? ""].some((value) => value.length > 4096))
      return { defaultModel: null, observations: {} };
    const scope = JSON.stringify([input.homePath, input.harness, input.env.XDG_CONFIG_HOME, input.env.XDG_DATA_HOME, input.providerIds.slice(0, 24)]);
    if (pending && pendingScope !== scope) return { defaultModel: null, observations: {} };
    if (!pending) {
      pendingScope = scope;
      pending = read(input).finally(() => { pending = null; pendingScope = ""; });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([pending, new Promise<Awaited<ReturnType<typeof readGenericNativeProfile>>>((resolve) => {
        timer = setTimeout(() => resolve({ defaultModel: null, observations: {} }), 1000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
}

/** Standalone bounded read for callers without a long-lived catalog. */
export async function observeGenericNativeProfile(input: Parameters<typeof readGenericNativeProfile>[0]) {
  return createGenericNativeProfileObserver()(input);
}
