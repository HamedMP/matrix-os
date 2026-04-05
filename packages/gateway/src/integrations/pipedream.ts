import { PipedreamClient as SdkClient } from "@pipedream/sdk";

export interface PipedreamConfig {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment?: string;
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

  revokeAccount(accountId: string): Promise<void>;

  listAccounts(externalUserId: string): Promise<Array<{
    id: string;
    app: string;
    email?: string;
  }>>;

  getAppInfo(slug: string): Promise<{ name: string; imgSrc: string; description?: string } | null>;
}

const API_TIMEOUT_SECONDS = 10;

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
      return {
        token: response.token,
        expiresAt:
          response.expiresAt instanceof Date
            ? response.expiresAt.toISOString()
            : String(response.expiresAt),
        connectLinkUrl: (response as any).connectLinkUrl ?? `https://pipedream.com/connect/${config.projectId}?token=${encodeURIComponent(response.token)}`,
      };
    },

    getOAuthUrl(connectLinkUrl: string, app: string) {
      return `${connectLinkUrl}&app=${encodeURIComponent(app)}`;
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
