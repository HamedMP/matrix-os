import { describe, expect, it } from "vitest";
import { parseProject } from "@desktop/renderer/src/stores/board";

describe("Desktop Project identity projection", () => {
  it("preserves the immutable Project id separately from its navigation slug", () => {
    expect(parseProject({
      id: "proj_immutable",
      slug: "matrix-os",
      name: "Matrix OS",
      kind: "folder",
    })).toMatchObject({
      id: "proj_immutable",
      slug: "matrix-os",
    });
  });
});
