import { WebSocket } from "ws";

export interface WsClient {
  send: (msg: Record<string, unknown>) => void;
  messages: () => Record<string, unknown>[];
  waitFor: (type: string, timeout?: number) => Promise<Record<string, unknown>>;
  close: () => void;
}

export function connectWs(url: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const received: Record<string, unknown>[] = [];
    const waiters: Array<{
      type: string;
      resolve: (msg: Record<string, unknown>) => void;
      reject: (err: Error) => void;
    }> = [];

    ws.on("open", () => {
      resolve({
        send(msg) {
          ws.send(JSON.stringify(msg));
        },
        messages() {
          return received;
        },
        waitFor(type: string, timeout = 10_000) {
          const existing = received.find((m) => m.type === type);
          if (existing) return Promise.resolve(existing);

          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              rej(new Error(`Timeout waiting for message type "${type}"`));
            }, timeout);

            waiters.push({
              type,
              resolve: (msg) => {
                clearTimeout(timer);
                res(msg);
              },
              reject: (err) => {
                clearTimeout(timer);
                rej(err);
              },
            });
          });
        },
        close() {
          ws.close();
        },
      });
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        received.push(msg);

        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].type === msg.type) {
            waiters[i].resolve(msg);
            waiters.splice(i, 1);
          }
        }
      } catch {
        // ignore non-JSON
      }
    });

    ws.on("error", reject);
  });
}
