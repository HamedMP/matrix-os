// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@react-navigation/elements",
              message: "Use Expo Router and React Native safe-area primitives in the mobile app.",
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ["dist/*"],
  }
]);
