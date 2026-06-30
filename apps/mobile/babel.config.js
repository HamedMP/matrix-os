module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      [
        "module-resolver",
        {
          alias: {
            "@": "./",
          },
        },
      ],
      [
        "react-native-unistyles/plugin",
        {
          // Expo Router screens live in app/; shared UI lives in components/.
          // lib/ holds no RN styles, so it does not need processing.
          root: "app",
          autoProcessPaths: [
            "components",
            // Preserve the plugin default so Reanimated components keep working.
            "react-native-reanimated/src/component",
          ],
        },
      ],
      // Reanimated's Babel plugin must stay last.
      "react-native-reanimated/plugin",
    ],
  };
};
