import { z } from "zod/v4";
import type { PlatformDb } from "../../platform-db.js";
import { withinIntegrationDeadline } from "../bounded-proxy-transport.js";
import { getErrorStatusCode } from "../call-outcome.js";
import { parseCustomMcpEncryptionKey } from "../custom-mcp/crypto.js";
import type { PipedreamConnectClient } from "../pipedream.js";
import { createOutlookGraph, type OutlookGraph } from "./graph.js";
import { GRAPH_ORIGIN, OutlookError } from "./http.js";
import { createOutlookLifecycle, OUTLOOK_OAUTH_CALLBACK, type OutlookLifecycle } from "./lifecycle.js";
import { createOutlookOAuth } from "./oauth.js";
import type { OutlookStore } from "./store.js";

export interface OutlookRuntime {
  lifecycle: OutlookLifecycle;
  graph: OutlookGraph;
  store: OutlookStore;
  legacyRetired: boolean;
  close(): Promise<void>;
}
export async function createOutlookRuntime(options: {
  db: PlatformDb & { outlook: OutlookStore };
  pipedream?: Pick<PipedreamConnectClient, "proxyGet" | "revokeAccount">;
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
  redirectUri: string;
  fetcher?: typeof fetch;
  maintenance?: boolean;
  legacyRetired?: boolean;
  admit?: Parameters<typeof createOutlookLifecycle>[0]["admit"];
}): Promise<OutlookRuntime> {
  const { db, pipedream } = options;
  const redirect = new URL(options.redirectUri);
  if (redirect.pathname !== OUTLOOK_OAUTH_CALLBACK) throw new OutlookError("unavailable");
  const lifecycle = createOutlookLifecycle({
    db, store: db.outlook, oauth: createOutlookOAuth(options),
    encryptionKey: parseCustomMcpEncryptionKey(options.encryptionKey),
    redirectUri: options.redirectUri, admit: options.admit,
    verifyLegacy: pipedream && (async (userId, connection, signal) => {
      const user = await db.getUserById(userId);
      if (!user?.pipedream_external_id || connection.user_id !== userId) throw new OutlookError("unavailable");
      const data = await withinIntegrationDeadline(() => pipedream.proxyGet({
        externalUserId: user.pipedream_external_id!, accountId: connection.pipedream_account_id,
        url: `${GRAPH_ORIGIN}/v1.0/me`, params: { "$select": "id" },
      }), signal);
      return z.object({ id: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/) }).parse(data).id;
    }),
  });

  await db.outlook.migrate();
  let pending: Promise<void> | undefined;
  const sweep = async () => {
    await db.outlook.sweepAttempts(new Date());
    if (!pipedream) return;
    const accounts = await db.outlook.claimPendingLegacyCleanup(new Date());
    await Promise.all(accounts.map(async ({ userId, providerAccountId }) => {
      try { await pipedream.revokeAccount(providerAccountId); }
      catch (error: unknown) {
        if (getErrorStatusCode(error) !== 404) {
          console.warn("[outlook] Previous connector cleanup will retry", error instanceof Error ? error.name : "UnknownError");
          return;
        }
      }
      await db.outlook.markLegacyCleaned(userId, providerAccountId);
    }));
  };
  const timer = options.maintenance ? setInterval(() => {
    if (pending) return;
    pending = sweep().catch((error: unknown) => {
      console.warn("[outlook] Maintenance failed", error instanceof Error ? error.name : "UnknownError");
    }).finally(() => { pending = undefined; });
  }, 60_000).unref() : undefined;

  return {
    lifecycle,
    graph: createOutlookGraph({ lifecycle, fetcher: options.fetcher }),
    store: db.outlook,
    legacyRetired: options.legacyRetired === true,
    async close() {
      if (timer) clearInterval(timer);
      await pending;
    },
  };
}
