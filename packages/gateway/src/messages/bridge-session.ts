import { lstat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod/v4";
import { MessagingBridgeSessionSchema, type MessagingBridgeSession } from "@matrix-os/contracts/messaging-bridge";
import { readBoundedJsonFileWithIdentity } from "../bounded-json-file.js";
import { writeProviderJsonAtomic } from "../ai-providers/provider-settings-persistence.js";
import { errorName } from "./bridge-http.js";
import { MatrixUnauthorizedError } from "./bridge-matrix-client.js";
import type { MessagingBridgePlatformClient } from "./bridge-platform-client.js";

/**
 * The owner's homeserver session lives in the owner secret store: the private
 * root next to (never inside) the owner home, where provider secrets live, so
 * no `/files/*` route, copy, export or home sync can reach it. It uses the
 * same atomic 0600 writer as provider credentials. The access token never
 * leaves this module except as a request header to the homeserver.
 */

const PRIVATE_DIRECTORY = ".matrix-private";

const SESSION_FILE_LIMIT_BYTES = 8 * 1024;
const SessionDocumentSchema = z.object({
  version: z.literal(1),
  ownerId: z.string().min(1).max(256),
  session: MessagingBridgeSessionSchema,
}).strict();

export interface BridgeSessionStore {
  read(ownerId: string): Promise<MessagingBridgeSession | null>;
  write(ownerId: string, session: MessagingBridgeSession): Promise<void>;
}

export class BridgeSessionUnavailableError extends Error {
  constructor() {
    super("Messaging bridge session unavailable");
    this.name = "BridgeSessionUnavailableError";
  }
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

export function bridgeSessionPath(options: { homePath: string; privateRootPath?: string }): string {
  const homePath = resolve(options.homePath);
  const privateRoot = resolve(options.privateRootPath ?? join(dirname(homePath), PRIVATE_DIRECTORY, basename(homePath)));
  if (privateRoot === homePath || privateRoot.startsWith(`${homePath}/`)) {
    throw new Error("Messaging bridge session storage must be outside the owner home");
  }
  return join(privateRoot, "messaging-bridge-session.json");
}

export function createFileBridgeSessionStore(options: { homePath: string; privateRootPath?: string }): BridgeSessionStore {
  const path = bridgeSessionPath(options);
  return {
    async read(ownerId) {
      let metadata;
      try {
        metadata = await lstat(path);
      } catch (err: unknown) {
        if (isMissing(err)) return null;
        throw err;
      }
      const uid = process.getuid?.();
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
        || (uid !== undefined && metadata.uid !== uid) || (metadata.mode & 0o077) !== 0) {
        console.warn("[messages/bridge-session] refusing unsafe session file");
        return null;
      }
      const document = await readBoundedJsonFileWithIdentity(path, SESSION_FILE_LIMIT_BYTES);
      const parsed = SessionDocumentSchema.safeParse(document?.value);
      if (!parsed.success) {
        console.warn("[messages/bridge-session] stored session is invalid");
        return null;
      }
      return parsed.data.ownerId === ownerId ? parsed.data.session : null;
    },
    async write(ownerId, session) {
      await writeProviderJsonAtomic(path, SessionDocumentSchema.parse({ version: 1, ownerId, session }));
    },
  };
}

export interface BridgeSessionProvider {
  /** Stored session, minting one through the platform when none exists. */
  current(): Promise<MessagingBridgeSession>;
  /** Stored session only; never calls the platform. */
  stored(): Promise<MessagingBridgeSession | null>;
  /** Runs `fn`; on a homeserver 401 requests one new session and retries once. */
  withSession<T>(fn: (session: MessagingBridgeSession) => Promise<T>): Promise<T>;
  /** True after a freshly minted token was also rejected, until a call succeeds. */
  tokenRejected(): boolean;
}

export function createBridgeSessionProvider(options: {
  ownerId: string;
  store: BridgeSessionStore;
  platform: MessagingBridgePlatformClient;
}): BridgeSessionProvider {
  let cached: MessagingBridgeSession | null = null;
  let refreshing: Promise<MessagingBridgeSession> | null = null;
  let rejected = false;

  async function stored(): Promise<MessagingBridgeSession | null> {
    if (cached) return cached;
    cached = await options.store.read(options.ownerId);
    return cached;
  }

  function refresh(): Promise<MessagingBridgeSession> {
    refreshing ??= (async () => {
      try {
        const session = await options.platform.createSession();
        await options.store.write(options.ownerId, session);
        cached = session;
        return session;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function current(): Promise<MessagingBridgeSession> {
    return (await stored()) ?? refresh();
  }

  return {
    current,
    stored,
    tokenRejected: () => rejected,
    async withSession(fn) {
      const first = await current();
      try {
        const result = await fn(first);
        rejected = false;
        return result;
      } catch (err: unknown) {
        if (!(err instanceof MatrixUnauthorizedError)) throw err;
      }
      // Another caller may already have replaced the rejected token.
      const second = cached && cached.accessToken !== first.accessToken ? cached : await refresh();
      try {
        const result = await fn(second);
        rejected = false;
        return result;
      } catch (err: unknown) {
        if (!(err instanceof MatrixUnauthorizedError)) throw err;
        rejected = true;
        console.warn("[messages/bridge-session] refreshed access token rejected", errorName(err));
        throw new BridgeSessionUnavailableError();
      }
    },
  };
}
