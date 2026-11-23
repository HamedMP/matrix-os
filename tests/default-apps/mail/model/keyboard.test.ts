import { describe, expect, it } from "vitest";
import { MAIL_KEY_BINDINGS, isEditableTarget, mailCommandForKey } from "../../../../home/apps/mail/src/model/keyboard";

describe("mailCommandForKey", () => {
  it("maps the documented keys", () => {
    const cases: Array<[string, string]> = [
      ["j", "focusNext"], ["k", "focusPrevious"], ["e", "archive"], ["r", "reply"], ["a", "replyAll"],
      ["f", "forward"], ["c", "compose"], ["/", "search"], ["#", "trash"], ["x", "toggleSelect"],
      ["J", "extendNext"], ["K", "extendPrevious"], ["z", "undo"],
    ];
    for (const [key, command] of cases) expect(mailCommandForKey({ key, shiftKey: key !== key.toLowerCase() || key === "#" })).toBe(command);
  });

  it("extends the selection with shift and the arrow keys", () => {
    expect(mailCommandForKey({ key: "ArrowDown", shiftKey: true })).toBe("extendNext");
    expect(mailCommandForKey({ key: "ArrowUp" })).toBe("focusPrevious");
  });

  it("ignores keys while typing, composing or with modifiers", () => {
    expect(mailCommandForKey({ key: "e", editable: true })).toBeNull();
    expect(mailCommandForKey({ key: "e", isComposing: true })).toBeNull();
    expect(mailCommandForKey({ key: "c", metaKey: true })).toBeNull();
    expect(mailCommandForKey({ key: "r", ctrlKey: true })).toBeNull();
    expect(mailCommandForKey({ key: "q" })).toBeNull();
  });

  it("recognises editable targets", () => {
    expect(isEditableTarget({ tagName: "input" })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV" })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it("binds each key once", () => {
    const keys = MAIL_KEY_BINDINGS.map((binding) => binding.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
