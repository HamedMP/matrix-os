/**
 * A stand-in for the platform half of `window.MatrixOS`: `service`, `integrations`
 * and `capabilities`. It records every call and answers from a queue of replies per
 * `service/action`. It fakes the bridge, never the adapter under test.
 */
import type { MatrixOSCapabilities, MatrixOSConnectedService } from "../../../../home/apps/_shared/matrix-os";

export interface RecordedCall {
  service: string;
  action: string;
  params: Record<string, unknown>;
  label: string | undefined;
}

type Reply = unknown | (() => unknown);

export class FakeBridge {
  readonly calls: RecordedCall[] = [];
  connected: MatrixOSConnectedService[] = [];
  caps: MatrixOSCapabilities = { version: 1, integrations: true, ai: true };
  integrationsCalls = 0;
  private readonly replies = new Map<string, Reply[]>();
  private readonly handlers = new Map<string, (params: Record<string, unknown>) => unknown>();

  /** Answer every call to one action from its parameters; used when calls run in parallel. */
  handle(service: string, action: string, handler: (params: Record<string, unknown>) => unknown): this {
    this.handlers.set(`${service}/${action}`, handler);
    return this;
  }

  /** Queue replies (raw provider `data`) for one action, answered in order. */
  reply(service: string, action: string, ...data: Reply[]): this {
    const key = `${service}/${action}`;
    this.replies.set(key, [...(this.replies.get(key) ?? []), ...data]);
    return this;
  }

  /** Queue a rejection shaped like a failed bridge call. */
  fail(service: string, action: string, error: unknown): this {
    return this.reply(service, action, () => { throw error; });
  }

  async service(service: string, action: string, params?: Record<string, unknown>, label?: string): Promise<{ data: unknown; service: string; action: string }> {
    // Round-trip through JSON like the real bridge, so undefined fields vanish.
    const sent = JSON.parse(JSON.stringify(params ?? {})) as Record<string, unknown>;
    this.calls.push({ service, action, params: sent, label });
    await Promise.resolve();
    const handler = this.handlers.get(`${service}/${action}`);
    if (handler) {
      const data = handler(sent);
      return { data: data === undefined ? undefined : JSON.parse(JSON.stringify(data)), service, action };
    }
    const queue = this.replies.get(`${service}/${action}`);
    if (!queue || queue.length === 0) throw new Error(`No reply queued for ${service}/${action}`);
    const next = queue.shift();
    const data = typeof next === "function" ? (next as () => unknown)() : next;
    return { data: data === undefined ? undefined : JSON.parse(JSON.stringify(data)), service, action };
  }

  async integrations(): Promise<MatrixOSConnectedService[]> {
    this.integrationsCalls++;
    return JSON.parse(JSON.stringify(this.connected)) as MatrixOSConnectedService[];
  }

  async capabilities(): Promise<MatrixOSCapabilities> {
    return { ...this.caps };
  }

  callsTo(action: string): RecordedCall[] {
    return this.calls.filter((call) => call.action === action);
  }

  /** Replies still queued; a test that ends with leftovers expected a call that never came. */
  pending(): string[] {
    return [...this.replies.entries()].filter(([, queue]) => queue.length > 0).map(([key]) => key);
  }
}

/** A rejection like the bridge produces for a non-2xx gateway answer, with hostile provider text. */
export function statusError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}: upstream said secret things about tenant-42 at /var/lib/x`), { status });
}

export function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

export function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}
