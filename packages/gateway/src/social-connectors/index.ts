import { readFileSync, writeFile, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ExternalPost {
  id: string;
  source: string;
  content: string;
  externalUrl?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface SocialConnection {
  id: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  metadata: Record<string, unknown>;
}

export interface FetchContext {
  accessToken: string;
  metadata: Record<string, unknown>;
}

export interface SocialConnector {
  id: string;
  name: string;
  connect(params: Record<string, string>): Promise<SocialConnection>;
  disconnect(): Promise<void>;
  fetchPosts(context: FetchContext): Promise<ExternalPost[]>;
  crossPost?(content: string, context: FetchContext): Promise<{ url: string }>;
}

export interface ConnectorRegistry {
  register(connector: SocialConnector): void;
  get(id: string): SocialConnector | undefined;
  list(): SocialConnector[];
  loadConnections(): SocialConnection[];
  saveConnection(connection: SocialConnection): void;
  removeConnection(id: string): void;
}

export function createConnectorRegistry(homePath: string): ConnectorRegistry {
  const connectors = new Map<string, SocialConnector>();
  const connectionsPath = join(homePath, 'system', 'social-connections.json');

  function readConnections(): SocialConnection[] {
    if (!existsSync(connectionsPath)) return [];
    try {
      return JSON.parse(readFileSync(connectionsPath, 'utf-8'));
    } catch (err: unknown) {
      console.warn('[social-connectors] Could not load connections:', err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  function writeConnections(connections: SocialConnection[]): void {
    writeFile(connectionsPath, JSON.stringify(connections, null, 2), (err) => {
      if (err) {
        console.warn('[social-connectors] Could not persist connections:', err.message);
      }
    });
  }

  return {
    register(connector) {
      connectors.set(connector.id, connector);
    },

    get(id) {
      return connectors.get(id);
    },

    list() {
      return Array.from(connectors.values());
    },

    loadConnections() {
      return readConnections();
    },

    saveConnection(connection) {
      const existing = readConnections();
      const idx = existing.findIndex((c) => c.id === connection.id);
      if (idx >= 0) {
        existing[idx] = connection;
      } else {
        existing.push(connection);
      }
      writeConnections(existing);
    },

    removeConnection(id) {
      const existing = readConnections();
      const filtered = existing.filter((c) => c.id !== id);
      writeConnections(filtered);
    },
  };
}

// --- GitHub Connector ---

interface GitHubConnectorOptions {
  fetch?: typeof globalThis.fetch;
}

export function createGitHubConnector(options?: GitHubConnectorOptions): SocialConnector {
  const fetchFn = options?.fetch ?? globalThis.fetch;

  return {
    id: 'github',
    name: 'GitHub',

    async connect(_params) {
      throw new Error('OAuth flow not implemented in this connector');
    },

    async disconnect() {},

    async fetchPosts(context) {
      const { accessToken, metadata } = context;
      const username = metadata.username as string;

      try {
        const res = await fetchFn(`https://api.github.com/users/${username}/events?per_page=30`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github.v3+json',
          },
        });

        if (!res.ok) return [];

        const events = (await res.json()) as Array<{
          id: string;
          type: string;
          repo: { name: string };
          created_at: string;
          payload: Record<string, unknown>;
        }>;

        return events.map((ev) => {
          let content = '';
          switch (ev.type) {
            case 'PushEvent':
              content = `Pushed to ${ev.repo.name}`;
              break;
            case 'WatchEvent':
              content = `Starred ${ev.repo.name}`;
              break;
            case 'CreateEvent':
              content = `Created ${ev.repo.name}`;
              break;
            case 'PullRequestEvent':
              content = `PR on ${ev.repo.name}`;
              break;
            case 'IssuesEvent':
              content = `Issue on ${ev.repo.name}`;
              break;
            default:
              content = `Activity on ${ev.repo.name}`;
          }

          return {
            id: ev.id,
            source: 'github',
            content,
            externalUrl: `https://github.com/${ev.repo.name}`,
            timestamp: ev.created_at,
          };
        });
      } catch (err: unknown) {
        console.warn('[social-connectors] GitHub fetch failed:', err instanceof Error ? err.message : String(err));
        return [];
      }
    },
  };
}

// --- SSRF protection ---

function isPublicUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname;
    if (
      host === 'localhost' ||
      host.startsWith('127.') ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.') ||
      host.startsWith('172.') ||
      host === '[::1]'
    ) return false;
    return true;
  } catch (err: unknown) {
    console.warn('[social-connectors] Invalid public URL:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

// --- Mastodon Connector ---

interface MastodonConnectorOptions {
  fetch?: typeof globalThis.fetch;
}

export function createMastodonConnector(options?: MastodonConnectorOptions): SocialConnector {
  const fetchFn = options?.fetch ?? globalThis.fetch;

  return {
    id: 'mastodon',
    name: 'Mastodon',

    async connect(_params) {
      throw new Error('OAuth flow not implemented in this connector');
    },

    async disconnect() {},

    async fetchPosts(context) {
      const { accessToken, metadata } = context;
      const instanceUrl = metadata.instanceUrl as string;

      if (!isPublicUrl(instanceUrl)) {
        return [];
      }

      try {
        const res = await fetchFn(`${instanceUrl}/api/v1/timelines/home?limit=30`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        if (!res.ok) return [];

        const statuses = (await res.json()) as Array<{
          id: string;
          content: string;
          created_at: string;
          url: string;
          account: { acct: string };
        }>;

        return statuses.map((status) => ({
          id: status.id,
          source: 'mastodon',
          content: status.content.replace(/<[^>]*>/g, ''),
          externalUrl: status.url,
          timestamp: status.created_at,
          metadata: { author: status.account.acct },
        }));
      } catch (err: unknown) {
        console.warn('[social-connectors] Mastodon fetch failed:', err instanceof Error ? err.message : String(err));
        return [];
      }
    },
  };
}
