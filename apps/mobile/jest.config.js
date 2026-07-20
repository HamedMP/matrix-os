const path = require("node:path");

module.exports = {
  preset: "jest-expo",
  // The workspace shares a global pnpm virtual store, so packages are linked from
  // content-addressed directories outside the repo and cannot see undeclared
  // dependencies of their own (expo-modules-core -> @babel/runtime, jest-expo ->
  // @react-native/assets-registry, ...). The hoisted root node_modules is flat and
  // complete, so add it as a fallback resolution root.
  modulePaths: [path.resolve(__dirname, "../../node_modules")],
  transformIgnorePatterns: [
    "node_modules/.pnpm/(?!(react-native|jest-react-native|@react-native\\+.*|expo(nent)?|expo-[^@]+|expo-modules-core|@expo(nent)?\\+.*|@expo-google-fonts\\+.*|react-navigation|@react-navigation\\+.*|@sentry\\+react-native|native-base|react-native-svg|react-native-unistyles|react-native-nitro-modules|react-native-edge-to-edge|nativewind|@react-native-async-storage\\+.*)@)",
    "node_modules/(?!\\.pnpm|((jest-)?react-native|@react-native(-community)?)|expo(nent)?|expo-[^/]+|expo-modules-core|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|react-native-unistyles|react-native-nitro-modules|react-native-edge-to-edge|nativewind|@react-native-async-storage)",
  ],
  setupFiles: ["./jest.setup.js"],
  testMatch: ["**/__tests__/**/*.test.[jt]s?(x)"],
  moduleNameMapper: {
    "^react$": "<rootDir>/node_modules/react",
    "^@/(.*)$": "<rootDir>/$1",
  },
};
