const MAX_CSI_LENGTH = 128;
type ParserState = "ground" | "escape" | "escape-intermediate" | "csi" | "ignore-csi" | "string" | "string-escape";
type MouseProtocol = 9 | 1000 | 1002 | 1003 | null;
type MouseEncoding = 1006 | 1016 | null;

/** Current xterm-compatible mouse state, never a replay buffer for terminal output. */
export class TerminalMouseModeState {
  private readonly decoder = new TextDecoder();
  private state: ParserState = "ground";
  private csi = "";
  private osc = false;
  private known = false;
  private protocol: MouseProtocol = null;
  private encoding: MouseEncoding = null;

  observe(data: Uint8Array): void {
    for (const char of this.decoder.decode(data, { stream: true })) this.consume(char);
  }

  bootstrap(): Uint8Array | null {
    if (!this.known) return null;
    // Clear only mouse state in a reused renderer; never switch buffers or
    // reset its screen, selection, cursor, clipboard, or other application modes.
    let sequence = "\x1b[?9;1000;1002;1003;1006;1016l";
    if (this.protocol !== null) sequence += `\x1b[?${this.protocol}h`;
    if (this.encoding !== null) sequence += `\x1b[?${this.encoding}h`;
    return new TextEncoder().encode(sequence);
  }

  private consume(char: string): void {
    // CAN/SUB abort any partial control, including an unterminated string.
    if (char === "\x18" || char === "\x1a") {
      this.state = "ground";
      this.csi = "";
      return;
    }
    if (this.state === "string" || this.state === "string-escape") {
      if (char === "\u009c" || (this.osc && char === "\x07")
        || (this.state === "string-escape" && char === "\\")) {
        this.state = "ground";
      } else {
        this.state = char === "\x1b" ? "string-escape" : "string";
      }
      return;
    }
    if (char === "\x1b") {
      this.state = "escape";
      this.csi = "";
      return;
    }
    if (char === "\u009b") {
      this.state = "csi";
      this.csi = "";
      return;
    }
    if (["\u0090", "\u0098", "\u009d", "\u009e", "\u009f"].includes(char)) {
      this.osc = char === "\u009d";
      this.state = "string";
      return;
    }
    // xterm executes C0 controls without ending an in-progress CSI/escape.
    if (char < " " || char === "\x7f") return;
    if (this.state === "escape") {
      if (char === "[") this.state = "csi";
      else if (["]", "P", "X", "^", "_"].includes(char)) {
        this.osc = char === "]";
        this.state = "string";
      } else if (char >= " " && char <= "/") this.state = "escape-intermediate";
      else {
        if (char === "c") {
          this.protocol = null;
          this.encoding = null;
          this.known = true;
        }
        this.state = "ground";
      }
      return;
    }
    if (this.state === "escape-intermediate") {
      if (char >= "0" && char <= "~") this.state = "ground";
      return;
    }
    if (this.state !== "csi" && this.state !== "ignore-csi") return;
    if (char >= "@" && char <= "~") {
      if (this.state === "csi" && (char === "h" || char === "l") && /^\?[0-9;]+$/.test(this.csi)) {
        for (const parameter of this.csi.slice(1).split(";")) this.setMode(Number(parameter), char === "h");
      }
      // DECSTR (CSI ! p) does not reset mouse state in xterm; RIS does.
      this.state = "ground";
      this.csi = "";
    } else if (this.state === "csi") {
      if (this.csi.length >= MAX_CSI_LENGTH || char > "~") {
        this.state = "ignore-csi";
        this.csi = "";
      } else this.csi += char;
    }
  }

  private setMode(mode: number, enabled: boolean): void {
    // xterm has one active protocol/encoding, not independent enabled flags.
    if (mode === 9 || mode === 1000 || mode === 1002 || mode === 1003) {
      this.protocol = enabled ? mode : null;
      this.known = true;
    } else if (mode === 1006 || mode === 1016) {
      this.encoding = enabled ? mode : null;
      this.known = true;
    }
    // 1005 (UTF8) and 1015 (URXVT) are unsupported by our xterm clients.
  }
}
