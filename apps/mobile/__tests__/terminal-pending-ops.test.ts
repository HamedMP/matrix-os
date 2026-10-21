import { PendingTerminalOps } from "@/lib/terminal-pending-ops";

describe("operations held for an emulator that has not booted", () => {
  it("replays a grid and the output laid out for it in the order they arrived", () => {
    const pending = new PendingTerminalOps();

    pending.pushGrid("grid(120,36)");
    pending.pushWrite("write(a)", 1);
    pending.pushWrite("write(b)", 1);
    pending.pushGrid("grid(49,36)");
    pending.pushWrite("write(c)", 1);

    expect(pending.drain()).toBe("grid(120,36);write(a);write(b);grid(49,36);write(c)");
    expect(pending.size).toBe(0);
    expect(pending.drain()).toBeNull();
  });

  it("keeps only the latest of several grid changes with no output between them", () => {
    const pending = new PendingTerminalOps();

    pending.pushGrid("grid(120,36)");
    pending.pushGrid("grid(49,36)");
    pending.pushGrid("grid(49,18)");

    expect(pending.size).toBe(1);
    expect(pending.drain()).toBe("grid(49,18)");
  });

  it("stays at one entry however many grid changes arrive while nothing boots", () => {
    const pending = new PendingTerminalOps();

    for (let rows = 0; rows < 10_000; rows += 1) pending.pushGrid(`grid(49,${rows})`);

    expect(pending.size).toBe(1);
    expect(pending.drain()).toBe("grid(49,9999)");
  });

  it("keeps the latest grid alone once the output held with it is superseded", () => {
    const pending = new PendingTerminalOps();
    pending.pushGrid("grid(120,36)");
    pending.pushWrite("write(stale)", 5);
    pending.pushGrid("grid(49,36)");
    pending.pushWrite("write(stale too)", 9);

    pending.discardWrites();

    expect(pending.size).toBe(1);
    expect(pending.drain()).toBe("grid(49,36)");
  });

  it("drops the oldest output past the character limit and the grid it was laid out for", () => {
    const pending = new PendingTerminalOps({ maxOps: 100, maxWriteChars: 10 });
    pending.pushGrid("grid(120,36)");
    pending.pushWrite("write(old)", 6);
    pending.pushGrid("grid(49,36)");
    pending.pushWrite("write(new)", 6);

    // The first write no longer fits; the grid before it has nothing left to
    // lay out, so the two grids collapse into the later one.
    expect(pending.drain()).toBe("grid(49,36);write(new)");
  });

  it("never holds more entries than its limit when grids and output alternate", () => {
    const pending = new PendingTerminalOps({ maxOps: 8, maxWriteChars: 1_000_000 });

    for (let index = 0; index < 1_000; index += 1) {
      pending.pushGrid(`grid(${index})`);
      pending.pushWrite(`write(${index})`, 1);
      expect(pending.size).toBeLessThanOrEqual(8);
    }

    const script = pending.drain() ?? "";
    expect(script.endsWith("grid(999);write(999)")).toBe(true);
    expect(script).not.toContain("write(0)");
  });

  it("keeps a single oversized write rather than holding nothing", () => {
    const pending = new PendingTerminalOps({ maxOps: 8, maxWriteChars: 4 });

    pending.pushWrite("write(snapshot)", 4_096);

    expect(pending.drain()).toBe("write(snapshot)");
  });
});
