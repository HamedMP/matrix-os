// Fixed fixture diagnostics, never raw process paths, messages or stack traces.
export function fixtureErrorKind(error) {
  if (!(error instanceof Error)) return "unknown-error";
  const code = error.code;
  return ["ENOENT", "EACCES", "EBADF", "EPIPE", "ERR_IPC_CHANNEL_CLOSED"].includes(code) ? code : "error";
}

export function logFixtureFailure(stage, error) {
  console.warn("[native inherited control fixture]", stage, fixtureErrorKind(error));
}
