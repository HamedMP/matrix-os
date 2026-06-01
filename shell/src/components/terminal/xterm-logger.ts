import type { ILogger } from "@xterm/xterm";

const PARSING_ERROR_PREFIX = "Parsing error";

export function createXtermLogger(base: ILogger = console): ILogger {
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
