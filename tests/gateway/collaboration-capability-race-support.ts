import type { KyselyPlugin } from "kysely";

/** Pause the first query result after `arm()` so a capability transition can
 * overlap another operation deterministically without timing sleeps. */
export function createQueryResultPause(): {
  plugin: KyselyPlugin;
  arm: () => { paused: Promise<void>; release: () => void };
} {
  let pending: {
    signalPaused: () => void;
    released: Promise<void>;
  } | null = null;

  return {
    plugin: {
      transformQuery(args) { return args.node; },
      async transformResult(args) {
        const active = pending;
        if (!active) return args.result;
        pending = null;
        active.signalPaused();
        await active.released;
        return args.result;
      },
    },
    arm() {
      if (pending) throw new Error("Query-result pause is already armed");
      let signalPaused: (() => void) | undefined;
      let release: (() => void) | undefined;
      const paused = new Promise<void>((resolve) => { signalPaused = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      pending = { signalPaused: () => signalPaused?.(), released };
      return { paused, release: () => release?.() };
    },
  };
}
