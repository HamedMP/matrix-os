import { shadcn } from "@clerk/ui/themes";

// Clerk's shadcn theme adapts to the site's shadcn CSS tokens (light + dark).
// The theme renders its own card chrome, so AuthLayout must not double-wrap it.
export const matrixClerkAppearance = {
  theme: shadcn,
  layout: {
    socialButtonsPlacement: "top",
    socialButtonsVariant: "blockButton",
    logoImageUrl: "/rabbit.svg",
    logoLinkUrl: "https://matrix-os.com",
  },
  // Colors come from the shadcn CSS tokens in globals.css (no hardcoded hex).
  // AuthLayout supplies the outer glass card, so we only strip Clerk's own
  // card chrome here and keep a couple of structural radius/height tweaks.
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
