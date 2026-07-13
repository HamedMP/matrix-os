type EslintConfigEntry = {
  rules?: Record<string, unknown>;
};

const eslintConfig = require("../eslint.config.js") as EslintConfigEntry[];

describe("AgentComposerScreen SDK 57 compatibility", () => {
  it("restricts React Navigation element imports at the lint boundary", () => {
    const restrictedImportsRule = eslintConfig
      .flatMap((entry) => Object.entries(entry.rules ?? {}))
      .find(([ruleName]) => ruleName === "no-restricted-imports")?.[1];

    expect(restrictedImportsRule).toEqual([
      "error",
      {
        paths: [
          {
            name: "@react-navigation/elements",
            message: "Use Expo Router and React Native safe-area primitives in the mobile app.",
          },
        ],
      },
    ]);
  });
});
