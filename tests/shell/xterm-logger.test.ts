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

  it("keeps lower-level default logs silent while forwarding non-parser errors", () => {
    const trace = vi.spyOn(console, "trace").mockImplementation(() => {});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const xtermLogger = createXtermLogger();

    xtermLogger.trace("trace");
    xtermLogger.debug("debug");
    xtermLogger.info("info");
    xtermLogger.warn("warn");
    xtermLogger.error("Parsing error: ", { code: 57520 });
    xtermLogger.error("connection lost");

    expect(trace).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("connection lost");
  });
});
