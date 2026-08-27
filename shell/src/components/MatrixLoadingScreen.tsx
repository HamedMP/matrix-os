"use client";

import { fonts, palette as brand } from "@matrix-os/brand";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";

const MATRIX_MARK_SHIMMER =
  "linear-gradient(90deg, #2F392C 0%, #2F392C 24%, #C4A265 50%, #2F392C 76%, #2F392C 100%)";

/**
 * The one shell-hydration surface shared by account, journey, and Desktop
 * readiness checks. Keeping this component free of theme/runtime state avoids
 * a visual swap while those independent stores finish loading.
 */
export function MatrixLoadingScreen() {
  return (
    <main
      role="status"
      aria-live="polite"
      aria-label="Matrix OS is loading"
      data-matrix-loading-screen="true"
      className="fixed inset-0 grid place-items-center overflow-hidden px-6 text-center"
      style={{
        backgroundColor: brand.card,
        color: brand.brandInk,
        fontFamily: fonts.ui,
        zIndex: SHELL_Z_INDEX.bootScreen,
      }}
    >
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        style={{
          background: `radial-gradient(circle at 50% 42%, ${brand.brandGold}24 0%, transparent 34%), linear-gradient(180deg, ${brand.card} 0%, #F7F4E9 100%)`,
        }}
      />

      <div className="relative grid w-full max-w-[620px] justify-items-center gap-6">
        <div
          role="img"
          aria-label="Matrix OS logo"
          className="h-[132px] w-[124px] sm:h-[156px] sm:w-[148px]"
          style={{
            WebkitMask: "url('/matrix-logo.svg') no-repeat center / contain",
            mask: "url('/matrix-logo.svg') no-repeat center / contain",
            backgroundImage: MATRIX_MARK_SHIMMER,
            backgroundSize: "300% 100%",
            animation: "onboard-shimmer 8s ease-in-out infinite, onboard-glow 8s ease-in-out infinite",
          }}
        />

        <h1
          className="m-0 text-[3.1rem] leading-[0.95] tracking-[-0.045em] sm:text-[4.5rem]"
          style={{
            color: brand.brandInk,
            fontFamily: fonts.heading,
            fontVariationSettings: '"opsz" 14, "wdth" 100',
            fontWeight: 700,
          }}
        >
          Matrix OS
        </h1>
      </div>
    </main>
  );
}
