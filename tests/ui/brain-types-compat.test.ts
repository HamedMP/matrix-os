import { describe, expect, expectTypeOf, it } from "vitest";
import * as G from "../../packages/gateway/src/brain/contracts.js";
import * as S from "../../packages/ui/src/brain/brain-types.js";

// The UI package keeps copies of the gateway view shapes. The constants are compared when the tests run; the shapes
// are compared when the tests are type checked (tsc or vitest --typecheck).
describe("Company Brain view shapes", () => {
  it("match the gateway contracts", () => {
    expect(S.BRAIN_SHELL_VIEW).toEqual(G.BRAIN_SHELL_VIEW);
    expect(S.BRAIN_SHELL_SCREENS).toEqual(G.BRAIN_SHELL_SCREENS);
    expectTypeOf<G.BrainShellApi>().toExtend<S.BrainShellApi>();
    expectTypeOf<G.BrainShellErrorState>().toExtend<S.BrainShellErrorState>();
    expectTypeOf<S.BrainShellErrorState>().toExtend<G.BrainShellErrorState>();
    expectTypeOf<typeof G.BRAIN_SHELL_VIEW>().toEqualTypeOf<typeof S.BRAIN_SHELL_VIEW>();
    expectTypeOf<typeof G.BRAIN_SHELL_SCREENS>().toEqualTypeOf<typeof S.BRAIN_SHELL_SCREENS>();
  });
});
