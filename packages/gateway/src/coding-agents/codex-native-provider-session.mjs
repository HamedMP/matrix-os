import { initializeCodexProvider, ProviderStartupCleanupUnconfirmed, signalCodexProviderChild } from "./codex-provider-startup.mjs";
import { consumeCodexProviderOutput } from "./codex-provider-output.mjs";

/** One native child generation. Only a confirmed close permits a successor. */
export async function startCodexNativeProviderSession(options) {
  const initialized = await initializeCodexProvider(options);
  let expectedStop = false;
  options.onChild(initialized.child);
  const closed = initialized.closed.then((exit) => { options.onClosed?.(); return exit; });
  const output = consumeCodexProviderOutput(initialized.child.stdout, options.onMessage).then(
    () => ({ ok: true }),
    (error) => { if (!expectedStop) options.onFailure(error); return { ok: expectedStop, error }; },
  );
  const errors = (async () => {
    try {
      for await (const _chunk of initialized.child.stderr) { /* Never project provider stderr. */ }
      return { ok: true };
    } catch (error) {
      if (!expectedStop) {
        // Stream errors are not CodexTransportError; retain safe diagnostics
        // here while keeping provider bytes, messages and stacks private.
        const name = error instanceof Error && ["Error", "TypeError", "RangeError", "AbortError", "SystemError"].includes(error.name) ? error.name : "UnknownError";
        const code = error instanceof Error && ["ECONNRESET", "EPIPE", "ERR_STREAM_PREMATURE_CLOSE", "ERR_STREAM_DESTROYED"].includes(error.code) ? error.code : undefined;
        console.warn("[coding-agents] Native stderr stream failed", { name, ...(code ? { code } : {}) });
        options.onFailure(error);
      }
      return { ok: expectedStop, error };
    }
  })();
  return {
    child: initialized.child, closed, output, errors,
    async close() {
      expectedStop = true;
      signalCodexProviderChild(initialized.child, "SIGTERM");
      let force, deadline;
      try {
        force = setTimeout(() => signalCodexProviderChild(initialized.child, "SIGKILL"), 1_000);
        await Promise.race([closed, new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new ProviderStartupCleanupUnconfirmed(initialized.child, closed)), 5_000);
        })]);
        await Promise.all([output, errors]);
      } finally {
        clearTimeout(force);
        clearTimeout(deadline);
      }
    },
  };
}
