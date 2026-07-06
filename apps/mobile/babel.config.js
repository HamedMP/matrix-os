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
          // Expo Router screens live in app/ (the `root`); shared UI lives in
          // components/. autoProcessPaths is matched as a path *substring*, so it
          // MUST be qualified ("apps/mobile/components") — a bare "components"
          // would also match node_modules/**/components/** and make Unistyles wrap
          // third-party internals, crashing with "copyComponentProperties:
          // Cannot convert undefined value to object". The Reanimated defaults are
          // concatenated automatically, so they don't need to be listed here.
          root: "app",
          autoProcessPaths: ["apps/mobile/components"],
        },
      ],
      // Reanimated's Babel plugin must stay last.
      "react-native-reanimated/plugin",
    ],
  };
};
