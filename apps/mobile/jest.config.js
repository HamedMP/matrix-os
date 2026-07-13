module.exports = {
  preset: "jest-expo",
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
