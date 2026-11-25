/**
 * A stand-in for `window.MatrixOS.service`: it records every call and answers
 * from a queue of replies per `service/action`. It fakes the platform bridge,
 * not the adapter under test.
 */
export interface RecordedCall {
  service: string;
  action: string;
  params: Record<string, unknown>;
  label: string | undefined;
}

type Reply = unknown | (() => unknown);

export class FakeBridge {
  readonly calls: RecordedCall[] = [];
  private readonly replies = new Map<string, Reply[]>();

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

  async service<T = unknown>(service: string, action: string, params?: Record<string, unknown>, label?: string): Promise<{ data: T; service: string; action: string }> {
    // Round-trip through JSON like the real bridge does, so undefined fields vanish.
    const sent = JSON.parse(JSON.stringify(params ?? {})) as Record<string, unknown>;
    this.calls.push({ service, action, params: sent, label });
    const queue = this.replies.get(`${service}/${action}`);
    if (!queue || queue.length === 0) throw new Error(`No reply queued for ${service}/${action}`);
    const next = queue.shift();
    const data = typeof next === "function" ? (next as () => unknown)() : next;
    return { data: (data === undefined ? undefined : JSON.parse(JSON.stringify(data))) as T, service, action };
  }

  callsTo(action: string): RecordedCall[] {
    return this.calls.filter((call) => call.action === action);
  }
}

export function statusError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}: upstream said secret things about tenant-42`), { status });
}
