/** One fixed mkdir child at a time; queued calls and their wait time are both bounded.
 * Controller shutdown fences admission and awaits its tracked create operations,
 * which includes this queue. A slot is held until the child has actually closed.
 */
export function createDirectoryCreatorAdmission(capacity = 32, waitMs = 5_000) {
  let active = false;
  const waiting: Array<{ enter(): void; timer: NodeJS.Timeout }> = [];
  async function enter(): Promise<void> {
    if (!active) { active = true; return; }
    if (waiting.length >= capacity - 1) throw new Error("Scope runtime directory creator capacity exceeded");
    await new Promise<void>((resolve, reject) => {
      const entry = { enter: resolve, timer: setTimeout(() => {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        reject(new Error("Scope runtime directory creator queue expired"));
      }, waitMs) };
      waiting.push(entry);
    });
  }
  return async function admitted<T>(operation: () => Promise<T>): Promise<T> {
    await enter();
    try { return await operation(); } finally {
      const next = waiting.shift();
      if (next) { clearTimeout(next.timer); next.enter(); } else active = false;
    }
  };
}
