import { describe, expect, it, vi } from "vitest";
import { createXtermLogger } from "../../shell/src/components/terminal/xterm-logger.js";

describe("xterm logger", () => {
  it("suppresses parser errors caused by malformed terminal control streams", () => {
    const logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const xtermLogger = createXtermLogger(logger);

    xtermLogger.error("Parsing error: ", { code: 57520 });

    expect(logger.error).not.toHaveBeenCalled();
  });

  it("forwards non-parser errors", () => {
    const logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const xtermLogger = createXtermLogger(logger);
    const err = new Error("renderer failed");

    xtermLogger.error(err);

    expect(logger.error).toHaveBeenCalledWith(err);
  });
});
