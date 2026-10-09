import { useRouter } from "expo-router";

/**
 * Goes back, or to `fallbackHref` when a link opened the screen and nothing is
 * beneath it.
 */
export function useBackOr(fallbackHref: string): () => void {
  const router = useRouter();

  return () => {
    if (router.canGoBack()) router.back();
    else router.replace(fallbackHref as never);
  };
}
