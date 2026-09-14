import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { validateActionParams } from "../../packages/gateway/src/integrations/parameter-validation.js";
import type { ServiceAction } from "../../packages/gateway/src/integrations/types.js";

describe("shared integration validation after Gmail/X merge", () => {
  const action: ServiceAction = {
    description: "Read one bounded page",
    risk: "read",
    params: { limit: { type: "number", minimum: 1, maximum: 100 } },
    paramsSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }).strict(),
  };

  it("enforces Gmail schema constraints in the validator used by both routes and bridge", () => {
    expect(validateActionParams(action, { limit: 1.5 })).toEqual({
      valid: false, missing: [], typeErrors: ["params: invalid value"],
    });
  });

  it("keeps schema errors generic rather than exposing caller-controlled keys", () => {
    expect(validateActionParams(action, { secretCallerValue: "do not expose" })).toEqual({
      valid: false, missing: [], typeErrors: ["params: invalid value"],
    });
  });

  it("preserves main's per-parameter bounds", () => {
    expect(validateActionParams(action, { limit: 101 })).toMatchObject({
      valid: false, valueErrors: ["limit: must be at most 100"],
    });
  });

  it("accepts valid inputs without changing them", () => {
    const input = { limit: 10 };
    expect(validateActionParams(action, input)).toEqual({ valid: true });
    expect(input).toEqual({ limit: 10 });
  });
});
