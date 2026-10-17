import { expect, it } from "vitest";
import { resolveTerminalRuntimeOwners } from "../../packages/gateway/src/server/terminal-runtime-owners.js";

it.each(["development", "test", undefined])("admits only the established local default owner in %s", nodeEnv => {
  const owners = resolveTerminalRuntimeOwners(undefined, nodeEnv);
  expect(owners.includes("default")).toBe(true);
  expect(owners.includes("collaborator")).toBe(false);
});
it("requires an identified owner on production runtimes", () => {
  expect(resolveTerminalRuntimeOwners(undefined, "production")).toEqual([]);
  expect(resolveTerminalRuntimeOwners("configured-owner", "production")).toEqual(["configured-owner"]);
});
it("never adds the development default alongside an identified owner", () => {
  expect(resolveTerminalRuntimeOwners("configured-owner", "development")).toEqual(["configured-owner"]);
});
