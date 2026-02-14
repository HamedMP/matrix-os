import { type PlatformDB, listContainers, getContainer } from './db.js';

export interface UserInfo {
  handle: string;
  status: string;
  lastActive: string;
}

export interface SocialApi {
  listUsers(): UserInfo[];
  getProfile(handle: string): Promise<unknown>;
  getAiProfile(handle: string): Promise<unknown>;
  sendMessage(handle: string, text: string, from: { handle: string; displayName?: string }): Promise<unknown>;
}

export function createSocialApi(db: PlatformDB, proxyUrl?: string): SocialApi {
  return {
    listUsers() {
      const all = listContainers(db);
      return all.map((c) => ({
        handle: c.handle,
        status: c.status,
        lastActive: c.lastActive,
      }));
    },

    async getProfile(handle: string) {
      const record = getContainer(db, handle);
      if (!record) return null;

      try {
        const res = await fetch(`http://localhost:${record.port}/api/profile`);
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    },

    async getAiProfile(handle: string) {
      const record = getContainer(db, handle);
      if (!record) return null;

      try {
        const res = await fetch(`http://localhost:${record.port}/api/ai-profile`);
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    },

    async sendMessage(handle, text, from) {
      const url = proxyUrl
        ? `${proxyUrl}/send/${handle}`
        : (() => {
            const record = getContainer(db, handle);
            if (!record) throw new Error(`No container for handle: ${handle}`);
            return `http://localhost:${record.port}/api/message`;
          })();

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, from }),
      });

      return await res.json();
    },
  };
}
