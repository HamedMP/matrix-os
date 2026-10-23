import { render } from "@testing-library/react-native";

const mockReact = jest.requireActual("react");
const mockNative = jest.requireActual("react-native");
const originalTarget = process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN;
const mockApplication: { applicationId: string | null } = { applicationId: null };
jest.mock("expo-application", () => ({ __esModule: true, get applicationId() { return mockApplication.applicationId; } }));
jest.mock("expo-auth-session", () => ({ makeRedirectUri: jest.fn() }));
jest.mock("@/components/StartupScreen", () => ({ StartupScreen: ({ children }: { children: React.ReactNode }) => mockReact.createElement(mockNative.View, null, children) }));
jest.mock("@/lib/use-startup-colors", () => ({ useStartupColors: () => ({ text: "black" }) }));

beforeEach(() => {
  jest.resetModules();
  // Preserve the renderer's React/native singletons while reloading the actual
  // immutable build setting for each target, rather than mocking admission.
  jest.doMock("react", () => mockReact);
  jest.doMock("react-native", () => mockNative);
});
afterEach(() => {
  jest.restoreAllMocks();
  if (originalTarget === undefined) delete process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN;
  else process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN = originalTarget;
});

describe.each([
  ["production", undefined, "com.matrixos.mobile", "com.matrixos.mobile.gmailpilot"],
  ["pilot", "https://gmail-pilot.matrix-os.com", "com.matrixos.mobile.gmailpilot", "com.matrixos.mobile"],
] as const)("%s root build boundary", (_name, origin, matchingId, oppositeId) => {
  function probe(applicationId: string | null, os: string) {
    if (origin === undefined) delete process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN;
    else process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN = origin;
    mockApplication.applicationId = applicationId;
    jest.replaceProperty(mockNative.Platform, "OS", os);
    const { NativeBuildBoundary } = require("../components/NativeBuildBoundary");
    const mounted = jest.fn();
    const Child = () => { mounted(); return mockReact.createElement(mockNative.Text, null, "Session subtree"); };
    const result = render(mockReact.createElement(NativeBuildBoundary, null, mockReact.createElement(Child)));
    return { result, mounted };
  }
  it.each(["ios", "android"])("mounts the matching %s native subtree", os => {
    const { result, mounted } = probe(matchingId, os);
    expect(result.getByText("Session subtree")).toBeTruthy(); expect(mounted).toHaveBeenCalledTimes(1);
  });
  it.each([oppositeId, null, "host.exp.Exponent"])("never mounts cached-session descendants for native ID %s", id => {
    const { result, mounted } = probe(id, "ios");
    expect(result.getByText("Mobile connection unavailable")).toBeTruthy();
    expect(result.queryByText("Session subtree")).toBeNull(); expect(mounted).not.toHaveBeenCalled();
  });
  it("fails closed on an unsupported native platform even with a matching ID", () => {
    expect(probe(matchingId, "windows").mounted).not.toHaveBeenCalled();
  });
  it("preserves the existing web subtree without asserting a native identity", () => {
    expect(probe(null, "web").mounted).toHaveBeenCalledTimes(1);
  });
});
