// Unistyles ships a Nitro native module that jest cannot load; its official mock
// stubs the native specs and exposes a JS StyleSheet. Load it first, then run the
// real StyleSheet.configure() so the mock registry has our themes/breakpoints.
require("react-native-unistyles/mocks");
require("./lib/unistyles");

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
  getStringAsync: jest.fn(() => Promise.resolve("")),
}));

class MatrixMockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MatrixMockWebSocket.CONNECTING;
  sent = [];
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;

  constructor(url, protocols, options) {
    this.url = url;
    this.protocols = protocols;
    this.options = options;
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MatrixMockWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "" });
  }
}

global.WebSocket = MatrixMockWebSocket;

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock("expo-notifications", () => ({
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true, status: "granted" })),
  requestPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true, status: "granted" })),
  getExpoPushTokenAsync: jest.fn(() => Promise.resolve({ data: "ExponentPushToken[test]" })),
  setNotificationChannelAsync: jest.fn(() => Promise.resolve()),
  setNotificationHandler: jest.fn(),
  AndroidImportance: { MAX: "max" },
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
