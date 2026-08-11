import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { FileChangeEvent } from "../watcher.js";
import { resolveWithinHome } from "../path-security.js";
import { FileManagementDirectoryPathSchema } from "./contracts.js";
import { isFileManagementParentAllowed } from "./policy.js";

export const FILE_DIRECTORY_MAX_SUBSCRIPTIONS = 1_024;
export const FILE_DIRECTORY_MAX_DIRECTORIES_PER_CONNECTION = 8;
export const FILE_DIRECTORY_MAX_CONNECTIONS_PER_OWNER = 32;
export const FILE_DIRECTORY_STALE_TTL_MS = 5 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export interface FileDirectorySubscriber {
  ownerId: string;
  connectionId: string;
  directory: string;
  send: (message: string) => void | boolean;
}

export interface FileDirectoryAuthorization {
  ownerId: string;
  directory: string;
}

export interface FileDirectorySubscriptionHubOptions {
  acquireScope: (directory: string) => (() => void | Promise<void>) | Promise<() => void | Promise<void>>;
  authorize?: (input: FileDirectoryAuthorization) => boolean | Promise<boolean>;
  maxSubscriptions?: number;
  maxDirectoriesPerConnection?: number;
  maxConnectionsPerOwner?: number;
  staleTtlMs?: number;
  sweepIntervalMs?: number;
  now?: () => number;
}

interface SubscriptionState extends FileDirectorySubscriber {
  revision: number;
  lastTouched: number;
  canceled: boolean;
  release: (() => void | Promise<void>) | null;
  scopeReady: Promise<void> | null;
  cleanupPromise: Promise<void> | null;
}

function subscriptionKey(ownerId: string, connectionId: string, directory: string): string {
  return JSON.stringify([ownerId, connectionId, directory]);
}

function safeErrorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

async function releaseScope(subscription: SubscriptionState): Promise<void> {
  const release = subscription.release;
  if (!release) return;
  subscription.release = null;
  try {
    await release();
  } catch (error: unknown) {
    console.error("[files/realtime] Directory scope release failed", {
      ownerId: subscription.ownerId,
      connectionId: subscription.connectionId,
      directory: subscription.directory,
      errorKind: safeErrorKind(error),
    });
  }
}

export async function authorizeFileDirectory(
  homePath: string,
  directory: string,
): Promise<boolean> {
  const parsed = FileManagementDirectoryPathSchema.safeParse(directory);
  if (!parsed.success
    || /^[a-zA-Z]:\//.test(parsed.data)
    || parsed.data.split("/").some((segment) => segment.startsWith("."))
    || !isFileManagementParentAllowed(homePath, parsed.data)) return false;
  const resolved = resolveWithinHome(homePath, parsed.data);
  if (!resolved) return false;
  const stats = await lstat(resolved);
  if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
  const [homeReal, directoryReal] = await Promise.all([
    realpath(resolve(homePath)),
    realpath(resolved),
  ]);
  const realRelative = relative(homeReal, directoryReal);
  return realRelative === "" || (!realRelative.startsWith("..") && !isAbsolute(realRelative));
}

export class FileDirectorySubscriptionHub {
  private readonly subscriptions = new Map<string, SubscriptionState>();
  private readonly acquireScope: FileDirectorySubscriptionHubOptions["acquireScope"];
  private readonly authorize?: FileDirectorySubscriptionHubOptions["authorize"];
  private readonly maxSubscriptions: number;
  private readonly maxDirectoriesPerConnection: number;
  private readonly maxConnectionsPerOwner: number;
  private readonly staleTtlMs: number;
  private readonly now: () => number;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: FileDirectorySubscriptionHubOptions) {
    this.acquireScope = options.acquireScope;
    this.authorize = options.authorize;
    this.maxSubscriptions = options.maxSubscriptions ?? FILE_DIRECTORY_MAX_SUBSCRIPTIONS;
    this.maxDirectoriesPerConnection = options.maxDirectoriesPerConnection
      ?? FILE_DIRECTORY_MAX_DIRECTORIES_PER_CONNECTION;
    this.maxConnectionsPerOwner = options.maxConnectionsPerOwner
      ?? FILE_DIRECTORY_MAX_CONNECTIONS_PER_OWNER;
    this.staleTtlMs = options.staleTtlMs ?? FILE_DIRECTORY_STALE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.sweepTimer = setInterval(() => {
      void this.sweepStale().catch((error: unknown) => {
        console.error("[files/realtime] Stale subscription sweep failed", {
          errorKind: safeErrorKind(error),
        });
      });
    }, options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  get subscriberCount(): number {
    return this.subscriptions.size;
  }

  async subscribe(subscriber: FileDirectorySubscriber): Promise<number> {
    if (this.closed) throw new Error("Directory subscription hub is closed");
    const parsed = FileManagementDirectoryPathSchema.safeParse(subscriber.directory);
    if (!parsed.success) throw new Error("Invalid directory subscription");
    const normalizedSubscriber = { ...subscriber, directory: parsed.data };
    const key = subscriptionKey(subscriber.ownerId, subscriber.connectionId, parsed.data);
    const existingBeforeSweep = this.subscriptions.get(key);
    if (existingBeforeSweep && !existingBeforeSweep.canceled) {
      return this.resumeSubscription(key, existingBeforeSweep, subscriber.send);
    }

    await this.sweepStale();
    if (this.closed) throw new Error("Directory subscription hub is closed");
    const existing = this.subscriptions.get(key);
    if (existing) {
      if (!existing.canceled) return this.resumeSubscription(key, existing, subscriber.send);
      await this.cleanupSubscription(existing);
      if (this.closed) throw new Error("Directory subscription hub is closed");
      const replacement = this.subscriptions.get(key);
      if (replacement) {
        if (!replacement.canceled) {
          return this.resumeSubscription(key, replacement, subscriber.send);
        }
        return this.subscribe(normalizedSubscriber);
      }
    }
    this.assertCapacity(normalizedSubscriber);
    const state: SubscriptionState = {
      ...normalizedSubscriber,
      revision: 0,
      lastTouched: this.now(),
      canceled: false,
      release: null,
      scopeReady: null,
      cleanupPromise: null,
    };
    this.subscriptions.set(key, state);
    const scopeReady = this.initializeSubscription(key, state);
    state.scopeReady = scopeReady;
    try {
      await scopeReady;
      this.assertCurrent(key, state);
      return state.revision;
    } catch (error: unknown) {
      await this.cleanupSubscription(state);
      throw error;
    }
  }

  touch(ownerId: string, connectionId: string, directory: string): boolean {
    if (this.closed) return false;
    const subscription = this.subscriptions.get(subscriptionKey(ownerId, connectionId, directory));
    if (!subscription || subscription.canceled || !subscription.release) return false;
    subscription.lastTouched = this.now();
    return true;
  }

  async unsubscribe(ownerId: string, connectionId: string, directory: string): Promise<boolean> {
    const key = subscriptionKey(ownerId, connectionId, directory);
    const subscription = this.subscriptions.get(key);
    if (!subscription) return false;
    await this.cleanupSubscription(subscription);
    return true;
  }

  async removeConnection(ownerId: string, connectionId: string): Promise<void> {
    const removed: SubscriptionState[] = [];
    for (const [key, subscription] of this.subscriptions) {
      if (subscription.ownerId === ownerId && subscription.connectionId === connectionId) {
        removed.push(subscription);
      }
    }
    await Promise.all(removed.map((subscription) => this.cleanupSubscription(subscription)));
  }

  async broadcast(change: FileChangeEvent): Promise<void> {
    if (this.closed) return;
    const directory = posix.dirname(change.path) === "." ? "" : posix.dirname(change.path);
    const entry = posix.basename(change.path);
    if (!entry || entry.startsWith(".") || entry === "/") return;
    const failed: SubscriptionState[] = [];

    for (const subscription of this.subscriptions.values()) {
      if (subscription.canceled || !subscription.release || subscription.directory !== directory) continue;
      const revision = subscription.revision + 1;
      try {
        const sent = subscription.send(JSON.stringify({
          type: "files:change",
          directory,
          entry,
          event: change.event,
          revision,
        }));
        if (sent === false) throw new Error("WebSocket send rejected");
        subscription.revision = revision;
        subscription.lastTouched = this.now();
      } catch (error: unknown) {
        console.error("[files/realtime] Change delivery failed", {
          ownerId: subscription.ownerId,
          connectionId: subscription.connectionId,
          directory: subscription.directory,
          errorKind: safeErrorKind(error),
        });
        failed.push(subscription);
      }
    }

    for (const subscription of failed) {
      subscription.canceled = true;
    }
    await Promise.all(failed.map((subscription) => this.cleanupSubscription(subscription)));
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    clearInterval(this.sweepTimer);
    const subscriptions = [...this.subscriptions.values()];
    const cleanups = subscriptions.map((subscription) => this.cleanupSubscription(subscription));
    this.closePromise = (async () => {
      for (const subscription of subscriptions) {
        try {
          subscription.send(JSON.stringify({ type: "files:shutdown" }));
        } catch (error: unknown) {
          console.error("[files/realtime] Shutdown notice failed", {
            ownerId: subscription.ownerId,
            connectionId: subscription.connectionId,
            directory: subscription.directory,
            errorKind: safeErrorKind(error),
          });
        }
      }
      await Promise.allSettled(cleanups);
    })();
    return this.closePromise;
  }

  private assertCapacity(subscriber: FileDirectorySubscriber): void {
    if (this.subscriptions.size >= this.maxSubscriptions) {
      throw new Error("Directory subscription limit reached");
    }
    let connectionDirectories = 0;
    const ownerConnections: string[] = [];
    for (const existing of this.subscriptions.values()) {
      if (existing.ownerId === subscriber.ownerId && existing.connectionId === subscriber.connectionId) {
        connectionDirectories += 1;
      }
      if (existing.ownerId === subscriber.ownerId && !ownerConnections.includes(existing.connectionId)) {
        ownerConnections.push(existing.connectionId);
      }
    }
    if (connectionDirectories >= this.maxDirectoriesPerConnection) {
      throw new Error("Directory limit reached for connection");
    }
    if (!ownerConnections.includes(subscriber.connectionId)
      && ownerConnections.length >= this.maxConnectionsPerOwner) {
      throw new Error("Connection limit reached for owner");
    }
  }

  private async sweepStale(): Promise<void> {
    if (this.closed) return;
    const cutoff = this.now() - this.staleTtlMs;
    const stale: SubscriptionState[] = [];
    for (const subscription of this.subscriptions.values()) {
      if (subscription.lastTouched <= cutoff) {
        stale.push(subscription);
      }
    }
    await Promise.all(stale.map((subscription) => this.cleanupSubscription(subscription)));
  }

  private cleanupSubscription(subscription: SubscriptionState): Promise<void> {
    subscription.canceled = true;
    if (subscription.cleanupPromise) return subscription.cleanupPromise;
    const key = subscriptionKey(
      subscription.ownerId,
      subscription.connectionId,
      subscription.directory,
    );
    subscription.cleanupPromise = (async () => {
      if (subscription.scopeReady) await Promise.allSettled([subscription.scopeReady]);
      await releaseScope(subscription);
      if (this.subscriptions.get(key) === subscription) this.subscriptions.delete(key);
    })();
    return subscription.cleanupPromise;
  }

  private assertCurrent(key: string, state: SubscriptionState): void {
    if (this.closed) throw new Error("Directory subscription hub is closed");
    if (state.canceled || this.subscriptions.get(key) !== state) {
      throw new Error("Directory subscription is no longer active");
    }
  }

  private async initializeSubscription(
    key: string,
    state: SubscriptionState,
  ): Promise<void> {
    if (this.authorize) {
      const authorized = await this.authorize({
        ownerId: state.ownerId,
        directory: state.directory,
      });
      this.assertCurrent(key, state);
      if (!authorized) throw new Error("Directory subscription is not authorized");
    }
    const release = await this.acquireScope(state.directory);
    state.release = release;
    try {
      this.assertCurrent(key, state);
    } catch (error: unknown) {
      await releaseScope(state);
      throw error;
    }
  }

  private async resumeSubscription(
    key: string,
    existing: SubscriptionState,
    send: FileDirectorySubscriber["send"],
  ): Promise<number> {
    const wasActive = existing.release !== null;
    existing.lastTouched = this.now();
    existing.send = send;
    if (existing.scopeReady) await existing.scopeReady;
    this.assertCurrent(key, existing);
    if (wasActive && this.authorize) {
      const authorized = await this.authorize({
        ownerId: existing.ownerId,
        directory: existing.directory,
      });
      this.assertCurrent(key, existing);
      if (!authorized) throw new Error("Directory subscription is not authorized");
    }
    return existing.revision;
  }
}
