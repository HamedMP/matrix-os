type TerminalServerFrame = { type: string; capabilities?: unknown } & Record<string, unknown>;

export function parseTerminalInputCapabilityRequest(value: string | undefined): boolean {
  return value === "binary-input-v1";
}

export function terminalFrameForInputCapabilities<T extends TerminalServerFrame>(
  frame: T,
  binaryInputRequested: boolean,
): T | Omit<T, "capabilities"> {
  if (frame.type !== "attached" || binaryInputRequested || !("capabilities" in frame)) return frame;
  const { capabilities, ...compatibleFrame } = frame;
  void capabilities;
  return compatibleFrame;
}
