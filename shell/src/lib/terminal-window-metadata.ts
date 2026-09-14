export type TerminalPersistence = "durable" | "ephemeral";

export function createTerminalLayoutId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `term-layout_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
