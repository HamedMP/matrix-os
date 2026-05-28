export class ReadinessStatusCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly options: { maxEntries: number; ttlMs: number },
    private readonly now: () => number = () => Date.now(),
  ) {
    if (options.maxEntries < 1) {
      throw new Error("Readiness cache maxEntries must be positive");
    }
  }

  get(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return structuredClone(entry.value);
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, {
      value: structuredClone(value),
      expiresAt: this.now() + this.options.ttlMs,
    });
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  size(): number {
    return this.entries.size;
  }
}

