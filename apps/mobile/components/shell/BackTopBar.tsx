import { useRouter } from "expo-router";

import { BackIcon, TopBar, TopBarButton } from "@/components/ui";

interface BackTopBarProps {
  /** Where back goes when a link opened the screen and nothing is beneath it. */
  fallbackHref: string;
}

/** The top bar of a screen pushed inside a tab: a back button and no title. */
export function BackTopBar({ fallbackHref }: BackTopBarProps) {
  const router = useRouter();

  return (
    <TopBar
      leading={
        <TopBarButton
          icon={BackIcon}
          iconSize={22}
          accessibilityLabel="Back"
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace(fallbackHref as never);
          }}
        />
      }
    />
  );
}
