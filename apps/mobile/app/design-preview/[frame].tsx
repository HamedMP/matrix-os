import { Redirect, Stack, useLocalSearchParams } from "expo-router";

/** Development-only previews of the redesign, e.g. matrixos://design-preview/components. */
export default function DesignPreviewRoute() {
  const { frame } = useLocalSearchParams<{ frame?: string }>();

  // A production bundle drops this branch, and the previews and their sample
  // content with it, because nothing else requires them. An import at the top
  // of the file would keep them in.
  if (__DEV__) {
    const { DesignPreview } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../../dev/design-preview/DesignPreview") as typeof import("../../dev/design-preview/DesignPreview");
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <DesignPreview frame={frame} />
      </>
    );
  }

  return <Redirect href="/" />;
}
