// One line for the main-process log: the error's name, system code (or the
// core's error kind) and message. These strings stay in the trusted core's
// log; renderers only ever receive fixed outcomes.
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  const code = (error as NodeJS.ErrnoException).code;
  // The core's refusal kind (for example `not_found`), bounded so a log line stays one line.
  const kind = (error as { kind?: unknown }).kind;
  const tag = typeof code === "string" ? code : typeof kind === "string" ? kind.slice(0, 64) : null;
  return `${error.name}${tag ? ` (${tag})` : ""}: ${error.message.slice(0, 300)}`;
}
