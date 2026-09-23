type TerminalServerFrame = { type: string; capabilities?: unknown } & Record<string, unknown>;

export function parseTerminalInputCapabilityRequest(value: string | undefined): boolean {
  return value === "binary-input-v1";
}

export function parseTerminalScrollCapabilityRequest(value: string | undefined): boolean {
  return value === "native-scroll-v1";
}

export function terminalFrameForInputCapabilities<T extends TerminalServerFrame>(
  frame: T,
  binaryInputRequested: boolean,
  nativeScrollRequested = false,
): T | Omit<T, "capabilities"> {
  if (frame.type !== "attached" || !("capabilities" in frame)) return frame;
  const { capabilities, ...compatibleFrame } = frame;
  const advertised = Array.isArray(capabilities) ? capabilities.filter((capability) =>
    (capability === "binary-input-v1" && binaryInputRequested)
    || (capability === "native-scroll-v1" && nativeScrollRequested)) : [];
  return advertised.length > 0 ? { ...compatibleFrame, capabilities: advertised } as T : compatibleFrame;
}
