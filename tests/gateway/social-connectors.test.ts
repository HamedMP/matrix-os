import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  type SocialConnector,
  type SocialConnection,
  createConnectorRegistry,
  type ConnectorRegistry,
  createGitHubConnector,
  createMastodonConnector,
} from '../../packages/gateway/src/social-connectors/index.js';

describe('gateway/social-connectors', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'social-connectors-'));
    mkdirSync(join(tmpDir, 'system'), { recursive: true });
    mkdirSync(join(tmpDir, 'data', 'social'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('ConnectorRegistry', () => {
    it('registers and retrieves connectors', () => {
      const registry = createConnectorRegistry(tmpDir);
      const mockConnector: SocialConnector = {
        id: 'github',
        name: 'GitHub',
        connect: vi.fn(),
        disconnect: vi.fn(),
        fetchPosts: vi.fn().mockResolvedValue([]),
      };

      registry.register(mockConnector);
      expect(registry.get('github')).toBe(mockConnector);
      expect(registry.list()).toHaveLength(1);
    });

    it('returns undefined for unregistered connector', () => {
      const registry = createConnectorRegistry(tmpDir);
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('loads connections from file', () => {
      const connections: SocialConnection[] = [
        { id: 'github', accessToken: 'gh-token', refreshToken: null, expiresAt: null, metadata: {} },
      ];
      writeFileSync(
        join(tmpDir, 'system', 'social-connections.json'),
        JSON.stringify(connections),
      );

      const registry = createConnectorRegistry(tmpDir);
      const loaded = registry.loadConnections();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('github');
    });

    it('returns empty array when connections file does not exist', () => {
      const registry = createConnectorRegistry(tmpDir);
      const loaded = registry.loadConnections();
      expect(loaded).toEqual([]);
    });

    it('saves connections to file', () => {
      const registry = createConnectorRegistry(tmpDir);
      registry.saveConnection({
        id: 'github',
        accessToken: 'gh-token',
        refreshToken: null,
        expiresAt: null,
        metadata: { username: 'alice' },
      });

      const loaded = registry.loadConnections();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].metadata.username).toBe('alice');
    });

    it('removes a connection', () => {
      const registry = createConnectorRegistry(tmpDir);
      registry.saveConnection({
        id: 'github',
        accessToken: 'gh-token',
        refreshToken: null,
        expiresAt: null,
        metadata: {},
      });
      registry.saveConnection({
        id: 'mastodon',
        accessToken: 'masto-token',
        refreshToken: null,
        expiresAt: null,
        metadata: {},
      });

      registry.removeConnection('github');
      const loaded = registry.loadConnections();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('mastodon');
    });
  });

  describe('GitHub connector', () => {
    it('creates a connector with correct id and name', () => {
      const connector = createGitHubConnector();
      expect(connector.id).toBe('github');
      expect(connector.name).toBe('GitHub');
    });

    it('fetches GitHub events as posts', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: '1',
            type: 'PushEvent',
            repo: { name: 'alice/myrepo' },
            created_at: '2026-03-01T10:00:00Z',
            payload: { commits: [{ message: 'feat: add feature' }] },
          },
          {
            id: '2',
            type: 'WatchEvent',
            repo: { name: 'bob/coolrepo' },
            created_at: '2026-03-01T09:00:00Z',
            payload: {},
          },
        ],
      });

      const connector = createGitHubConnector({ fetch: fetchMock });
      const posts = await connector.fetchPosts({
        accessToken: 'gh-token',
        metadata: { username: 'alice' },
      });

      expect(posts).toHaveLength(2);
      expect(posts[0].source).toBe('github');
      expect(posts[0].content).toContain('alice/myrepo');
      expect(posts[1].content).toContain('bob/coolrepo');
    });

    it('returns empty array on fetch failure', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      const connector = createGitHubConnector({ fetch: fetchMock });
      const posts = await connector.fetchPosts({
        accessToken: 'bad-token',
        metadata: { username: 'alice' },
      });

      expect(posts).toEqual([]);
    });
  });

  describe('Mastodon connector', () => {
    it('creates a connector with correct id and name', () => {
      const connector = createMastodonConnector();
      expect(connector.id).toBe('mastodon');
      expect(connector.name).toBe('Mastodon');
    });

    it('fetches Mastodon statuses as posts', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: '101',
            content: '<p>Hello fediverse!</p>',
            created_at: '2026-03-01T12:00:00Z',
            url: 'https://mastodon.social/@alice/101',
            account: { acct: 'alice' },
          },
        ],
      });

      const connector = createMastodonConnector({ fetch: fetchMock });
      const posts = await connector.fetchPosts({
        accessToken: 'masto-token',
        metadata: { instanceUrl: 'https://mastodon.social' },
      });

      expect(posts).toHaveLength(1);
      expect(posts[0].source).toBe('mastodon');
      expect(posts[0].content).toContain('Hello fediverse');
      expect(posts[0].externalUrl).toBe('https://mastodon.social/@alice/101');
    });
  });
});
