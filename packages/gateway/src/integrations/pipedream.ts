import { PipedreamClient as SdkClient } from "@pipedream/sdk";

export interface PipedreamConfig {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment?: string;
}

export interface DiscoveredAction {
  key: string;
  name: string;
  description?: string;
}

export interface RunActionResult {
  exports: unknown;
  ret: unknown;
}

export interface PipedreamConnectClient {
  createConnectToken(
    externalUserId: string,
  ): Promise<{ token: string; expiresAt: string; connectLinkUrl: string }>;

  getOAuthUrl(connectLinkUrl: string, app: string): string;

  callAction(opts: {
    externalUserId: string;
    accountId: string;
    url: string;
    body: Record<string, unknown>;
    headers?: Record<string, string>;
  }): Promise<unknown>;

  discoverActions(appSlug: string): Promise<DiscoveredAction[]>;

  runAction(opts: {
    externalUserId: string;
    componentKey: string;
    configuredProps: Record<string, unknown>;
  }): Promise<RunActionResult>;

  proxyGet(opts: {
    externalUserId: string;
    accountId: string;
    url: string;
    params?: Record<string, string>;
  }): Promise<unknown>;

  proxyPost(opts: {
    externalUserId: string;
    accountId: string;
    url: string;
    body?: Record<string, unknown>;
  }): Promise<unknown>;

  proxyPut(opts: {
    externalUserId: string;
    accountId: string;
    url: string;
    body?: Record<string, unknown>;
  }): Promise<unknown>;

  proxyPatch(opts: {
    externalUserId: string;
    accountId: string;
    url: string;
    body?: Record<string, unknown>;
  }): Promise<unknown>;

  proxyDelete(opts: {
    externalUserId: string;
    accountId: string;
    url: string;
    params?: Record<string, string>;
  }): Promise<unknown>;

  revokeAccount(accountId: string): Promise<void>;

  listAccounts(externalUserId: string): Promise<Array<{
    id: string;
    app: string;
    email?: string;
  }>>;

  getAppInfo(slug: string): Promise<{ name: string; imgSrc: string; description?: string } | null>;
}

const API_TIMEOUT_SECONDS = 10;
const ACTION_TIMEOUT_SECONDS = 30;

export function createPipedreamClient(
  config: PipedreamConfig,
): PipedreamConnectClient {
  const sdk = new SdkClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    projectId: config.projectId,
  });

  return {
    async createConnectToken(externalUserId: string) {
      const response = await sdk.tokens.create(
        { externalUserId },
        { timeoutInSeconds: API_TIMEOUT_SECONDS },
      );
      // The SDK exposes connectLinkUrl on the response but the published
      // typings don't include it yet, hence the cast. If it's ever missing
      // (SDK regression, API change), fail loudly here -- the previous
      // fabricated fallback URL was a guess and silently sent users to a
      // broken OAuth page.
      const connectLinkUrl = (response as { connectLinkUrl?: string }).connectLinkUrl;
      if (!connectLinkUrl) {
        throw new Error(
          "Pipedream SDK did not return connectLinkUrl on tokens.create response. " +
          "This usually means the @pipedream/sdk version changed; check the SDK changelog.",
        );
      }
      return {
        token: response.token,
        expiresAt:
          response.expiresAt instanceof Date
            ? response.expiresAt.toISOString()
            : String(response.expiresAt),
        connectLinkUrl,
      };
    },

    getOAuthUrl(connectLinkUrl: string, app: string) {
      // Pipedream's connectLinkUrl currently includes a `?token=...` query
      // string, but the SDK doesn't guarantee that shape -- a future version
      // could return a bare URL or one ending in a fragment. Pick the right
      // separator instead of assuming `&`. Anything past `#` is dropped from
      // the query, so refuse to append after a fragment rather than producing
      // a malformed URL.
      const hashIdx = connectLinkUrl.indexOf("#");
      if (hashIdx !== -1) {
        throw new Error("Pipedream connectLinkUrl unexpectedly contains a fragment; cannot append app param");
      }
      const separator = connectLinkUrl.includes("?") ? "&" : "?";
      return `${connectLinkUrl}${separator}app=${encodeURIComponent(app)}`;
    },

    async callAction(opts) {
      const result = await sdk.proxy.post(
        {
          url: opts.url,
          externalUserId: opts.externalUserId,
          accountId: opts.accountId,
          body: opts.body,
          headers: opts.headers,
        },
        { timeoutInSeconds: API_TIMEOUT_SECONDS },
      );
      return result;
    },

    async discoverActions(appSlug: string) {
      const page = await sdk.actions.list(
        { app: appSlug },
        { timeoutInSeconds: API_TIMEOUT_SECONDS },
      );
      const items = (page as any).data ?? [];
      return items.map((c: any) => ({
        key: c.key,
        name: c.name,
        description: c.description,
      }));
    },

    async runAction(opts) {
      const response = await sdk.actions.run(
        {
          id: opts.componentKey,
          externalUserId: opts.externalUserId,
          configuredProps: opts.configuredProps,
        },
        { timeoutInSeconds: ACTION_TIMEOUT_SECONDS },
      );
      const body = (response as any).body ?? response;
      return {
        exports: body.exports,
        ret: body.ret,
      };
    },

    async proxyGet(opts) {
      const result = await (sdk.proxy as any).get(
        {
          url: opts.url,
          externalUserId: opts.externalUserId,
          accountId: opts.accountId,
          params: opts.params,
        },
        { timeoutInSeconds: API_TIMEOUT_SECONDS },
      );
      return result;
    },

    async proxyPost(opts) {
      const result = await (sdk.proxy as any).post(
        {
          url: opts.url,
          externalUserId: opts.externalUserId,
          accountId: opts.accountId,
          body: opts.body ?? {},
        },
        { timeoutInSeconds: API_TIMEOUT_SECONDS },
      );
      return result;
    },

    async proxyPut(opts) {
      const result = await (sdk.proxy as any).put(
        {
          url: opts.url,
          externalUserId: opts.externalUserId,
          accountId: opts.accountId,
          body: opts.body ?? {},
        },
        { timeoutInSeconds: API_TIMEOUT_SECONDS },
      );
      return result;
    },

    async proxyPatch(opts) {
      const result = await (sdk.proxy as any).patch(
        {
          url: opts.url,
          externalUserId: opts.externalUserId,
          accountId: opts.accountId,
          body: opts.body ?? {},
        },
        { timeoutInSeconds: API_TIMEOUT_SECONDS },
      );
      return result;
    },

    async proxyDelete(opts) {
      // Pipedream's ProxyDeleteRequest accepts URL + query params (no body),
      // matching standard REST DELETE semantics. If a target API needs a
      // DELETE-with-body (rare; e.g. some Elasticsearch endpoints), use
      // proxyPost with method override -- but none of our registered actions
      // need that today.
      const result = await (sdk.proxy as any).delete(
        {
          url: opts.url,
          externalUserId: opts.externalUserId,
          accountId: opts.accountId,
          params: opts.params,
        },
        { timeoutInSeconds: API_TIMEOUT_SECONDS },
      );
      return result;
    },

    async revokeAccount(accountId: string) {
      await sdk.accounts.delete(accountId, {
        timeoutInSeconds: API_TIMEOUT_SECONDS,
      });
    },

    async getAppInfo(slug: string) {
      try {
        const result = await sdk.apps.list(
          { q: slug, limit: 1, sortKey: "featured_weight", sortDirection: "desc" } as any,
          { timeoutInSeconds: API_TIMEOUT_SECONDS },
        );
        const items = (result as any)?.data ?? [];
        const match = items.find((a: any) => (a.nameSlug ?? a.name_slug) === slug);
        if (!match) return null;
        return {
          name: match.name ?? slug,
          imgSrc: match.imgSrc ?? match.img_src ?? "",
          description: match.description ?? undefined,
        };
      } catch (err) {
        console.error("[pipedream] getAppInfo failed for", slug, ":", err instanceof Error ? err.message : err);
        return null;
      }
    },

    async listAccounts(externalUserId: string) {
      const result = await sdk.accounts.list(
        { externalUserId, include_credentials: false } as any,
        { timeoutInSeconds: API_TIMEOUT_SECONDS },
      );
      const accounts = (result as any)?.data ?? (Array.isArray(result) ? result : []);
      return accounts.map((a: any) => {
        const app = a.app;
        const appSlug = typeof app === "string" ? app
          : app?.nameSlug ?? app?.name_slug ?? app?.slug ?? String(app ?? "");
        return {
          id: a.id,
          app: appSlug,
          email: a.email ?? a.display_name ?? undefined,
        };
      });
    },
  };
}
