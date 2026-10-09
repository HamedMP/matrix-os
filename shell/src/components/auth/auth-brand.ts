import { shadcn } from "@clerk/ui/themes";
import { appGalleryPalette, desktopPalette, fonts } from "@matrix-os/brand";

/** Shared by sign-in and sign-up so hosted authentication follows the Matrix brand. */
export const shellAuthAppearance = {
  theme: shadcn,
  variables: {
    colorPrimary: desktopPalette.forest,
    colorBackground: appGalleryPalette.canvas,
    colorText: desktopPalette.forest,
    colorTextSecondary: appGalleryPalette.textMuted,
    colorDanger: desktopPalette.danger,
    fontFamily: fonts.ui,
    borderRadius: "0.75rem",
  },
  elements: {
    rootBox: "w-full",
    cardBox: "w-full !shadow-none !border-0",
    card: "!bg-transparent",
    headerTitle: "!font-[family-name:var(--font-bricolage)] !font-bold",
  },
};
