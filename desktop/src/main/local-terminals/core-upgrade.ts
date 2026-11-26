// The app's private core after an app update (ENG-580). The previous app left
// its core running so terminals survive a restart, but the update bundled a
// newer herdr-core that the app now requires exactly. herdr-core's planned
// restart (`server.restart`, in the 0.1 line since 0.1.14) saves every screen
// and keeps programs running in their holders; the next core started adopts
// them. Only a core older than the bundled one, on the same 0.1 line and
// protocol generation, is handed over: a newer or unknown core is left alone
// and reported as a version mismatch.
import { connectHc, type HcSocket } from "./hc-client";
import { compareCoreVersions } from "../../shared/local-terminals";

const HANDOVER_CLOSE_MS = 10_000;
const SAME_LINE = /^0\.1\.[0-9]{1,4}$/;

/** Whether a running core of `found` may be restarted into the bundled `expected` one. */
export function isOlderBundledLine(found: string, expected: string): boolean {
  if (!SAME_LINE.test(found) || !SAME_LINE.test(expected)) return false;
  const order = compareCoreVersions(found, expected);
  return order !== null && order < 0;
}

/**
 * Asks the running older core for a planned restart and resolves once it has
 * closed its connection, so the caller can start the bundled core. Rejects,
 * leaving the core as it was, if it is not an older core that offers the call.
 */
export async function handOverOlderCore(open: () => HcSocket, expectedVersion: string): Promise<void> {
  const old = await connectHc({
    open,
    accepts: (hello) => isOlderBundledLine(hello.version, expectedVersion) && hello.methods.includes("server.restart"),
  });
  const closed = new Promise<void>((resolve) => old.onDisconnect(resolve));
  let timer: NodeJS.Timeout | undefined;
  try {
    await old.call("server.restart", {});
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("older local terminal runtime did not stop for the update")), HANDOVER_CLOSE_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    old.close();
  }
}
