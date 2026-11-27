// The Dock icon of an installed app's shim (spec 2711, layer 3): the app's
// shipped `/icons/<slug>.png` from the gateway, converted once with the
// system `sips` and `iconutil` (no shell, one 10 s budget), or Matrix's own
// icon when the app has no PNG or anything fails.
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MAX_ICON_BYTES = 2 * 1024 * 1024;
const MAX_ICNS_BYTES = 16 * 1024 * 1024;
const ICON_TIMEOUT_MS = 10_000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// The sizes `iconutil` expects in an `.iconset`.
const ICONSET: ReadonlyArray<readonly [string, number]> = [16, 32, 128, 256, 512].flatMap((size) => [
  [`icon_${size}x${size}.png`, size] as const,
  [`icon_${size}x${size}@2x.png`, size * 2] as const,
]);

export type ExecFileFn = (file: string, args: readonly string[], options: { signal: AbortSignal }) => Promise<unknown>;

function logFailure(label: string, error: unknown): void {
  console.warn(`[installed-apps] ${label}:`, error instanceof Error ? error.name : "UnknownError");
}

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** The app's PNG icon, or null for anything else (failed, redirected, not a PNG, too large). */
export async function fetchGatewayIcon(options: {
  fetchFn: (url: string, init: RequestInit) => Promise<Response>;
  gatewayOrigin: string;
  token: string | null;
  slug: string;
}): Promise<Uint8Array | null> {
  if (!SLUG.test(options.slug)) return null;
  try {
    const url = new URL(`/icons/${options.slug}.png`, options.gatewayOrigin).toString();
    const response = await options.fetchFn(url, {
      headers: options.token ? { Authorization: `Bearer ${options.token}` } : {},
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(ICON_TIMEOUT_MS),
    });
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || !type.toLowerCase().startsWith("image/png")) {
      await response.body?.cancel();
      return null;
    }
    const bytes = await readCapped(response, MAX_ICON_BYTES);
    return bytes && isPng(bytes) ? bytes : null;
  } catch (error: unknown) {
    logFailure("app icon unavailable", error);
    return null;
  }
}

async function readIcns(path: string): Promise<Uint8Array> {
  if ((await stat(path)).size > MAX_ICNS_BYTES) throw new RangeError("icon too large");
  return new Uint8Array(await readFile(path));
}

async function convert(png: Uint8Array, scratch: string, execFile: ExecFileFn): Promise<Uint8Array> {
  const signal = AbortSignal.timeout(ICON_TIMEOUT_MS);
  const source = join(scratch, "source.png");
  const iconset = join(scratch, "app.iconset");
  const output = join(scratch, "app.icns");
  await writeFile(source, png, { flag: "wx" });
  await mkdir(iconset);
  for (const [name, pixels] of ICONSET) {
    await execFile("/usr/bin/sips", ["-s", "format", "png", "-z", String(pixels), String(pixels), source, "--out", join(iconset, name)], { signal });
  }
  await execFile("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", output], { signal });
  return readIcns(output);
}

/** `.icns` bytes for a shim: the converted PNG, else the Matrix icon at `fallbackIcnsPath`. */
export async function buildShimIcon(options: {
  png: Uint8Array | null;
  fallbackIcnsPath: string;
  execFile: ExecFileFn;
  /** Parent of the per-install scratch directory, which is always removed. */
  tmpDir: string;
}): Promise<Uint8Array> {
  if (options.png && isPng(options.png)) {
    let scratch: string | null = null;
    try {
      await mkdir(options.tmpDir, { recursive: true });
      scratch = await mkdtemp(join(options.tmpDir, "matrix-app-icon-"));
      return await convert(options.png, scratch, options.execFile);
    } catch (error: unknown) {
      logFailure("app icon conversion failed; using the Matrix icon", error);
    } finally {
      if (scratch) {
        await rm(scratch, { recursive: true, force: true })
          .catch((error: unknown) => logFailure("icon scratch cleanup failed", error));
      }
    }
  }
  return readIcns(options.fallbackIcnsPath);
}
