import { type PlatformDB, listContainers, getContainer } from './db.js';

export interface UserInfo {
  handle: string;
  status: string;
  lastActive: string;
}

export interface SocialApi {
  listUsers(): Promise<UserInfo[]>;
  getProfile(handle: string): Promise<unknown>;
  getAiProfile(handle: string): Promise<unknown>;
  sendMessage(handle: string, text: string, from: { handle: string; displayName?: string }): Promise<unknown>;
}

export function createSocialApi(db: PlatformDB, proxyUrl?: string): SocialApi {
  return {
    async listUsers() {
      const all = await listContainers(db);
      return all.map((c) => ({
        handle: c.handle,
        status: c.status,
        lastActive: c.lastActive,
      }));
    },

    async getProfile(handle: string) {
      const record = await getContainer(db, handle);
      if (!record) return null;

      try {
        const res = await fetch(`http://localhost:${record.port}/api/profile`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return null;
        return await res.json();
      } catch (err: unknown) {
        console.warn('[social] profile fetch failed:', err instanceof Error ? err.message : String(err));
        return null;
      }
    },

    async getAiProfile(handle: string) {
      const record = await getContainer(db, handle);
      if (!record) return null;

      try {
        const res = await fetch(`http://localhost:${record.port}/api/ai-profile`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return null;
        return await res.json();
      } catch (err: unknown) {
        console.warn('[social] ai profile fetch failed:', err instanceof Error ? err.message : String(err));
        return null;
      }
    },

    async sendMessage(handle, text, from) {
      const url = proxyUrl
        ? `${proxyUrl}/send/${handle}`
        : await (async () => {
            const record = await getContainer(db, handle);
            if (!record) throw new Error(`No container for handle: ${handle}`);
            return `http://localhost:${record.port}/api/message`;
          })();

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ text, from }),
      });

      return await res.json();
    },
  };
}
