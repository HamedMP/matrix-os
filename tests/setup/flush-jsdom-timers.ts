import { afterEach } from "vitest";

// Captured before any test file loads: a test can leave a fake or spied
// setTimeout on globalThis that never fires, and this wait must still end.
const realSetTimeout = globalThis.setTimeout;

// Radix FocusScope restores focus in a setTimeout(0) when it unmounts. After a
// file's last test, Vitest can tear down jsdom before that timer fires, and the
// late focus event fails the shard as an unhandled error. This hook is
// registered first, so it runs after each file's own cleanup and lets those
// timers run while jsdom still exists.
afterEach(async () => {
  if (typeof document === "undefined") return;
  await new Promise((resolve) => realSetTimeout(resolve, 0));
});
