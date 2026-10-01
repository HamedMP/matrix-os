import { SpawnError } from "./errors.js";

// Loopback ports handed to app processes. Kept below the Linux ephemeral
// range (net.ipv4.ip_local_port_range, default 32768-60999): the kernel
// assigns those as local ports for outbound connections, and an app told to
// listen on one an outbound socket already holds exits with EADDRINUSE.
export const APP_PORT_RANGE = { min: 20000, max: 29999 } as const;

export interface PortPoolOptions {
  min?: number;
  max?: number;
  cap?: number;
}

export class PortPool {
  private readonly available: Set<number>;
  private readonly allocated: Set<number>;
  private readonly min: number;
  private readonly max: number;
  private readonly cap: number;

  constructor(opts: PortPoolOptions = {}) {
    this.min = opts.min ?? APP_PORT_RANGE.min;
    this.max = opts.max ?? APP_PORT_RANGE.max;
    this.cap = opts.cap ?? 100;
    this.available = new Set<number>();
    this.allocated = new Set<number>();

    // Pre-populate the available set up to cap
    const rangeSize = this.max - this.min + 1;
    const slots = Math.min(rangeSize, this.cap);
    for (let i = 0; i < slots; i++) {
      this.available.add(this.min + i);
    }
  }

  allocate(): number {
    if (this.allocated.size >= this.cap || this.available.size === 0) {
      throw new SpawnError(
        "port_exhausted",
        `No ports available (${this.allocated.size} allocated, cap ${this.cap})`,
      );
    }

    // Take the first available port
    const port = this.available.values().next().value!;
    this.available.delete(port);
    this.allocated.add(port);
    return port;
  }

  release(port: number): void {
    if (!this.allocated.has(port)) {
      // Idempotent: ignore release of unknown or already-released port
      return;
    }
    this.allocated.delete(port);
    this.available.add(port);
  }

  inUse(): number[] {
    return [...this.allocated];
  }
}
