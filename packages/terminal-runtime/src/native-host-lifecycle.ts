import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { TerminalNativeHostRefSchema, type TerminalNativeHostRef, type TerminalRef, type TerminalTab } from "@matrix-os/contracts";
import { validateTerminalClosure } from "./generation-closure.mjs";
import { readTerminalHostDescriptor, terminalHostUnit } from "./native-host-descriptor.js";
import { inspectTerminalHostUnit, stopTerminalHostUnit, type TerminalManagerCommand } from "./native-host-unit.js";
import { TerminalRuntimeError } from "./errors.js";
import type { TerminalWorkspaceStore } from "./workspace-store.js";
export interface NativeTabAdmission {
  tabId: string; name: string; cwd: string; nativeHost: TerminalNativeHostRef; agent?: TerminalTab["agent"];
}
export interface NativeTabReservation { tab: TerminalTab; settlementToken: string }
export interface NativeTabCompletion {
  expectedIncarnation: string; nativeHost: TerminalNativeHostRef; attach: boolean;
  settlementToken: string; outcome: "never-dispatched" | "settled" | "uncertain";
}
export interface NativeTerminalHosts {
  inspect(reference: TerminalNativeHostRef): Promise<{ status: "running" | "stopped" | "unknown" }>;
  stop(reference: TerminalNativeHostRef): Promise<{ status: "stopped" | "unknown" }>;
  attachCommand(reference: TerminalNativeHostRef): Promise<string[]>;
}
/** I/O and explicit workload cleanup only. This module has no source factory, capability or private launch channel. */
export function createNativeTerminalHosts(options: { homePath: string; runtimeRoot?: string; namespaceRoot?: string; runCommand?: TerminalManagerCommand }): NativeTerminalHosts {
  const home = resolve(options.homePath), runtimeRoot = resolve(options.runtimeRoot ?? "/opt/matrix/terminal-runtime"), uid = process.getuid?.();
  if (uid === undefined) throw new Error("Terminal host unavailable");
  const namespace = resolve(options.namespaceRoot ?? `/run/user/${uid}`), exec = promisify(execFile);
  const run: TerminalManagerCommand = options.runCommand ?? ((command, args) => exec(command, args, { timeout: 15000, maxBuffer: 512 * 1024, encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` } }));
  async function descriptor(input: TerminalNativeHostRef) {
    const reference = TerminalNativeHostRefSchema.parse({ path: input.path, generation: input.generation }), directory = dirname(reference.path);
    if (dirname(directory) !== namespace) throw new Error("Terminal namespace mismatch");
    const id = basename(directory).slice("matrix-terminal-".length);
    const { descriptor } = await readTerminalHostDescriptor(join(home, "system", "terminal-runtimes", `native-${id}.json`));
    if (descriptor.launchId !== id || descriptor.directory !== directory || descriptor.generation !== reference.generation) throw new Error("Terminal descriptor mismatch");
    return descriptor;
  }
  return {
    async inspect(reference) {
      try { const value = await descriptor(reference); return { status: (await inspectTerminalHostUnit(terminalHostUnit(value.launchId), run)).running ? "running" : "stopped" }; }
      catch (error) { console.warn("[terminal-runtime] Native host state unknown", error instanceof Error ? error.name : "UnknownError"); return { status: "unknown" }; }
    },
    async stop(reference) { const value = await descriptor(reference); return stopTerminalHostUnit(terminalHostUnit(value.launchId), run); },
    async attachCommand(reference) {
      const value = await descriptor(reference), directory = join(runtimeRoot, "generations", value.generation);
      for (const path of [runtimeRoot, join(runtimeRoot, "generations"), directory]) {
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o022) throw new Error("Terminal generation unavailable");
      }
      await validateTerminalClosure(directory, value.generation);
      return [join(directory, "node"), join(directory, "terminal-io-attach.mjs"), reference.path];
    },
  };
}
/** Called under canonical workspace mutation ordering. Source validation reads this same durable fence. */
export async function stopCanonicalNativeHost(store: TerminalWorkspaceStore, hosts: NativeTerminalHosts | undefined, ref: TerminalRef) {
  const tab = await store.getTab(ref);
  if (!tab?.nativeHost) return;
  await store.fenceNativeHost(ref);
  if (tab.nativeHost.managerStopped && !tab.nativeHost.dispatchPending) return;
  if (!hosts) throw new TerminalRuntimeError("unavailable");
  let stopped = false;
  try { stopped = (await hosts.stop({ path: tab.nativeHost.path, generation: tab.nativeHost.generation })).status === "stopped"; }
  catch (error) { console.warn("[terminal-runtime] Native stop unavailable", error instanceof Error ? error.name : "UnknownError"); }
  // A stop racing an unfinished dispatch cannot prove that a later spawn will not occur.
  // Keep the actual canonical record/fence even if the current unit is absent/stopped.
  if (!stopped || tab.nativeHost.dispatchPending) throw new TerminalRuntimeError("unavailable");
  await store.fenceNativeHost(ref, true);
}
