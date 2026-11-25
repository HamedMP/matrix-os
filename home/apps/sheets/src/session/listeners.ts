/** A capped set of listeners; one that throws is logged and the others still hear the event. */

import { SheetSessionError } from "./file-io";

export class Listeners<T> {
  private readonly set = new Set<(event: T) => void>();

  constructor(
    private readonly max: number,
    private readonly log: (message: string, error: unknown) => void,
  ) {}

  add(listener: (event: T) => void): () => void {
    if (this.set.size >= this.max) throw new SheetSessionError("failed", { message: "Too many listeners on one session." });
    this.set.add(listener);
    return () => {
      this.set.delete(listener);
    };
  }

  emit(event: T): void {
    for (const listener of [...this.set]) {
      try {
        listener(event);
      } catch (error: unknown) {
        this.log("a session listener failed", error);
      }
    }
  }

  clear(): void {
    this.set.clear();
  }
}
