/** Read the nonce from the same injected document that a real app bridge uses. */
export function injectedAppBridgeToken(frame: HTMLIFrameElement): string {
  const match = frame.getAttribute("srcdoc")?.match(/\bvar bridgeToken = ("[^"]+");/);
  if (!match) throw new Error("App test frame has no injected document token");
  return JSON.parse(match[1]) as string;
}
