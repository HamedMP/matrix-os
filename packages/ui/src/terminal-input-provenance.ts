interface Disposable { dispose(): void; }
interface DataSource { onData(listener: (data: string) => void): Disposable; }

/** Pinned xterm emits onUserInput immediately before onData for keys, paste and composition.
 * Automatic terminal replies bypass it. Isolate this private hook and fall back to counting
 * input if an emulator version does not expose it; never infer provenance from the bytes. */
export function observeTerminalData(terminal: DataSource, listener: (data: string, isUserInput: boolean) => void): Disposable {
  const core = (terminal as DataSource & { _core?: { coreService?: { onUserInput?: (listener: () => void) => Disposable } } })._core?.coreService;
  let userInput = false;
  const provenance = typeof core?.onUserInput === "function" ? core.onUserInput(() => { userInput = true; }) : undefined;
  const data = terminal.onData((value) => {
    const fromUser = provenance ? userInput : true;
    userInput = false;
    listener(value, fromUser);
  });
  let disposed = false;
  return { dispose: () => { if (!disposed) { disposed = true; data.dispose(); provenance?.dispose(); } } };
}
