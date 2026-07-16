// Assertion spies for the PostHog client. Names are `mock`-prefixed so
// babel-plugin-jest-hoist allows them inside the hoisted jest.mock factory.
const mockCtor = jest.fn();
const mockCapture = jest.fn();
const mockScreen = jest.fn(() => Promise.resolve());
const mockIdentify = jest.fn();
const mockReset = jest.fn();
let mockCtorThrows = false;

jest.mock("posthog-react-native", () => {
  const mockReact = require("react");
  class PostHog {
    constructor(apiKey: string, options: unknown) {
      mockCtor(apiKey, options);
      if (mockCtorThrows) throw new Error("boom");
    }
    capture = mockCapture;
    screen = mockScreen;
    identify = mockIdentify;
    reset = mockReset;
  }
  return {
    __esModule: true,
    default: PostHog,
    PostHog,
    PostHogMaskView: (props: { children?: unknown }) =>
      mockReact.createElement(mockReact.Fragment, null, props.children),
  };
});

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn() },
}));

type AnalyticsModule = typeof import("../lib/analytics");

// Fresh module registry per load so the singleton client re-initializes and
// picks up the current env.
function loadAnalytics(env: { key?: string; host?: string } = {}): AnalyticsModule {
  if (env.key === undefined) delete process.env.EXPO_PUBLIC_POSTHOG_API_KEY;
  else process.env.EXPO_PUBLIC_POSTHOG_API_KEY = env.key;
  if (env.host === undefined) delete process.env.EXPO_PUBLIC_POSTHOG_HOST;
  else process.env.EXPO_PUBLIC_POSTHOG_HOST = env.host;

  let mod!: AnalyticsModule;
  jest.isolateModules(() => {
    mod = require("../lib/analytics");
  });
  return mod;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCtorThrows = false;
});

describe("analytics no-op without key", () => {
  it("never constructs a client and helpers are silent", () => {
    const a = loadAnalytics({ key: undefined });
    expect(a.getAnalyticsClient()).toBeNull();
    a.capture("chat_message_sent", { queued: false });
    a.captureScreen("/chat");
    a.identifyUser("user_123");
    a.resetAnalytics();
    expect(mockCtor).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockScreen).not.toHaveBeenCalled();
    expect(mockIdentify).not.toHaveBeenCalled();
    expect(mockReset).not.toHaveBeenCalled();
  });

  it("treats an empty/whitespace key as absent", () => {
    const a = loadAnalytics({ key: "   " });
    expect(a.getAnalyticsClient()).toBeNull();
    a.capture("x");
    expect(mockCapture).not.toHaveBeenCalled();
  });
});

describe("analytics wiring with a key", () => {
  it("initializes replay with strict masking on the default EU host", () => {
    const a = loadAnalytics({ key: "phc_test" });
    expect(a.getAnalyticsClient()).not.toBeNull();
    expect(mockCtor).toHaveBeenCalledTimes(1);
    const [apiKey, options] = mockCtor.mock.calls[0] as [string, Record<string, unknown>];
    expect(apiKey).toBe("phc_test");
    expect(options.host).toBe("https://eu.i.posthog.com");
    expect(options.customStorage).toBeDefined();
    expect(options.enableSessionReplay).toBe(true);
    expect(options.sessionReplayConfig).toMatchObject({
      maskAllTextInputs: true,
      maskAllImages: true,
      maskAllSandboxedViews: true,
      captureLog: false,
      captureNetworkTelemetry: false,
    });
  });

  it("honors EXPO_PUBLIC_POSTHOG_HOST override", () => {
    const a = loadAnalytics({ key: "phc_test", host: "https://us.i.posthog.com" });
    a.getAnalyticsClient();
    const [, options] = mockCtor.mock.calls[0] as [string, Record<string, unknown>];
    expect(options.host).toBe("https://us.i.posthog.com");
  });

  it("forwards capture / screen / identify / reset to the client", () => {
    const a = loadAnalytics({ key: "phc_test" });
    a.capture("computer_switched", { foo: "bar" });
    a.captureScreen("/agents/:threadId");
    a.identifyUser("user_123");
    a.resetAnalytics();
    expect(mockCapture).toHaveBeenCalledWith("computer_switched", { foo: "bar" });
    expect(mockScreen).toHaveBeenCalledWith("/agents/:threadId", undefined);
    expect(mockIdentify).toHaveBeenCalledWith("user_123");
    expect(mockReset).toHaveBeenCalledTimes(1);
  });

  it("only constructs the client once (singleton)", () => {
    const a = loadAnalytics({ key: "phc_test" });
    a.getAnalyticsClient();
    a.getAnalyticsClient();
    a.capture("x");
    expect(mockCtor).toHaveBeenCalledTimes(1);
  });

  it("ignores empty distinctId for identify", () => {
    const a = loadAnalytics({ key: "phc_test" });
    a.identifyUser("");
    expect(mockIdentify).not.toHaveBeenCalled();
  });

  it("fails closed to disabled when client construction throws", () => {
    mockCtorThrows = true;
    const a = loadAnalytics({ key: "phc_test" });
    expect(a.getAnalyticsClient()).toBeNull();
    a.capture("x");
    expect(mockCapture).not.toHaveBeenCalled();
  });
});

describe("sanitizeScreenName", () => {
  let sanitizeScreenName: AnalyticsModule["sanitizeScreenName"];
  beforeAll(() => {
    sanitizeScreenName = loadAnalytics({ key: undefined }).sanitizeScreenName;
  });

  it("keeps static routes intact", () => {
    expect(sanitizeScreenName("/")).toBe("/");
    expect(sanitizeScreenName("/chat")).toBe("/chat");
    expect(sanitizeScreenName("/agents")).toBe("/agents");
    expect(sanitizeScreenName("/agents/new")).toBe("/agents/new");
    expect(sanitizeScreenName("/agents/providers")).toBe("/agents/providers");
    expect(sanitizeScreenName("/mission-control")).toBe("/mission-control");
  });

  it("collapses agent thread ids", () => {
    expect(sanitizeScreenName("/agents/thread_abc123def456")).toBe("/agents/:threadId");
    expect(sanitizeScreenName("/agents/9f8e7d6c-1234-4a5b-8c9d-0123456789ab")).toBe("/agents/:threadId");
  });

  it("collapses app and runtime slugs", () => {
    expect(sanitizeScreenName("/apps/notes")).toBe("/apps/:slug");
    expect(sanitizeScreenName("/apps/some/deep/path")).toBe("/apps/:slug");
    expect(sanitizeScreenName("/runtime/anything")).toBe("/runtime/:slug");
  });

  it("strips handles, numeric ids, and long tokens defensively", () => {
    expect(sanitizeScreenName("/u/@alice:matrix-os.com")).toBe("/u/:id");
    expect(sanitizeScreenName("/x/1234567")).toBe("/x/:id");
    expect(sanitizeScreenName("/x/abcdef0123456789abcdef")).toBe("/x/:id");
  });

  it("drops query strings and handles empty input", () => {
    expect(sanitizeScreenName("/chat?foo=bar")).toBe("/chat");
    expect(sanitizeScreenName("")).toBe("/");
    expect(sanitizeScreenName(null)).toBe("/");
    expect(sanitizeScreenName(undefined)).toBe("/");
  });
});
