import { randomBytes } from "node:crypto";
import {
  MAC_TERMINAL_SYSTEM_CHECKS, MacTerminalSystemCheckOutputSchema,
  type MacTerminalProbeAction, type MacTerminalProbeOutput,
} from "../../shared/mac-terminal-probe";
import { HcCallError, type HcConnection, type HcStream } from "./hc-client";
import { TERMINAL_TITLE_LABEL, type AttachmentSlots } from "./hc-sessions";

const SIZE = { cols: 80, rows: 24 };
const EXECUTION_MS = 8_000;
const MAX_OUTPUT_BYTES = 4_096;
// Both scripts are static. No request data, user's login shell or startup
// files reach the terminal. The reads also limit its lifetime if the app quits.
const WAIT_FOR_APPROVAL = String.raw`
/bin/stty -echo || exit 1
printf '\nMac terminal check ready\n\033[8mMATRIX_MAC_PROBE_READY:%s:\033[0m\n' "$2"
IFS= read -r -t 300 trigger || exit 1
[ "$trigger" = "$1" ] || exit 1
`;
const [readKernel, readArchitecture, readVersion] = MAC_TERMINAL_SYSTEM_CHECKS;
const COMMANDS: Record<MacTerminalProbeAction, string> = {
  uname: String.raw`
printf '${readKernel}\n'
result=$(${readKernel}) || exit 1
printf '%s\n\033[8mMATRIX_MAC_PROBE_RESULT:%s:%s:\033[0m\n' "$result" "$2" "$result"
`,
  "system-checks": String.raw`
printf '${readKernel}\n'
kernel=$(${readKernel}) || exit 1
printf '%s\n${readArchitecture}\n' "$kernel"
architecture=$(${readArchitecture}) || exit 1
printf '%s\n${readVersion}\n' "$architecture"
version=$(${readVersion}) || exit 1
printf '%s\n\033[8mMATRIX_MAC_CHECKS:%s:%s,%s,%s:\033[0m\n' "$version" "$2" "$kernel" "$architecture" "$version"
`,
};

function readOutput(output: string, tag: string, action: MacTerminalProbeAction): MacTerminalProbeOutput | undefined {
  if (action === "uname") {
    return output.includes(`MATRIX_MAC_PROBE_RESULT:${tag}:Darwin:`) ? "Darwin" : undefined;
  }
  // The complete frame fits on one PTY row. The tag and fixed value alphabet
  // isolate the receipt from unrelated terminal output.
  const frame = new RegExp(`MATRIX_MAC_CHECKS:${tag}:(Darwin),(arm64|x86_64),([0-9.]{3,11}):`, "g");
  for (const [, kernel, architecture, macOSVersion] of output.matchAll(frame)) {
    const result = MacTerminalSystemCheckOutputSchema.safeParse({ kernel, architecture, macOSVersion });
    if (result.success) return result.data;
  }
  return undefined;
}

export interface ChatTerminalProbe {
  id: string;
  run(signal: AbortSignal): Promise<MacTerminalProbeOutput>;
  dispose(): Promise<void>;
}

async function runProbe(input: {
  core: HcConnection;
  id: string;
  trigger: string;
  tag: string;
  action: MacTerminalProbeAction;
  signal: AbortSignal;
  slots: AttachmentSlots;
}): Promise<MacTerminalProbeOutput> {
  const { core, id, trigger, tag, action, signal, slots } = input;
  signal.throwIfAborted();
  const slot = slots.acquire();
  if (slot === null) throw new Error("too many local terminal attachments");

  let stream: HcStream | undefined;
  let ready = false;
  let sent = false;
  let settled = false;
  let bytes = 0;
  let output = "";
  let resolveResult!: (value: MacTerminalProbeOutput) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<MacTerminalProbeOutput>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    rejectResult(error);
  };
  const abort = () => fail(signal.reason);
  const send = () => {
    if (!ready || !stream || sent || settled) return;
    signal.throwIfAborted();
    sent = true;
    // A result can only come from output produced after delivery.
    output = "";
    stream.write(Buffer.from(`${trigger}\r`, "ascii"));
  };
  signal.addEventListener("abort", abort, { once: true });
  void core.attach({ terminal: id, ...SIZE }, {
    onData(chunk, consumed) {
      try {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) throw new Error("Mac terminal check output is too large");
        output += chunk.toString("utf8");
        // The core replays its rendered screen with ANSI cursor positioning
        // instead of preserving raw newlines. Match the framed tag itself.
        if (!sent && output.includes(`MATRIX_MAC_PROBE_READY:${tag}:`)) {
          ready = true;
          send();
        } else if (sent) {
          const value = readOutput(output, tag, action);
          if (value !== undefined) {
            settled = true;
            resolveResult(value);
          }
        }
      } catch (error: unknown) {
        fail(error);
      } finally {
        consumed();
      }
    },
    onClose: () => fail(new Error("Mac terminal check closed")),
  }).then((attached) => {
    if (settled) { attached.close(); return; }
    stream = attached;
    send();
  }).catch(fail);

  try {
    return await result;
  } finally {
    signal.removeEventListener("abort", abort);
    try { stream?.close(); }
    finally { slots.release(slot); }
  }
}

export async function prepareChatTerminalProbe(options: {
  cwd: string;
  action: MacTerminalProbeAction;
  ensure(): Promise<HcConnection>;
  isCurrent(core: HcConnection): boolean;
  run(params: Record<string, unknown>): Promise<string | null>;
  slots: AttachmentSlots;
}): Promise<ChatTerminalProbe> {
  const trigger = randomBytes(16).toString("hex");
  const tag = randomBytes(16).toString("hex");
  const core = await options.ensure();
  const script = WAIT_FOR_APPROVAL + COMMANDS[options.action] + "IFS= read -r -t 60 unused\n";
  const id = await options.run({
    argv: ["/usr/bin/env", "-i", "/bin/bash", "--noprofile", "--norc", "-c", script, "matrix-mac-terminal-check", trigger, tag],
    cwd: options.cwd,
    labels: { [TERMINAL_TITLE_LABEL]: "Mac terminal check" },
    size: SIZE,
    no_parent: true,
    no_notify: true,
    wait: false,
  });
  // An address from a replacement core is not the address we prepared.
  if (id === null || !options.isCurrent(core)) throw new Error("Mac terminal check unavailable");

  let started = false;
  let disposal: Promise<void> | undefined;
  const lifecycle = new AbortController();
  return {
    id,
    async run(signal) {
      lifecycle.signal.throwIfAborted();
      signal.throwIfAborted();
      if (started) throw new Error("Mac terminal check already used");
      started = true;
      return runProbe({ core, id, trigger, tag, action: options.action, slots: options.slots,
        signal: AbortSignal.any([signal, lifecycle.signal, AbortSignal.timeout(EXECUTION_MS)]) });
    },
    dispose() {
      lifecycle.abort();
      // Never redial on cleanup: terminal IDs can be reused by a new core.
      disposal ??= core.call("terminal.kill", { terminal: id }).then(() => undefined).catch((error: unknown) => {
        if (!(error instanceof HcCallError) || error.kind !== "not_found") throw error;
      });
      return disposal;
    },
  };
}
