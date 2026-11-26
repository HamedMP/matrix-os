import { stripVTControlCharacters } from "node:util";
import { z } from "zod/v4";
import {
  LOCAL_TERMINAL_LIST_MAX, LocalTerminalIdSchema,
} from "../../shared/local-terminals";
import { MAC_TERMINAL_SNAPSHOT_MAX_CHARS } from "../../shared/mac-terminal-probe-ipc";
import type { HcConnection } from "./hc-client";
import { safeTerminalTitle, TERMINAL_TITLE_LABEL } from "./hc-sessions";

const MAX_PICKER_TERMINALS = 20;
const RPC_TIMEOUT_MS = 3_000;
// A screen snapshot from herdr-core is plain text, capped as before output moved to bytes.
const SCREEN_MAX_CHARS = 262_144;
const TerminalList = z.object({ terminals: z.array(z.unknown()).max(LOCAL_TERMINAL_LIST_MAX) });
const LiveTerminal = z.object({
  address: LocalTerminalIdSchema,
  state: z.literal("live"),
  created_ms: z.int().nonnegative(),
  pid: z.int().positive(),
});
const TitledTerminal = LiveTerminal.extend({
  title: z.string().nullish().catch(null),
  name: z.string().nullish().catch(null),
  labels: z.record(z.string(), z.string()).nullish().catch(null),
});
const Screen = z.object({
  how: z.literal("screen"),
  complete: z.literal(true),
  text: z.string().max(SCREEN_MAX_CHARS),
});
// Preserve only newline and tab among control characters. Remove direction
// overrides and unpaired surrogates before handing plain text to native UI.
const UNSAFE_SCREEN_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Bidi_Control}\p{Surrogate}]/gu;

export interface ExistingTerminalReader {
  terminals: readonly { id: string; title: string }[];
  read(id: string, signal: AbortSignal, options?: { allowEmpty?: boolean }): Promise<string>;
  assertCurrent(id: string, signal: AbortSignal): Promise<void>;
  assertConnected(): void;
}

function snapshot(text: string, allowEmpty = false): string {
  const clean = stripVTControlCharacters(text).replace(/\r\n/g, "\n").replace(UNSAFE_SCREEN_CHARS, "").trim();
  if (!clean && !allowEmpty) throw new Error("Local terminal screen is empty");
  return clean.length <= MAC_TERMINAL_SNAPSHOT_MAX_CHARS
    ? clean : Array.from(clean).slice(-MAC_TERMINAL_SNAPSHOT_MAX_CHARS).join("").trimStart();
}

/** Pin the picker to a core connection and the original process for each listed terminal. */
export async function openExistingTerminalReader(
  core: HcConnection, isCurrent: () => boolean,
): Promise<ExistingTerminalReader> {
  function requireConnection(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!isCurrent()) throw new Error("Local terminal connection changed");
  }

  // Use the same pinned connection for all calls. A fresh connection must
  // start a fresh selection and can never resume a read for an old selection.
  async function call(method: "terminal.list" | "terminal.get" | "terminal.read", params: Record<string, unknown>, signal?: AbortSignal) {
    requireConnection(signal);
    const reply = await core.call(method, params, RPC_TIMEOUT_MS);
    requireConnection(signal);
    return reply;
  }

  const list = TerminalList.parse(await call("terminal.list", {}));
  const candidates = new Map<string, z.infer<typeof TitledTerminal>>();
  const duplicates = new Set<string>();
  for (const raw of list.terminals) {
    const terminal = TitledTerminal.safeParse(raw);
    if (!terminal.success) continue;
    const { address } = terminal.data;
    if (candidates.has(address)) duplicates.add(address);
    candidates.set(address, terminal.data);
  }
  for (const address of duplicates) candidates.delete(address);

  const selected = Array.from(candidates.values()).slice(0, MAX_PICKER_TERMINALS);
  const terminals = selected.map(({ address, title, name, labels }) => ({
    id: address, title: safeTerminalTitle(labels?.[TERMINAL_TITLE_LABEL], title, name),
  }));

  async function assertCurrent(id: string, signal: AbortSignal) {
    const original = selected.find(entry => entry.address === id);
    if (!original) throw new Error("Local terminal was not listed");
    const live = LiveTerminal.parse(await call("terminal.get", { terminal: id }, signal));
    if (live.address !== original.address || live.created_ms !== original.created_ms || live.pid !== original.pid) {
      throw new Error("Local terminal changed");
    }
  }

  return {
    terminals,
    assertCurrent,
    assertConnected: requireConnection,
    async read(id, signal, options) {
      await assertCurrent(id, signal);
      // Positive history lines can send scroll keys to a full-screen app.
      // Restrict the pinned Herdr Core read to the visible screen.
      const result = Screen.parse(await call("terminal.read", { terminal: id, lines: 0 }, signal));
      await assertCurrent(id, signal);
      return snapshot(result.text, options?.allowEmpty);
    },
  };
}
