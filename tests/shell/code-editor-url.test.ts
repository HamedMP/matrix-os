// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { getCodeEditorUrl } from "../../shell/src/lib/feature-flags.js";

describe("code editor URL", () => {
  afterEach(() => {
    delete document.documentElement.dataset.matrixSelfHosted;
  });

  it("uses managed code domain outside self-host mode", () => {
    expect(getCodeEditorUrl()).toBe("https://code.matrix-os.com");
    expect(getCodeEditorUrl("/home/matrix/home/projects/app")).toBe(
      "https://code.matrix-os.com/?folder=%2Fhome%2Fmatrix%2Fhome%2Fprojects%2Fapp",
    );
  });

  it("uses same-origin code-server path in self-host mode", () => {
    document.documentElement.dataset.matrixSelfHosted = "1";

    expect(getCodeEditorUrl()).toBe("/code/");
    expect(getCodeEditorUrl("/home/matrix/home/projects/app")).toBe(
      "/code/?folder=%2Fhome%2Fmatrix%2Fhome%2Fprojects%2Fapp",
    );
  });
});
