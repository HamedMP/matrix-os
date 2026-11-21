/**
 * Spec 2701 "Private network and pairing": trust of the Tailscale identity
 * header. `tailscale serve` proxies tailnet requests to nginx on loopback and
 * adds `Tailscale-User-Login`; nginx forwards it to the gateway. The gateway
 * accepts it only from a loopback peer and only when it equals the owner login
 * recorded at install (or, failing that, the login this machine itself was
 * signed in with, recorded once). Any other value is rejected before routing.
 */
import { link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { Context, MiddlewareHandler } from "hono";
import type { PrivateNetworkAccessMode } from "./config.js";

export const TAILSCALE_USER_LOGIN_HEADER = "tailscale-user-login";
export const PRIVATE_NETWORK_IDENTITY_KEY = "privateNetworkOwnerIdentity";
export const OWNER_LOGIN_PATTERN = /^[A-Za-z0-9._%+@:-]{1,254}$/;

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const OWNER_FILE_MAX_BYTES = 4096;

export type TailscaleIdentityResult = "owner" | "none" | "rejected";

export function evaluateTailscaleIdentity(input: {
  accessMode: PrivateNetworkAccessMode | null;
  ownerLogin: string | null;
  remoteAddress: string | undefined;
  headerLogin: string | undefined;
}): TailscaleIdentityResult {
  if (input.accessMode !== "tailscale" && input.accessMode !== "headscale") return "none";
  if (input.headerLogin === undefined) return "none";
  if (input.remoteAddress === undefined || !LOOPBACK.has(input.remoteAddress)) return "rejected";
  if (!input.ownerLogin || input.headerLogin !== input.ownerLogin) return "rejected";
  return "owner";
}

export function remoteAddressOf(c: Context): string | undefined {
  return (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
}

export function readPrivateNetworkIdentity(c: Context): boolean {
  return c.get(PRIVATE_NETWORK_IDENTITY_KEY as never) === true;
}

export interface PrivateNetworkIdentityOptions {
  accessMode: PrivateNetworkAccessMode | null;
  ownerLogin(): Promise<string | null>;
  remoteAddress?(c: Context): string | undefined;
}

export function privateNetworkIdentityMiddleware(options: PrivateNetworkIdentityOptions): MiddlewareHandler {
  const remote = options.remoteAddress ?? remoteAddressOf;
  return async (c, next) => {
    const headerLogin = c.req.header(TAILSCALE_USER_LOGIN_HEADER);
    if (headerLogin === undefined || (options.accessMode !== "tailscale" && options.accessMode !== "headscale")) {
      c.set(PRIVATE_NETWORK_IDENTITY_KEY as never, false as never);
      return next();
    }
    let ownerLogin: string | null;
    try {
      ownerLogin = await options.ownerLogin();
    } catch (error: unknown) {
      console.error("[private-network] Owner login unavailable:", error instanceof Error ? error.name : "unknown");
      return c.json({ error: "Forbidden" }, 403);
    }
    const result = evaluateTailscaleIdentity({ accessMode: options.accessMode, ownerLogin, remoteAddress: remote(c), headerLogin });
    if (result === "rejected") return c.json({ error: "Forbidden" }, 403);
    c.set(PRIVATE_NETWORK_IDENTITY_KEY as never, (result === "owner") as never);
    return next();
  };
}

/**
 * Owner login: the install-time value from host.env wins. Otherwise a value the
 * gateway recorded once, from this machine's own Tailscale login, in an
 * owner-only file (exclusive create, never replaced).
 */
export class OwnerLoginStore {
  readonly installLogin: string | null;
  private readonly file: string;
  private cached: string | null = null;

  constructor(options: { homePath: string; installLogin: string | null | undefined }) {
    const login = options.installLogin?.trim();
    this.installLogin = login && OWNER_LOGIN_PATTERN.test(login) ? login : null;
    this.file = join(options.homePath, "system", "private-network", "owner.json");
  }

  async get(): Promise<string | null> {
    if (this.installLogin) return this.installLogin;
    if (this.cached) return this.cached;
    let raw: string;
    try {
      const info = await lstat(this.file);
      if (!info.isFile() || info.size > OWNER_FILE_MAX_BYTES) throw new Error("owner login file is not a regular bounded file");
      raw = await readFile(this.file, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const parsed = JSON.parse(raw) as { login?: unknown };
    if (typeof parsed.login !== "string" || !OWNER_LOGIN_PATTERN.test(parsed.login)) {
      throw new Error("owner login file is invalid");
    }
    this.cached = parsed.login;
    return parsed.login;
  }

  async recordIfMissing(login: string): Promise<string> {
    if (!OWNER_LOGIN_PATTERN.test(login)) throw new Error("invalid owner login");
    const existing = await this.get();
    if (existing) return existing;
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ login, recordedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
    try {
      // Atomic exclusive publish: a concurrent recorder that already won keeps its value.
      await link(temporary, this.file);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await unlink(temporary).catch((cleanupError: unknown) => {
        console.warn("[private-network] Temporary owner file cleanup failed:", cleanupError instanceof Error ? cleanupError.name : "unknown");
      });
    }
    this.cached = null;
    return (await this.get()) ?? login;
  }
}
