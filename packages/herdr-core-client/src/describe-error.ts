// One line for the main-process log: the error's name, system code and
// message. These strings stay in the trusted core's log; renderers only ever
// receive fixed outcomes.
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  const code = (error as NodeJS.ErrnoException).code;
  return `${error.name}${typeof code === "string" ? ` (${code})` : ""}: ${error.message.slice(0, 300)}`;
}
