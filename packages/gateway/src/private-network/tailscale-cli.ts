/**
 * Bounded wrapper around the `tailscale` CLI for the self-host private network
 * panel (spec 2701). The installer runs `tailscale set --operator=<run user>`,
 * so the gateway can read status and start a login without root. No request
 * value ever becomes a CLI argument: arguments come from host.env config only.
 */
import { execFile, spawn as spawnChild } from "node:child_process";
import type { PrivateNetworkAccessMode } from "./config.js";

export type TailscaleState = "not-installed" | "logged-out" | "needs-login" | "stopped" | "connected" | "unavailable";

export interface TailscalePeer {
  name: string;
  dnsName: string;
  online: boolean;
}

export interface TailscaleSnapshot {
  state: TailscaleState;
  authUrl: string | null;
  ownerLogin: string | null;
  tailnet: string | null;
  self: { name: string; dnsName: string } | null;
  peers: TailscalePeer[];
}

export type TailscaleExec = (args: string[], options: { timeoutMs: number }) => Promise<{ stdout: string; stderr: string }>;

export interface TailscaleLoginProcess {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export type TailscaleSpawn = (args: string[]) => TailscaleLoginProcess;

const STATUS_TIMEOUT_MS = 10_000;
const DOWN_TIMEOUT_MS = 15_000;
const LOGIN_PROCESS_MAX_MS = 10 * 60_000;
const LOGIN_OUTPUT_MAX_CHARS = 64 * 1024;
const MAX_PEERS = 512;
const SAFE_TEXT = /[^A-Za-z0-9._%+@:-]/g;
const SAFE_ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" };

function text(value: unknown, max = 253): string {
  return typeof value === "string" ? value.replace(SAFE_TEXT, "").slice(0, max) : "";
}

function dns(value: unknown): string {
  return text(value).replace(/\.$/, "");
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function parseTailscaleStatus(raw: unknown): TailscaleSnapshot {
  const status = record(raw);
  const backend = typeof status.BackendState === "string" ? status.BackendState : "";
  const authUrl = typeof status.AuthURL === "string" && status.AuthURL ? status.AuthURL : null;
  const self = record(status.Self);
  const users = record(status.User);
  const user = record(users[String(self.UserID)]);
  const peers = Object.values(record(status.Peer)).slice(0, MAX_PEERS).map((value) => {
    const peer = record(value);
    return { name: text(peer.HostName, 63), dnsName: dns(peer.DNSName), online: peer.Online === true };
  }).filter((peer) => peer.dnsName);
  const state: TailscaleState = backend === "Running" ? "connected"
    : backend === "Stopped" ? "stopped"
      : backend === "NeedsLogin" || backend === "NoState" ? (authUrl ? "needs-login" : "logged-out")
        : "unavailable";
  const selfDns = dns(self.DNSName);
  return {
    state,
    authUrl,
    ownerLogin: text(user.LoginName) || null,
    tailnet: text(record(status.CurrentTailnet).Name) || null,
    self: selfDns ? { name: text(self.HostName, 63) || selfDns.split(".")[0], dnsName: selfDns } : null,
    peers,
  };
}

const defaultExec: (bin: string) => TailscaleExec = (bin) => (args, options) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024, env: SAFE_ENV }, (error, stdout, stderr) => {
    if (error) reject(error);
    else resolve({ stdout: String(stdout), stderr: String(stderr) });
  });
});

const defaultSpawn: (bin: string) => TailscaleSpawn = (bin) => (args) =>
  spawnChild(bin, args, { env: SAFE_ENV, stdio: ["ignore", "pipe", "pipe"] });

export interface TailscaleControllerOptions {
  accessMode: PrivateNetworkAccessMode | null;
  loginServer: string | null;
  operator: string | null;
  bin?: string;
  exec?: TailscaleExec;
  spawn?: TailscaleSpawn;
  /** How long `connect` waits for tailscale to print its login URL. */
  loginUrlWaitMs?: number;
}

export class TailscaleController {
  private readonly exec: TailscaleExec;
  private readonly spawn: TailscaleSpawn;
  private readonly loginUrlWaitMs: number;
  private readonly loginServerOrigin: string | null;
  private login: { child: TailscaleLoginProcess; timer: NodeJS.Timeout; url: string | null } | null = null;
  /** Bumped by disconnect/close: a connect started before it must not run `tailscale up`. */
  private generation = 0;
  /** Connects run one at a time so two requests cannot start two logins. */
  private connectQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: TailscaleControllerOptions) {
    const bin = options.bin ?? "/usr/bin/tailscale";
    this.exec = options.exec ?? defaultExec(bin);
    this.spawn = options.spawn ?? defaultSpawn(bin);
    this.loginUrlWaitMs = options.loginUrlWaitMs ?? 15_000;
    this.loginServerOrigin = options.loginServer ? originOf(options.loginServer) : null;
  }

  async status(): Promise<TailscaleSnapshot> {
    try {
      const { stdout } = await this.exec(["status", "--json"], { timeoutMs: STATUS_TIMEOUT_MS });
      if (stdout.length > 4 * 1024 * 1024) throw new Error("tailscale status output too large");
      return parseTailscaleStatus(JSON.parse(stdout));
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return emptySnapshot("not-installed");
      console.warn("[private-network] tailscale status failed:", error instanceof Error ? error.name : "unknown");
      return emptySnapshot("unavailable");
    }
  }

  /** Accepts only https login pages on the Tailscale or configured Headscale host. */
  isLoginUrl(candidate: string): boolean {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch (error: unknown) {
      if (error instanceof TypeError) return false;
      throw error;
    }
    if (url.protocol !== "https:" || url.username || url.password) return false;
    if (this.options.accessMode === "headscale") {
      // Login pages are served from the control server's origin, whatever its path.
      return this.loginServerOrigin !== null && url.origin === this.loginServerOrigin;
    }
    return url.origin === "https://login.tailscale.com";
  }

  connect(): Promise<{ state: TailscaleState; loginUrl: string | null }> {
    const generation = this.generation;
    const run = this.connectQueue.then(() => this.connectOnce(generation));
    this.connectQueue = run.catch((error: unknown) => {
      console.warn("[private-network] tailscale connect failed:", error instanceof Error ? error.name : "unknown");
    });
    return run;
  }

  private async connectOnce(generation: number): Promise<{ state: TailscaleState; loginUrl: string | null }> {
    const cancelled = { state: "stopped" as const, loginUrl: null };
    if (generation !== this.generation) return cancelled;
    const before = await this.status();
    // The owner disconnected (or the gateway is closing) while status was read.
    if (generation !== this.generation) return cancelled;
    if (before.state === "connected" || before.state === "not-installed" || before.state === "unavailable") {
      return { state: before.state, loginUrl: null };
    }
    if (before.authUrl && this.isLoginUrl(before.authUrl)) return { state: "needs-login", loginUrl: before.authUrl };
    if (this.login && this.login.child.exitCode === null) {
      return { state: this.login.url ? "needs-login" : before.state, loginUrl: this.login.url };
    }
    const args = ["up"];
    if (this.options.operator) args.push(`--operator=${this.options.operator}`);
    if (this.options.accessMode === "headscale" && this.options.loginServer) args.push(`--login-server=${this.options.loginServer}`);
    args.push("--timeout=600s");
    const url = await this.startLogin(args);
    if (generation !== this.generation) return cancelled;
    if (url) return { state: "needs-login", loginUrl: url };
    const after = await this.status();
    if (generation !== this.generation) return cancelled;
    return { state: after.state, loginUrl: after.authUrl && this.isLoginUrl(after.authUrl) ? after.authUrl : null };
  }

  async disconnect(): Promise<void> {
    this.generation += 1;
    this.stopLogin();
    await this.exec(["down"], { timeoutMs: DOWN_TIMEOUT_MS });
  }

  close(): void {
    this.generation += 1;
    this.stopLogin();
  }

  private stopLogin(): void {
    if (!this.login) return;
    clearTimeout(this.login.timer);
    if (this.login.child.exitCode === null) this.login.child.kill("SIGTERM");
    this.login = null;
  }

  private startLogin(args: string[]): Promise<string | null> {
    const child = this.spawn(args);
    const timer = setTimeout(() => this.stopLogin(), LOGIN_PROCESS_MAX_MS);
    timer.unref?.();
    const login = { child, timer, url: null as string | null };
    this.login = login;
    return new Promise((resolve) => {
      let output = "";
      let settled = false;
      const finish = (url: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(wait);
        resolve(url);
      };
      const wait = setTimeout(() => finish(null), this.loginUrlWaitMs);
      const onData = (chunk: Buffer | string) => {
        if (output.length >= LOGIN_OUTPUT_MAX_CHARS) return;
        output += String(chunk).slice(0, LOGIN_OUTPUT_MAX_CHARS - output.length);
        for (const match of output.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
          if (this.isLoginUrl(match[0])) {
            login.url = match[0];
            finish(match[0]);
            return;
          }
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.once("error", (error) => {
        console.warn("[private-network] tailscale login failed to start:", error.name);
        finish(null);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        if (this.login === login) this.login = null;
        finish(login.url);
      });
    });
  }
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

function emptySnapshot(state: TailscaleState): TailscaleSnapshot {
  return { state, authUrl: null, ownerLogin: null, tailnet: null, self: null, peers: [] };
}
