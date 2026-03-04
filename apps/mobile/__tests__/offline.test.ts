import {
  getCachedMessages,
  setCachedMessages,
  getOutboundQueue,
  addToOutboundQueue,
  clearOutboundQueue,
  getRetryDelay,
  canRetry,
  type CachedMessage,
  type QueuedMessage,
} from "../lib/offline";

jest.mock("@react-native-async-storage/async-storage", () => {
  const store: Record<string, string> = {};
  return {
    __esModule: true,
    default: {
      getItem: jest.fn((key: string) => Promise.resolve(store[key] ?? null)),
      setItem: jest.fn((key: string, value: string) => {
        store[key] = value;
        return Promise.resolve();
      }),
    },
  };
});

describe("offline", () => {
  describe("message cache", () => {
    it("returns empty array when no cached messages", async () => {
      const messages = await getCachedMessages();
      expect(messages).toEqual([]);
    });

    it("caches and retrieves messages", async () => {
      const msgs: CachedMessage[] = [
        { id: "1", role: "user", content: "hello", timestamp: 1000 },
        { id: "2", role: "assistant", content: "hi", timestamp: 1001 },
      ];
      await setCachedMessages(msgs);
      const retrieved = await getCachedMessages();
      expect(retrieved).toEqual(msgs);
    });

    it("trims to max 50 messages", async () => {
      const msgs: CachedMessage[] = Array.from({ length: 60 }, (_, i) => ({
        id: String(i),
        role: "user" as const,
        content: `msg ${i}`,
        timestamp: i,
      }));
      await setCachedMessages(msgs);
      const retrieved = await getCachedMessages();
      expect(retrieved.length).toBe(50);
      expect(retrieved[0].id).toBe("0");
    });
  });

  describe("outbound queue", () => {
    it("returns empty queue when nothing queued", async () => {
      await clearOutboundQueue();
      const queue = await getOutboundQueue();
      expect(queue).toEqual([]);
    });

    it("adds messages to queue", async () => {
      await clearOutboundQueue();
      const msg: QueuedMessage = {
        id: "q1",
        text: "hello",
        retries: 0,
        createdAt: Date.now(),
      };
      await addToOutboundQueue(msg);
      const queue = await getOutboundQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0].id).toBe("q1");
    });

    it("clears queue", async () => {
      const msg: QueuedMessage = {
        id: "q2",
        text: "hello",
        retries: 0,
        createdAt: Date.now(),
      };
      await addToOutboundQueue(msg);
      await clearOutboundQueue();
      const queue = await getOutboundQueue();
      expect(queue).toEqual([]);
    });
  });

  describe("retry logic", () => {
    it("calculates exponential backoff delay", () => {
      expect(getRetryDelay(0)).toBe(1000);
      expect(getRetryDelay(1)).toBe(2000);
      expect(getRetryDelay(2)).toBe(4000);
      expect(getRetryDelay(3)).toBe(8000);
    });

    it("caps delay at 30 seconds", () => {
      expect(getRetryDelay(10)).toBe(30000);
      expect(getRetryDelay(20)).toBe(30000);
    });

    it("allows retry when under max retries", () => {
      const msg: QueuedMessage = { id: "1", text: "hi", retries: 3, createdAt: 0 };
      expect(canRetry(msg)).toBe(true);
    });

    it("rejects retry when at max retries", () => {
      const msg: QueuedMessage = { id: "1", text: "hi", retries: 5, createdAt: 0 };
      expect(canRetry(msg)).toBe(false);
    });
  });
});
