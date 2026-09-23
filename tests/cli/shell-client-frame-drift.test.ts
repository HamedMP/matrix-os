import { TerminalTabServerFrameSchema } from "@matrix-os/contracts";
import { describe, expect, it } from "vitest";
import type { z } from "zod/v4";
import { ShellServerFrameSchema } from "../../packages/sync-client/src/cli/shell-client.js";

type FrameOption = z.ZodObject<z.ZodRawShape>;

function fieldsByFrameType(options: readonly unknown[]): Map<string, string[]> {
  return new Map((options as FrameOption[]).map((option) => {
    const type = (option.shape.type as z.ZodLiteral<string>).value;
    return [type, Object.keys(option.shape).sort()];
  }));
}

describe("CLI terminal frame schema", () => {
  // The CLI strictly parses gateway frames and drops any that fail, so a field the
  // gateway starts sending must be accepted here or the frame silently disappears.
  it("accepts every field the gateway contract defines for each frame the CLI handles", () => {
    const cli = fieldsByFrameType(ShellServerFrameSchema.options);
    const contract = fieldsByFrameType(TerminalTabServerFrameSchema.options);

    for (const [type, cliFields] of cli) {
      expect(contract.has(type), `contract lost frame type ${type}`).toBe(true);
      expect(cliFields, `CLI ${type} frame fields`).toEqual(contract.get(type));
    }
  });
});
