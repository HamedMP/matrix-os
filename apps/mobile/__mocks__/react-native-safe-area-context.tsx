import { use } from "react";

// Screens under the tabs have no navigator header and pad themselves below the
// status bar, so most screen suites reach `useSafeAreaInsets`, which throws
// outside a provider. Here it reports a device without insets instead. A suite
// that needs insets renders `SafeAreaInsetsContext.Provider`, or mocks the
// module itself.
const actual = jest.requireActual<typeof import("react-native-safe-area-context")>(
  "react-native-safe-area-context",
);

const noInsets = { top: 0, right: 0, bottom: 0, left: 0 };

module.exports = {
  ...actual,
  useSafeAreaInsets: () => use(actual.SafeAreaInsetsContext) ?? noInsets,
};
