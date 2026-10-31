import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { TerminalNativeHostRefSchema, TerminalRefSchema, type TerminalRef, type TerminalTab } from "@matrix-os/contracts";
import { TerminalRuntimeError } from "./errors.js";
import type { NativeTabCompletion } from "./native-host-lifecycle.js";

/** One-use producer settlement correlation, not routine or native execution authority.
 * Never persisted/exported. Losing it leaves the canonical dispatch unresolved. */
export class NativeDispatchLeases {
  private readonly entries = new Map<string, { digest: Buffer; host: { path: string; generation: string }; incarnation?: string; expiresAt: number }>(); // <=64; TTL/sweep, consume, cancel and shutdown eviction.
  private readonly timer: NodeJS.Timeout;
  private closed = false;
  constructor() {
    this.timer = setInterval(() => this.sweep(), 30000); this.timer.unref();
  }
  private sweep() {
    for (const [key, value] of this.entries) if (value.expiresAt <= Date.now()) this.entries.delete(key);
  }
  begin(rawRef: TerminalRef, rawHost: NonNullable<TerminalTab["nativeHost"]>) {
    const ref = TerminalRefSchema.parse(rawRef), host = TerminalNativeHostRefSchema.parse(rawHost), key = `${ref.workspaceId}:${ref.tabId}`;
    this.sweep();
    if (this.closed || this.entries.size >= 64) throw new TerminalRuntimeError("capacity");
    if (this.entries.has(key)) throw new TerminalRuntimeError("conflict");
    const token = randomBytes(32).toString("hex"), entry = { digest: createHash("sha256").update(token).digest(), host, incarnation: undefined as string | undefined, expiresAt: Date.now() + 5 * 60000 };
    this.entries.set(key, entry);
    return {
      token,
      bind: (tab: TerminalTab) => {
        this.sweep();
        if (this.closed || this.entries.get(key) !== entry || !tab.incarnation || tab.id !== ref.tabId || tab.workspaceId !== ref.workspaceId
          || tab.nativeHost?.path !== host.path || tab.nativeHost.generation !== host.generation) throw new TerminalRuntimeError("conflict");
        entry.incarnation = tab.incarnation;
      },
      cancel: () => { if (this.entries.get(key) === entry) this.entries.delete(key); },
    };
  }
  consume(ref: TerminalRef, input: NativeTabCompletion) {
    this.sweep();
    const key = `${ref.workspaceId}:${ref.tabId}`, entry = this.entries.get(key);
    if (this.closed || !entry || typeof input.settlementToken !== "string" || !/^[a-f0-9]{64}$/.test(input.settlementToken)
      || !timingSafeEqual(entry.digest, createHash("sha256").update(input.settlementToken).digest())
      || entry.incarnation !== input.expectedIncarnation || entry.host.path !== input.nativeHost.path || entry.host.generation !== input.nativeHost.generation) throw new TerminalRuntimeError("conflict");
    this.entries.delete(key); // Consume before any write/attach; uncertain responses never authorize retry.
  }
  close() { this.closed = true; clearInterval(this.timer); this.entries.clear(); }
}
