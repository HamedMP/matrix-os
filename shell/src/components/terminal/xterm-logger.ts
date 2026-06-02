import type { ILogger } from "@xterm/xterm";

const PARSING_ERROR_PREFIX = "Parsing error";

const DEFAULT_BASE: ILogger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error(message: string | Error, ...args: unknown[]) {
    console.error(message, ...args);
  },
};

export function createXtermLogger(base: ILogger = DEFAULT_BASE): ILogger {
  return {
    trace(message: string, ...args: unknown[]) {
      base.trace(message, ...args);
    },
    debug(message: string, ...args: unknown[]) {
      base.debug(message, ...args);
    },
    info(message: string, ...args: unknown[]) {
      base.info(message, ...args);
    },
    warn(message: string, ...args: unknown[]) {
      base.warn(message, ...args);
    },
    error(message: string | Error, ...args: unknown[]) {
      if (typeof message === "string" && message.startsWith(PARSING_ERROR_PREFIX)) {
        return;
      }
      base.error(message, ...args);
    },
  };
}
