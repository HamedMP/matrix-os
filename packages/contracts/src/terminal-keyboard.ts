import { z } from "zod/v4";
const DirectionSchema = z.enum(["left", "right", "up", "down"]);
export const TerminalPaneActionSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("split"), direction: z.enum(["right", "down"]) })
    .strict(),
  z.object({ type: z.literal("focus"), direction: DirectionSchema }).strict(),
  z.object({ type: z.literal("resize"), direction: DirectionSchema }).strict(),
  z.object({ type: z.literal("fullscreen") }).strict(),
  z
    .object({ type: z.literal("scroll"), edge: z.enum(["top", "bottom"]) })
    .strict(),
  z.object({ type: z.literal("close") }).strict(),
]);
export type TerminalPaneAction = z.infer<typeof TerminalPaneActionSchema>;
export const TERMINAL_COMMANDS = [
  "line-start",
  "line-end",
  "word-left",
  "word-right",
  "delete-word",
  "delete-line",
  "history-top",
  "history-bottom",
  "focus-left",
  "focus-right",
  "focus-up",
  "focus-down",
  "resize-left",
  "resize-right",
  "resize-up",
  "resize-down",
  "split-right",
  "split-down",
  "fullscreen",
  "close",
] as const;
export type TerminalCommand = (typeof TERMINAL_COMMANDS)[number];
export const TERMINAL_COMMAND_LABELS: Record<TerminalCommand, string> = {
  "line-start": "Beginning of line",
  "line-end": "End of line",
  "word-left": "Previous word",
  "word-right": "Next word",
  "delete-word": "Delete previous word",
  "delete-line": "Delete to beginning of line",
  "history-top": "Top of pane history",
  "history-bottom": "Bottom of pane history",
  "focus-left": "Focus left pane",
  "focus-right": "Focus right pane",
  "focus-up": "Focus pane above",
  "focus-down": "Focus pane below",
  "resize-left": "Resize left",
  "resize-right": "Resize right",
  "resize-up": "Resize up",
  "resize-down": "Resize down",
  "split-right": "Split right",
  "split-down": "Split below",
  fullscreen: "Maximize / restore pane",
  close: "Close pane",
};
const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"] as const;
export function normalizeTerminalShortcut(value: string): string | null {
  const parts = value.trim().split("+");
  const key = parts.pop();
  if (
    !key ||
    !/^(?:[a-zA-Z0-9]|Arrow(?:Left|Right|Up|Down)|Backspace|Enter|Home|End|PageUp|PageDown)$/.test(
      key,
    )
  )
    return null;
  if (
    !parts.length ||
    parts.some((p) => !MODIFIERS.includes(p as (typeof MODIFIERS)[number])) ||
    new Set(parts).size !== parts.length
  )
    return null;
  return [
    ...MODIFIERS.filter((p) => parts.includes(p)),
    key.length === 1 ? key.toUpperCase() : key,
  ].join("+");
}
export const TerminalKeyboardPreferencesSchema = z
  .object({
    profile: z.enum(["mac", "standard", "passthrough"]).default("mac"),
    overrides: z
      .partialRecord(
        z.enum(TERMINAL_COMMANDS),
        z
          .string()
          .max(64)
          .refine((v) => normalizeTerminalShortcut(v) !== null)
          .nullable(),
      )
      .default({}),
  })
  .strict()
  .superRefine((value, ctx) => {
    const bindings = Object.values(value.overrides)
      .filter((v): v is string => typeof v === "string")
      .map((v) => normalizeTerminalShortcut(v));
    if (new Set(bindings).size !== bindings.length)
      ctx.addIssue({
        code: "custom",
        message: "Each shortcut must be unique",
        path: ["overrides"],
      });
    if (bindings.includes("Ctrl+G"))
      ctx.addIssue({
        code: "custom",
        message: "Ctrl+G is reserved for the terminal prefix",
        path: ["overrides"],
      });
    const reserved = [
      "Meta+C",
      "Shift+Meta+C",
      "Meta+V",
      "Meta+A",
      "Ctrl+Shift+C",
      "Ctrl+Shift+V",
      "Ctrl+Shift+F",
      "Alt+Shift+C",
    ];
    if (bindings.some((b) => b && reserved.includes(b)))
      ctx.addIssue({
        code: "custom",
        message: "Clipboard and search shortcuts are reserved",
        path: ["overrides"],
      });
    for (const isMac of [true, false]) {
      const effective = Object.values({
        ...terminalDefaultBindings(value.profile, isMac),
        ...value.overrides,
      })
        .filter((v): v is string => typeof v === "string")
        .map(normalizeTerminalShortcut);
      if (new Set(effective).size !== effective.length) {
        ctx.addIssue({
          code: "custom",
          message: "Shortcut conflicts with another command",
          path: ["overrides"],
        });
        break;
      }
    }
  });
export type TerminalKeyboardPreferences = z.infer<
  typeof TerminalKeyboardPreferencesSchema
>;
export interface TerminalKeyboardEvent {
  type: string;
  key: string;
  isMac: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  isComposing: boolean;
}
export type TerminalShortcut =
  | {
      kind: "input";
      data: string;
    }
  | {
      kind: "pane";
      action: TerminalPaneAction;
    }
  | {
      kind: "prefix";
    }
  | {
      kind: "consume" | "keep-prefix";
    };
export function terminalDefaultBindings(
  profile: TerminalKeyboardPreferences["profile"],
  isMac: boolean,
): Partial<Record<TerminalCommand, string>> {
  if (profile === "passthrough") return {};
  const mac = profile === "mac" && isMac;
  const pane = mac ? "Alt+Meta" : "Ctrl+Shift";
  const resize = mac ? "Alt+Shift+Meta" : "Ctrl+Alt+Shift";
  return {
    ...(mac
      ? {
          "line-start": "Meta+ArrowLeft",
          "line-end": "Meta+ArrowRight",
          "word-left": "Alt+ArrowLeft",
          "word-right": "Alt+ArrowRight",
          "delete-word": "Alt+Backspace",
          "delete-line": "Meta+Backspace",
          "history-top": "Meta+ArrowUp",
          "history-bottom": "Meta+ArrowDown",
        }
      : {}),
    "focus-left": `${pane}+ArrowLeft`,
    "focus-right": `${pane}+ArrowRight`,
    "focus-up": `${pane}+ArrowUp`,
    "focus-down": `${pane}+ArrowDown`,
    "resize-left": `${resize}+ArrowLeft`,
    "resize-right": `${resize}+ArrowRight`,
    "resize-up": `${resize}+ArrowUp`,
    "resize-down": `${resize}+ArrowDown`,
    "split-right": mac ? "Meta+D" : "Ctrl+Shift+D",
    "split-down": mac ? "Shift+Meta+D" : "Ctrl+Shift+E",
    fullscreen: mac ? "Shift+Meta+Enter" : "Ctrl+Shift+Enter",
  };
}
export function terminalBindings(
  preferences: TerminalKeyboardPreferences,
  isMac: boolean,
): Partial<Record<TerminalCommand, string | null>> {
  return {
    ...terminalDefaultBindings(preferences.profile, isMac),
    ...preferences.overrides,
  };
}
export function terminalCommandAction(
  command: TerminalCommand,
): TerminalShortcut {
  const input = {
    "line-start": "\x01",
    "line-end": "\x05",
    "word-left": "\x1bb",
    "word-right": "\x1bf",
    "delete-word": "\x1b\x7f",
    "delete-line": "\x15",
  };
  if (command in input)
    return { kind: "input", data: input[command as keyof typeof input] };
  if (command.startsWith("focus-") || command.startsWith("resize-")) {
    const [type, direction] = command.split("-");
    return {
      kind: "pane",
      action: TerminalPaneActionSchema.parse({ type, direction }),
    };
  }
  if (command === "split-right" || command === "split-down")
    return {
      kind: "pane",
      action: {
        type: "split",
        direction: command === "split-right" ? "right" : "down",
      },
    };
  if (command === "history-top" || command === "history-bottom")
    return {
      kind: "pane",
      action: {
        type: "scroll",
        edge: command === "history-top" ? "top" : "bottom",
      },
    };
  return { kind: "pane", action: { type: command as "fullscreen" | "close" } };
}
export function resolveTerminalShortcut(
  event: TerminalKeyboardEvent,
  preferences: TerminalKeyboardPreferences,
  prefix = false,
): TerminalShortcut | null {
  if (
    event.type !== "keydown" ||
    event.isComposing ||
    preferences.profile === "passthrough"
  )
    return null;
  if (prefix) {
    if (event.repeat || ["Shift", "Control", "Alt", "Meta"].includes(event.key))
      return { kind: "keep-prefix" };
    const mapping: Record<string, TerminalCommand> = {
      h: "focus-left",
      j: "focus-down",
      k: "focus-up",
      l: "focus-right",
      v: "split-right",
      s: "split-down",
      f: "fullscreen",
      x: "close",
      t: "history-top",
      b: "history-bottom",
      ArrowLeft: "focus-left",
      ArrowRight: "focus-right",
      ArrowUp: "focus-up",
      ArrowDown: "focus-down",
    };
    if (event.metaKey || event.ctrlKey || event.altKey)
      return { kind: "consume" };
    const command = mapping[event.key];
    if (event.shiftKey && event.key.startsWith("Arrow") && command)
      return terminalCommandAction(
        command.replace("focus-", "resize-") as TerminalCommand,
      );
    return command ? terminalCommandAction(command) : { kind: "consume" };
  }
  if (
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "g"
  )
    return event.repeat ? { kind: "consume" } : { kind: "prefix" };
  const chord = normalizeTerminalShortcut(
    [
      ...(event.ctrlKey ? ["Ctrl"] : []),
      ...(event.altKey ? ["Alt"] : []),
      ...(event.shiftKey ? ["Shift"] : []),
      ...(event.metaKey ? ["Meta"] : []),
      event.key,
    ].join("+"),
  );
  if (!chord) return null;
  const command = TERMINAL_COMMANDS.find((c) => {
    const binding = terminalBindings(preferences, event.isMac)[c];
    return binding && normalizeTerminalShortcut(binding) === chord;
  });
  if (!command) return null;
  const action = terminalCommandAction(command);
  if (
    event.repeat &&
    action.kind === "pane" &&
    ["split", "close", "fullscreen"].includes(action.action.type)
  )
    return { kind: "consume" };
  return action;
}
export const TerminalKeyboardPreferencesResponseSchema = z.object({
  preferences: z.object({
    keyboard: TerminalKeyboardPreferencesSchema.default({
      profile: "mac",
      overrides: {},
    }),
  }),
});
