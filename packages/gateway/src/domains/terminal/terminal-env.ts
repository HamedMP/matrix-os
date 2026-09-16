export const TERMINAL_TRUECOLOR_ENV = {
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  CLICOLOR: "1",
  FORCE_COLOR: "3",
  COLORFGBG: "15;0",
} as const;

export function applyTerminalTruecolorEnv<T extends Record<string, string | undefined>>(env: T): T & typeof TERMINAL_TRUECOLOR_ENV {
  return {
    ...env,
    ...TERMINAL_TRUECOLOR_ENV,
  };
}
