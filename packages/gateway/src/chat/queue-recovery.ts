import type { ChatOwner } from "./records.js";

type ListQueuedChats = (owner: ChatOwner, limit: number, afterChatId?: string) => Promise<string[]>;
const PAGE_SIZE = 20;
const MAX_OWNERS = 64;

/** In-memory scan order only. Claims and authorization remain durable/current. */
export class QueuedChatRecovery {
  private readonly cursors = new Map<string, string>(); // bounded to64, LRU eviction below
  private closed = false;

  async recover(owner: ChatOwner, list: ListQueuedChats, dispatch: (chatId: string) => Promise<void>): Promise<void> {
    if (this.closed) return;
    const key = `${owner.type}:${owner.ownerId}`;
    const cursor = this.cursors.get(key);
    let ids = await list(owner, PAGE_SIZE, cursor);
    if (ids.length === 0 && cursor !== undefined && !this.closed) ids = await list(owner, PAGE_SIZE);
    for (const chatId of ids.slice(0, PAGE_SIZE)) {
      if (this.closed) return;
      await dispatch(chatId);
      if (this.closed) return;
      // Advance even when dispatch intentionally skips an unsupported Chat.
      this.cursors.delete(key);
      if (this.cursors.size >= MAX_OWNERS) {
        const oldest = this.cursors.keys().next().value;
        if (oldest !== undefined) this.cursors.delete(oldest);
      }
      this.cursors.set(key, chatId);
    }
    if (ids.length < PAGE_SIZE) this.cursors.delete(key);
  }

  close(): void {
    this.closed = true;
    this.cursors.clear();
  }
}
