jest.mock("react-native-reanimated", () => {
  const { View } = require("react-native");
  const mockReact = require("react");
  const mockAnimated = {
    View: (props) =>
      mockReact.createElement(View, props, props.children),
  };
  return {
    __esModule: true,
    default: mockAnimated,
    FadeInLeft: { duration: () => ({ springify: () => "FadeInLeft" }) },
    FadeInRight: { duration: () => ({ springify: () => "FadeInRight" }) },
    FadeInUp: { duration: () => ({ delay: () => "FadeInUp" }) },
    FadeInDown: { duration: () => ({ springify: () => "FadeInDown" }) },
    ZoomIn: { springify: () => "ZoomIn" },
    FadeIn: { duration: () => "FadeIn" },
    useSharedValue: (init) => ({ value: init }),
    useAnimatedStyle: (fn) => fn(),
    withRepeat: (v) => v,
    withTiming: (v) => v,
    withSpring: (v) => v,
  };
});

jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(),
  notificationAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
  NotificationFeedbackType: {
    Success: "success",
    Error: "error",
    Warning: "warning",
  },
}));

jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock("@expo/vector-icons", () => {
  const { Text } = require("react-native");
  return {
    Ionicons: (props) => {
      const mockReact = require("react");
      return mockReact.createElement(
        Text,
        { testID: `icon-${props.name}` },
        props.name,
      );
    },
  };
});

jest.mock("expo-blur", () => {
  const { View } = require("react-native");
  return {
    BlurView: (props) => {
      const mockReact = require("react");
      return mockReact.createElement(
        View,
        { testID: "blur-view", ...props },
        props.children,
      );
    },
  };
});
