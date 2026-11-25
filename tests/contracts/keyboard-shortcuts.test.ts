import { describe, expect, it } from "vitest";
import {
  EMPTY_SHORTCUT_OVERRIDES,
  MAX_BINDINGS_PER_ACTION,
  SHORTCUT_ACTION_IDS,
  SHORTCUT_ACTIONS,
  ShortcutOverridesSchema,
  addBinding,
  bindingFromKeyEvent,
  characterBindingFromKeyEvent,
  findConflict,
  fixedKeyOwner,
  formatBinding,
  shortcutScope,
  heldModifiers,
  isOverridden,
  removeBinding,
  resetAction,
  resolveShortcuts,
  validateBinding,
  validateOverrides,
  type KeyEventLike,
  type ShortcutOverrides,
  type ShortcutPlatform,
} from "../../packages/contracts/src/keyboard-shortcuts";

const PLATFORMS: ShortcutPlatform[] = ["mac", "other"];

function keyEvent(partial: Partial<KeyEventLike> & Pick<KeyEventLike, "key" | "code">): KeyEventLike {
  return { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...partial };
}

function overrides(map: Record<string, string[]>): ShortcutOverrides {
  return { version: 1, overrides: map };
}

describe("SHORTCUT_ACTIONS", () => {
  it("defines every action id exactly once, in registry order", () => {
    expect(SHORTCUT_ACTIONS.map((action) => action.id)).toEqual([...SHORTCUT_ACTION_IDS]);
  });

  it("gives every action a label and a one-sentence description", () => {
    for (const action of SHORTCUT_ACTIONS) {
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.description).toMatch(/^[A-Z].*\.$/);
    }
  });

  it.each(PLATFORMS)("ships only defaults that pass validateBinding on %s", (platform) => {
    for (const action of SHORTCUT_ACTIONS) {
      for (const binding of action.defaults[platform]) {
        expect({ id: action.id, binding, result: validateBinding(binding, platform) }).toEqual({
          id: action.id,
          binding,
          result: { ok: true },
        });
      }
    }
  });
});

describe("bindingFromKeyEvent", () => {
  it("orders modifiers canonically", () => {
    expect(bindingFromKeyEvent({ key: "Tab", code: "Tab", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }, "mac")).toBe("Ctrl+Shift+Tab");
    expect(bindingFromKeyEvent(keyEvent({ key: "T", code: "KeyT", metaKey: true, ctrlKey: true, altKey: true, shiftKey: true }), "mac")).toBe("Cmd+Ctrl+Alt+Shift+T");
  });

  it("returns null for modifier-only events and Escape", () => {
    expect(bindingFromKeyEvent({ key: "Meta", code: "MetaLeft", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, "mac")).toBeNull();
    expect(bindingFromKeyEvent(keyEvent({ key: "Shift", code: "ShiftLeft", shiftKey: true }), "other")).toBeNull();
    expect(bindingFromKeyEvent(keyEvent({ key: "Escape", code: "Escape", ctrlKey: true }), "other")).toBeNull();
  });

  it("falls back to the US key for e.code on non-Latin layouts", () => {
    expect(bindingFromKeyEvent({ key: "ض", code: "KeyQ", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, "mac")).toBe("Cmd+Q");
  });

  it("falls back to e.code when Option produces a symbol", () => {
    expect(bindingFromKeyEvent({ key: "¡", code: "Digit1", metaKey: true, ctrlKey: false, altKey: true, shiftKey: false }, "mac")).toBe("Cmd+Alt+1");
    expect(bindingFromKeyEvent(keyEvent({ key: "Dead", code: "KeyE", altKey: true }), "mac")).toBe("Alt+E");
  });

  it("prefers the character on the key when it is printable ASCII", () => {
    expect(bindingFromKeyEvent({ key: "a", code: "KeyQ", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, "other")).toBe("Ctrl+A");
    expect(bindingFromKeyEvent(keyEvent({ key: ",", code: "Comma", metaKey: true }), "mac")).toBe("Cmd+,");
  });

  it("uses e.code when Shift turns the key into a character outside the key set", () => {
    expect(bindingFromKeyEvent(keyEvent({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }), "other")).toBe("Ctrl+Shift+1");
  });

  it("uses the digit from e.code when the digit row types punctuation (AZERTY)", () => {
    expect(bindingFromKeyEvent(keyEvent({ key: "'", code: "Digit4", metaKey: true }), "mac")).toBe("Cmd+4");
    expect(bindingFromKeyEvent(keyEvent({ key: "-", code: "Digit6", ctrlKey: true }), "other")).toBe("Ctrl+6");
    expect(bindingFromKeyEvent(keyEvent({ key: "-", code: "Minus", metaKey: true }), "mac")).toBe("Cmd+-");
  });

  it("reports the typed character separately so native menu keys can win on the digit row", () => {
    expect(characterBindingFromKeyEvent(keyEvent({ key: "-", code: "Digit6", metaKey: true }), "mac")).toBe("Cmd+-");
    expect(characterBindingFromKeyEvent(keyEvent({ key: "6", code: "Digit6", metaKey: true }), "mac")).toBe("Cmd+6");
    expect(characterBindingFromKeyEvent(keyEvent({ key: "Escape", code: "Escape", metaKey: true }), "mac")).toBeNull();
  });

  it("maps named keys", () => {
    expect(bindingFromKeyEvent({ key: " ", code: "Space", metaKey: false, ctrlKey: false, altKey: true, shiftKey: false }, "mac")).toBe("Alt+Space");
    expect(bindingFromKeyEvent(keyEvent({ key: "ArrowUp", code: "ArrowUp", ctrlKey: true }), "other")).toBe("Ctrl+Up");
    expect(bindingFromKeyEvent(keyEvent({ key: "F5", code: "F5" }), "other")).toBe("F5");
  });

  it("never produces Cmd on other platforms", () => {
    expect(bindingFromKeyEvent(keyEvent({ key: "k", code: "KeyK", metaKey: true, ctrlKey: true }), "other")).toBe("Ctrl+K");
  });

  it("returns null when no supported key can be determined", () => {
    expect(bindingFromKeyEvent(keyEvent({ key: "Unidentified", code: "IntlRo", ctrlKey: true }), "other")).toBeNull();
  });
});

describe("heldModifiers", () => {
  it("lists held modifiers in canonical order", () => {
    expect(heldModifiers(keyEvent({ key: "Shift", code: "ShiftLeft", shiftKey: true, metaKey: true, altKey: true }), "mac")).toEqual(["Cmd", "Alt", "Shift"]);
  });

  it("ignores metaKey on other platforms", () => {
    expect(heldModifiers(keyEvent({ key: "Meta", code: "MetaLeft", metaKey: true, ctrlKey: true }), "other")).toEqual(["Ctrl"]);
  });
});

describe("validateBinding", () => {
  it("requires Cmd, Ctrl or Alt unless the key is a function key", () => {
    expect(validateBinding("Shift+A", "mac")).toEqual({ ok: false, reason: "needs-modifier" });
    expect(validateBinding("A", "other")).toEqual({ ok: false, reason: "needs-modifier" });
    expect(validateBinding("F5", "mac")).toEqual({ ok: true });
  });

  it("rejects operating-system shortcuts", () => {
    expect(validateBinding("Cmd+Space", "mac")).toEqual({ ok: false, reason: "reserved-system" });
    expect(validateBinding("Cmd+`", "mac")).toEqual({ ok: false, reason: "reserved-system" });
    expect(validateBinding("Alt+F4", "other")).toEqual({ ok: false, reason: "reserved-system" });
    expect(validateBinding("Alt+Space", "other")).toEqual({ ok: false, reason: "reserved-system" });
    expect(validateBinding("Alt+Space", "mac")).toEqual({ ok: true });
  });

  it("rejects fixed menu roles with the role name", () => {
    expect(validateBinding("Cmd+C", "mac")).toEqual({ ok: false, reason: "reserved-menu", role: "Copy" });
    expect(validateBinding("Ctrl+Shift+Z", "other")).toEqual({ ok: false, reason: "reserved-menu", role: "Redo" });
    expect(validateBinding("Cmd+Alt+H", "mac")).toEqual({ ok: false, reason: "reserved-menu", role: "Hide Others" });
    expect(validateBinding("F11", "other")).toEqual({ ok: false, reason: "reserved-menu", role: "Full Screen" });
    expect(validateBinding("Ctrl+Alt+7", "other")).toMatchObject({ ok: false, reason: "reserved-menu" });
    expect(validateBinding("Ctrl+H", "other")).toEqual({ ok: true });
    expect(validateBinding("Cmd+Alt+I", "mac")).toEqual({ ok: false, reason: "reserved-menu", role: "Developer Tools" });
    expect(validateBinding("Ctrl+Shift+I", "other")).toEqual({ ok: false, reason: "reserved-menu", role: "Developer Tools" });
    expect(validateBinding("Cmd+Alt+Shift+V", "mac")).toEqual({ ok: false, reason: "reserved-menu", role: "Paste and Match Style" });
  });

  it("rejects malformed bindings", () => {
    expect(validateBinding("Cmd+Q", "other")).toEqual({ ok: false, reason: "invalid" });
    expect(validateBinding("Shift+Ctrl+A", "other")).toEqual({ ok: false, reason: "invalid" });
    expect(validateBinding("Ctrl+Ctrl+A", "other")).toEqual({ ok: false, reason: "invalid" });
    expect(validateBinding("Ctrl+a", "other")).toEqual({ ok: false, reason: "invalid" });
    expect(validateBinding("Ctrl+", "other")).toEqual({ ok: false, reason: "invalid" });
    expect(validateBinding("Ctrl+Escape", "other")).toEqual({ ok: false, reason: "invalid" });
    expect(validateBinding("", "mac")).toEqual({ ok: false, reason: "invalid" });
    expect(validateBinding(`Ctrl+${"A".repeat(40)}`, "other")).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("resolveShortcuts", () => {
  it("returns the shipped defaults with no overrides", () => {
    expect(resolveShortcuts(null, "mac")["app.next"]).toEqual(["Ctrl+Tab"]);
    expect(resolveShortcuts(null, "mac")["app.launcher"]).toEqual(["Alt+Space"]);
    expect(resolveShortcuts(null, "other")["app.launcher"]).toEqual(["Ctrl+Space"]);
    expect(resolveShortcuts(null, "mac")["app.switch-3"]).toEqual(["Cmd+3"]);
    expect(resolveShortcuts(null, "mac")["app.show-desktop"]).toEqual([]);
    expect(resolveShortcuts(null, "other")["terminal.window"]).toEqual(["Ctrl+Alt+Shift+T"]);
    expect(resolveShortcuts(EMPTY_SHORTCUT_OVERRIDES, "other")["nav.settings"]).toEqual(["Ctrl+,"]);
  });

  it.each(PLATFORMS)("ships window arrangement keys that stay clear of Rectangle and Magnet on %s", (platform) => {
    const effective = resolveShortcuts(null, platform);
    // Ctrl+Shift on macOS (Rectangle and Magnet own Ctrl+Option there);
    // Ctrl+Alt elsewhere, where Ctrl+Shift+arrow selects text by word.
    const m = platform === "mac" ? "Ctrl+Shift" : "Ctrl+Alt";
    expect({
      left: effective["app.tile-left"],
      right: effective["app.tile-right"],
      top: effective["app.tile-top"],
      bottom: effective["app.tile-bottom"],
      fullSize: effective["app.toggle-full-size"],
      restore: effective["app.restore-size"],
    }).toEqual({
      left: [`${m}+Left`],
      right: [`${m}+Right`],
      top: [`${m}+Up`],
      bottom: [`${m}+Down`],
      fullSize: [`${m}+Enter`],
      restore: [`${m}+Backspace`],
    });
    for (const id of ["app.tile-left", "app.tile-right", "app.tile-top", "app.tile-bottom", "app.restore-size"] as const) {
      expect(SHORTCUT_ACTIONS.find((action) => action.id === id)?.group).toBe("apps");
    }
  });

  it.each(PLATFORMS)("has no binding on two actions of one scope by default on %s", (platform) => {
    const effective = resolveShortcuts(null, platform);
    for (const scope of ["main", "terminal-window"] as const) {
      const all = SHORTCUT_ACTION_IDS.filter((id) => shortcutScope(id) === scope).flatMap((id) => effective[id]);
      expect(new Set(all).size, scope).toBe(all.length);
    }
  });

  // Spec 2706: the Terminal window's commands are registry actions that apply only in that window,
  // so they keep Herdr's keys even where the main window uses the same ones.
  it("keeps the Terminal window's keys in a scope of their own", () => {
    const effective = resolveShortcuts(null, "mac");
    expect(effective["terminal-window.close-pane"]).toEqual(["Cmd+W"]);
    expect(effective["tabs.close"]).toEqual(["Cmd+W"]);
    expect(effective["terminal-window.next-tab"]).toEqual(["Ctrl+Tab"]);
    expect(effective["app.next"]).toEqual(["Ctrl+Tab"]);
    expect(effective["terminal-window.overview"]).toEqual(["Cmd+Shift+O"]);
    expect(findConflict(effective, "Cmd+W", "terminal-window.split-right")).toBe("terminal-window.close-pane");
    expect(findConflict(effective, "Cmd+W", "nav.palette")).toBe("tabs.close");
    // Moving a key within the Terminal window takes it off that window's action only.
    const moved = resolveShortcuts(addBinding(EMPTY_SHORTCUT_OVERRIDES, "terminal-window.split-right", "Cmd+W", "mac"), "mac");
    expect(moved["terminal-window.split-right"]).toEqual(["Cmd+D", "Cmd+W"]);
    expect(moved["terminal-window.close-pane"]).toEqual([]);
    expect(moved["tabs.close"]).toEqual(["Cmd+W"]);
    // Its fixed digits are never bound to an action; main-window actions may still use them.
    expect(fixedKeyOwner("terminal-window.split-right", "Cmd+3", "mac")).toBe("Select terminal 3");
    expect(fixedKeyOwner("terminal-window.split-right", "Ctrl+4", "other")).toBe("Switch to space 4");
    expect(fixedKeyOwner("app.close", "Cmd+3", "mac")).toBeNull();
    expect(addBinding(EMPTY_SHORTCUT_OVERRIDES, "terminal-window.split-right", "Cmd+3", "mac")).toBe(EMPTY_SHORTCUT_OVERRIDES);
    // Elsewhere Ctrl alone stays with the shell.
    expect(resolveShortcuts(null, "other")["terminal-window.split-right"]).toEqual(["Ctrl+Shift+D"]);
  });

  it("uses an override list, including an empty list for unbound", () => {
    const effective = resolveShortcuts(overrides({ "app.next": ["Alt+N", "Ctrl+Tab"], "nav.palette": [] }), "mac");
    expect(effective["app.next"]).toEqual(["Alt+N", "Ctrl+Tab"]);
    expect(effective["nav.palette"]).toEqual([]);
  });

  it("ignores unknown action ids", () => {
    const effective = resolveShortcuts(overrides({ "app.gone": ["Alt+N"] }), "mac");
    expect(effective).not.toHaveProperty("app.gone");
    expect(effective["app.next"]).toEqual(["Ctrl+Tab"]);
  });

  it("falls back to defaults for corrupt or future-version input", () => {
    const corrupt = { version: 2 } as unknown as ShortcutOverrides;
    expect(resolveShortcuts(corrupt, "mac")).toEqual(resolveShortcuts(null, "mac"));
    const future = { version: 2, overrides: { "app.next": ["Alt+N"] } } as unknown as ShortcutOverrides;
    expect(resolveShortcuts(future, "mac")["app.next"]).toEqual(["Ctrl+Tab"]);
  });

  it("removes a default from its action when an override takes it", () => {
    const effective = resolveShortcuts(overrides({ "app.launcher": ["Cmd+K"] }), "mac");
    expect(effective["app.launcher"]).toEqual(["Cmd+K"]);
    expect(effective["nav.palette"]).toEqual([]);
  });
});

describe("findConflict", () => {
  it("returns the other action holding the binding", () => {
    const effective = resolveShortcuts(null, "mac");
    expect(findConflict(effective, "Cmd+K", "app.launcher")).toBe("nav.palette");
  });

  it("ignores the excepted action and unused bindings", () => {
    const effective = resolveShortcuts(null, "mac");
    expect(findConflict(effective, "Cmd+K", "nav.palette")).toBeNull();
    expect(findConflict(effective, "Alt+N", "app.next")).toBeNull();
  });
});

describe("validateOverrides", () => {
  it("accepts empty and well-formed overrides", () => {
    expect(validateOverrides(EMPTY_SHORTCUT_OVERRIDES, "mac")).toBe(true);
    expect(validateOverrides(overrides({ "app.launcher": ["Cmd+K"], "nav.palette": [] }), "mac")).toBe(true);
  });

  it("rejects an unknown action id", () => {
    expect(validateOverrides(overrides({ "app.gone": ["Alt+N"] }), "mac")).toBe(false);
  });

  it("rejects more than the maximum number of bindings", () => {
    const five = ["Alt+1", "Alt+2", "Alt+3", "Alt+4", "Alt+5"];
    expect(five.length).toBeGreaterThan(MAX_BINDINGS_PER_ACTION);
    expect(validateOverrides(overrides({ "app.next": five }), "mac")).toBe(false);
  });

  it("rejects an invalid binding", () => {
    expect(validateOverrides(overrides({ "app.next": ["Cmd+C"] }), "mac")).toBe(false);
    expect(validateOverrides(overrides({ "app.next": ["Cmd+N"] }), "other")).toBe(false);
  });

  it("rejects a binding on two actions after resolution", () => {
    expect(validateOverrides(overrides({ "app.next": ["Alt+N"], "app.previous": ["Alt+N"] }), "mac")).toBe(false);
    expect(validateOverrides(overrides({ "app.next": ["Alt+N", "Alt+N"] }), "mac")).toBe(false);
  });

  it("rejects input that does not match the stored schema", () => {
    expect(validateOverrides({ version: 2, overrides: {} } as unknown as ShortcutOverrides, "mac")).toBe(false);
  });
});

describe("ShortcutOverridesSchema", () => {
  it("accepts the stored shape and rejects extra keys", () => {
    expect(ShortcutOverridesSchema.safeParse({ version: 1, overrides: { "app.next": [] } }).success).toBe(true);
    expect(ShortcutOverridesSchema.safeParse({ version: 1, overrides: {}, extra: true }).success).toBe(false);
  });
});

describe("addBinding", () => {
  it("appends to the action's effective bindings", () => {
    const next = addBinding(EMPTY_SHORTCUT_OVERRIDES, "app.next", "Alt+N", "mac");
    expect(next.overrides["app.next"]).toEqual(["Ctrl+Tab", "Alt+N"]);
  });

  it("moves the binding off its previous owner", () => {
    const next = addBinding(EMPTY_SHORTCUT_OVERRIDES, "app.launcher", "Cmd+K", "mac");
    expect(next.overrides["app.launcher"]).toEqual(["Alt+Space", "Cmd+K"]);
    expect(next.overrides["nav.palette"]).toEqual([]);
    expect(validateOverrides(next, "mac")).toBe(true);
  });

  it("moves a binding off a previous owner that has an override", () => {
    const start = overrides({ "app.next": ["Alt+N", "Alt+M"] });
    const next = addBinding(start, "app.previous", "Alt+N", "mac");
    expect(next.overrides["app.next"]).toEqual(["Alt+M"]);
    expect(next.overrides["app.previous"]).toEqual(["Ctrl+Shift+Tab", "Alt+N"]);
  });

  it("does not mutate its input", () => {
    const start = overrides({ "app.next": ["Alt+N"] });
    addBinding(start, "app.previous", "Alt+N", "mac");
    expect(start).toEqual(overrides({ "app.next": ["Alt+N"] }));
  });

  it("leaves overrides unchanged for an invalid binding, a binding already held, or a full action", () => {
    expect(addBinding(EMPTY_SHORTCUT_OVERRIDES, "app.next", "Cmd+C", "mac")).toEqual(EMPTY_SHORTCUT_OVERRIDES);
    expect(addBinding(EMPTY_SHORTCUT_OVERRIDES, "app.next", "Ctrl+Tab", "mac")).toEqual(EMPTY_SHORTCUT_OVERRIDES);
    const full = overrides({ "app.next": ["Alt+1", "Alt+2", "Alt+3", "Alt+4"] });
    expect(addBinding(full, "app.next", "Alt+5", "mac")).toEqual(full);
  });
});

describe("removeBinding", () => {
  it("removes a default binding by writing an override", () => {
    const next = removeBinding(EMPTY_SHORTCUT_OVERRIDES, "nav.palette", "Cmd+K", "mac");
    expect(next.overrides["nav.palette"]).toEqual([]);
    expect(resolveShortcuts(next, "mac")["nav.palette"]).toEqual([]);
  });

  it("leaves overrides unchanged when the action does not hold the binding", () => {
    const next = removeBinding(EMPTY_SHORTCUT_OVERRIDES, "app.next", "Alt+X", "mac");
    expect(next).toEqual(EMPTY_SHORTCUT_OVERRIDES);
    expect(isOverridden(next, "app.next")).toBe(false);
  });

  it("removes one binding from an override", () => {
    const next = removeBinding(overrides({ "app.next": ["Alt+N", "Alt+M"] }), "app.next", "Alt+N", "mac");
    expect(next.overrides["app.next"]).toEqual(["Alt+M"]);
  });
});

describe("resetAction", () => {
  it("deletes the override key without touching others", () => {
    const next = resetAction(overrides({ "app.next": ["Alt+N"], "nav.palette": [] }), "app.next");
    expect(next).toEqual(overrides({ "nav.palette": [] }));
    expect(Object.hasOwn(next.overrides, "app.next")).toBe(false);
  });
});

describe("isOverridden", () => {
  it("is true only for actions with a stored override, including an empty one", () => {
    const value = overrides({ "nav.palette": [] });
    expect(isOverridden(value, "nav.palette")).toBe(true);
    expect(isOverridden(value, "app.next")).toBe(false);
  });
});

describe("formatBinding", () => {
  it("uses symbols on mac", () => {
    expect(formatBinding("Ctrl+Shift+Tab", "mac")).toEqual(["⌃", "⇧", "⇥"]);
    expect(formatBinding("Cmd+Alt+Enter", "mac")).toEqual(["⌘", "⌥", "↩"]);
    expect(formatBinding("Alt+Space", "mac")).toEqual(["⌥", "Space"]);
  });

  it("uses words on other platforms", () => {
    expect(formatBinding("Ctrl+Shift+Tab", "other")).toEqual(["Ctrl", "Shift", "Tab"]);
    expect(formatBinding("Ctrl+Alt+Enter", "other")).toEqual(["Ctrl", "Alt", "Enter"]);
    expect(formatBinding("Ctrl+Space", "other")).toEqual(["Ctrl", "Space"]);
  });
});
