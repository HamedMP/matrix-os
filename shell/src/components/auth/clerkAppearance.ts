import { shadcn } from "@clerk/ui/themes";
import { platformShellAssetPath } from "@/lib/platform-shell-assets";

export const matrixClerkAppearance = {
  theme: shadcn,
  layout: {
    socialButtonsPlacement: "top",
    socialButtonsVariant: "blockButton",
    logoImageUrl: platformShellAssetPath("/rabbit.svg"),
    logoLinkUrl: "https://matrix-os.com",
  },
  elements: {
    rootBox: "w-full",
    cardBox: "w-full !shadow-none !border-0",
    card: "!bg-transparent !shadow-none !border-0",
    headerTitle: "!tracking-[-0.02em]",
    socialButtonsBlockButton: "!h-11 !rounded-xl",
    formButtonPrimary: "!h-11 !rounded-xl !font-semibold",
    formFieldInput: "!h-11 !rounded-xl",
  },
} as const;
