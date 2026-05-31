import { describe, expect, it } from "vitest";

import { describeUnknownError } from "../../shell/src/lib/error-boundary-utils";

describe("describeUnknownError", () => {
  it("falls back to the original value type when string coercion throws", () => {
    const errorLikeValue = {
      [Symbol.toPrimitive]() {
        throw new TypeError("string coercion failed");
      },
    };

    expect(describeUnknownError(errorLikeValue)).toBe("object");
  });
});
