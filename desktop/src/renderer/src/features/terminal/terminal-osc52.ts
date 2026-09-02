const MAX_OSC52_BASE64_LENGTH = 1_000_000;
const OSC52_ALLOWED_TARGETS = new Set(["", "c", "p", "s", "0", "1", "2", "3", "4", "5", "6", "7"]);

export type Osc52ClipboardPayload =
  | { handled: false }
  | { handled: true; text: string | null };

export function decodeOsc52Clipboard(data: string): Osc52ClipboardPayload {
  const separator = data.indexOf(";");
  if (separator < 0 || !OSC52_ALLOWED_TARGETS.has(data.slice(0, separator))) {
    return { handled: false };
  }
  const payload = data.slice(separator + 1);
  if (payload === "" || payload === "?") return { handled: true, text: null };
  if (payload.length > MAX_OSC52_BASE64_LENGTH || !/^[A-Za-z0-9+/=]+$/.test(payload)) {
    return { handled: false };
  }
  try {
    const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
    return { handled: true, text: new TextDecoder().decode(bytes) };
  } catch {
    return { handled: false };
  }
}
