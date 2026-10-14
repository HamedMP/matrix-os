/** Pane-local normalization for the two Enter shapes xterm 6 does not translate. */
export function createTerminalEnterInput(options: {
  textarea: HTMLTextAreaElement;
  input(data: string): void;
}) {
  const { textarea } = options;
  const view = textarea.ownerDocument.defaultView! as Window & typeof globalThis;
  let composing = false;
  let compositionSettling = false;
  let keyEnterPending = false;
  let clearTimer: ReturnType<typeof setTimeout> | undefined;
  const focused = (event: Event) => event.target === textarea
    && textarea.ownerDocument.activeElement === textarea;
  const clearAfterTask = () => {
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      keyEnterPending = false;
      compositionSettling = false;
      clearTimer = undefined;
    }, 0);
  };
  const onCompositionStart = () => {
    clearTimeout(clearTimer);
    composing = true;
    compositionSettling = false;
  };
  const onCompositionEnd = () => {
    composing = false;
    compositionSettling = true;
    // IME confirmation can deliver its final input after compositionend.
    clearAfterTask();
  };
  const onInput = (event: Event) => {
    if (!(event instanceof view.InputEvent) || !focused(event)
      || !event.isTrusted || event.inputType !== "insertLineBreak"
      || event.data !== null || event.isComposing || composing || compositionSettling) return;
    // A keyboard event already handled by xterm, a shortcut or this helper must
    // not submit again when its corresponding browser editing event arrives.
    if (!keyEnterPending) options.input("\r");
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  textarea.addEventListener("input", onInput, true);
  textarea.addEventListener("compositionstart", onCompositionStart, true);
  textarea.addEventListener("compositionend", onCompositionEnd, true);

  return {
    /** Call after the existing clipboard/shortcut policy; false means consumed. */
    handleKeyEvent(event: KeyboardEvent, passthrough: boolean): boolean {
      if (!focused(event)) return passthrough;
      if (event.type === "keyup") {
        clearAfterTask();
        return passthrough;
      }
      if (event.type !== "keydown") return passthrough;
      clearTimeout(clearTimer);
      clearTimer = undefined;
      keyEnterPending = event.key === "Enter";
      clearAfterTask();
      if (!passthrough || event.defaultPrevented || !keyEnterPending
        || composing || compositionSettling || event.isComposing || event.keyCode !== 0
        || !["Enter", "NumpadEnter"].includes(event.code)
        || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey
        || event.getModifierState("AltGraph")) return passthrough;
      // Synthetic key-only KeyboardEvents are an explicitly supported automation
      // shape. Emit only a fixed CR; never interpret event payloads as PTY bytes.
      options.input("\r");
      event.preventDefault();
      return false;
    },
    dispose() {
      clearTimeout(clearTimer);
      textarea.removeEventListener("input", onInput, true);
      textarea.removeEventListener("compositionstart", onCompositionStart, true);
      textarea.removeEventListener("compositionend", onCompositionEnd, true);
    },
  };
}
