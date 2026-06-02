import { describe, expect, it, vi } from "vitest";
import { createXtermLogger } from "../../shell/src/components/terminal/xterm-logger.js";

describe("xterm logger", () => {
  function createLogger() {
    return {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  }

  it("suppresses parser errors caused by malformed terminal control streams", () => {
    const logger = createLogger();
    const xtermLogger = createXtermLogger(logger);

    xtermLogger.error("Parsing error: ", { code: 57520 });

    expect(logger.error).not.toHaveBeenCalled();
  });

  it("forwards non-parser errors", () => {
    const logger = createLogger();
    const xtermLogger = createXtermLogger(logger);
    const err = new Error("renderer failed");

    xtermLogger.error(err);

    expect(logger.error).toHaveBeenCalledWith(err);
  });

  it("forwards non-parser string errors", () => {
    const logger = createLogger();
    const xtermLogger = createXtermLogger(logger);

    xtermLogger.error("connection lost", { retrying: true });

    expect(logger.error).toHaveBeenCalledWith("connection lost", { retrying: true });
  });

  it("passes through trace, debug, info, and warn to the base logger", () => {
    const logger = createLogger();
    const xtermLogger = createXtermLogger(logger);

    xtermLogger.trace("trace", 1);
    xtermLogger.debug("debug", 2);
    xtermLogger.info("info", 3);
    xtermLogger.warn("warn", 4);

    expect(logger.trace).toHaveBeenCalledWith("trace", 1);
    expect(logger.debug).toHaveBeenCalledWith("debug", 2);
    expect(logger.info).toHaveBeenCalledWith("info", 3);
    expect(logger.warn).toHaveBeenCalledWith("warn", 4);
  });
});
