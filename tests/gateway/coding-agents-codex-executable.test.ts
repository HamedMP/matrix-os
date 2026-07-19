import { describe, expect, it } from "vitest";
import { codexExecutableFromEnv } from "../../packages/gateway/src/coding-agents/codex-executable.js";

describe("Codex executable configuration", () => {
  it("derives one bounded absolute executable from the Matrix node prefix", () => {
    expect(codexExecutableFromEnv({})).toBe("/opt/matrix/runtime/node/bin/codex");
    expect(codexExecutableFromEnv({ MATRIX_NODE_PREFIX: "/srv/matrix/node" })).toBe(
      "/srv/matrix/node/bin/codex",
    );
    expect(() => codexExecutableFromEnv({ MATRIX_NODE_PREFIX: "relative/node" })).toThrow();
    expect(() => codexExecutableFromEnv({ MATRIX_NODE_PREFIX: "/srv/matrix\nnode" })).toThrow();
  });
});
