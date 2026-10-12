import { cleanup, render, screen } from "@testing-library/react-native";

import DesignPreviewRoute from "../app/design-preview/[frame]";

const mockGalleryLoaded = jest.fn();
const mockParams: { frame?: string } = { frame: "components" };
const mockStackScreens: (Record<string, unknown> | undefined)[] = [];

jest.mock("expo-router", () => {
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    Redirect: ({ href }: { href: string }) => <View testID="redirect" accessibilityHint={href} />,
    Stack: {
      Screen: ({ options }: { options?: Record<string, unknown> }) => {
        mockStackScreens.push(options);
        return null;
      },
    },
    useLocalSearchParams: () => mockParams,
  };
});

jest.mock("../dev/design-preview/DesignPreview", () => {
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  mockGalleryLoaded();
  return {
    DesignPreview: ({ frame }: { frame?: string }) => <View testID="gallery" accessibilityHint={frame} />,
  };
});

const globals = globalThis as unknown as { __DEV__: boolean };

describe("design preview route", () => {
  const originalDev = globals.__DEV__;

  afterEach(() => {
    cleanup();
    globals.__DEV__ = originalDev;
    mockStackScreens.length = 0;
  });

  // Runs first: the gallery module must not have been loaded by anything yet.
  it("renders nothing but a redirect home outside development, without loading the gallery", () => {
    globals.__DEV__ = false;
    render(<DesignPreviewRoute />);

    expect(screen.getByTestId("redirect").props.accessibilityHint).toBe("/");
    expect(screen.queryByTestId("gallery")).toBeNull();
    expect(screen.toJSON()).toMatchObject({ props: { testID: "redirect" }, children: null });
    expect(mockStackScreens).toHaveLength(0);
    expect(mockGalleryLoaded).not.toHaveBeenCalled();
  });

  it("shows the requested frame in development, without the stack header", () => {
    globals.__DEV__ = true;
    render(<DesignPreviewRoute />);

    expect(screen.getByTestId("gallery").props.accessibilityHint).toBe("components");
    expect(screen.queryByTestId("redirect")).toBeNull();
    expect(mockStackScreens).toEqual([{ headerShown: false }]);
    expect(mockGalleryLoaded).toHaveBeenCalledTimes(1);
  });
});
