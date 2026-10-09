/** Ordinary closes stay synchronous; guarded native closes retain all UI until approved. */
export function afterTabClose(result: boolean | Promise<boolean>, action: () => void): void {
  if (typeof result === "boolean") { if (result) action(); }
  else void result.then(approved => { if (approved) action(); });
}
