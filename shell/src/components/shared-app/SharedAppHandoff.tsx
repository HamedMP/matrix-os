"use client";
import { useEffect, useRef, useState } from "react";
import { BrandCard, CtaButton, palette, fonts, rabbitMarkSvg } from "@matrix-os/brand";
import { sharedAppDesktopUrl, type SharedAppLink } from "@matrix-os/contracts";
import { SharedAppBadge } from "@matrix-os/ui/collaborative-app-sharing";

/** Stable desktop app scheme; Canary registers its own (desktop channel identity). */
const DESKTOP_SCHEME = "matrixos";
const CANARY_SCHEME = "matrixos-canary";

/** Tries the desktop app once on load; the buttons stay as the explicit fallback. */
export function SharedAppHandoff({ link, downloadUrl }: { link: SharedAppLink; downloadUrl: string }) {
  const desktopUrl = sharedAppDesktopUrl(DESKTOP_SCHEME, link);
  const canaryUrl = sharedAppDesktopUrl(CANARY_SCHEME, link);
  const attempted = useRef(false);
  const [opening, setOpening] = useState(true);
  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    window.location.assign(desktopUrl);
    const timer = setTimeout(() => setOpening(false), 4_000);
    return () => clearTimeout(timer);
  }, [desktopUrl]);
  const appName = link.app ?? "Shared app";
  const orgName = link.org ?? null;
  return <div className="flex min-h-dvh flex-col" style={{ background: palette.pageBg, color: palette.brandInk, fontFamily: fonts.sans }}>
    <header className="flex h-14 items-center gap-2.5 px-6">
      <span aria-hidden="true" className="inline-flex" style={{ color: palette.brandTeal }} dangerouslySetInnerHTML={{ __html: rabbitMarkSvg("h-7 w-5") }} />
      <span className="text-sm font-semibold">Matrix</span>
    </header>
    <main className="flex flex-1 items-center justify-center p-6">
      <BrandCard className="flex w-full max-w-[400px] flex-col items-center gap-4 px-7 pb-6 pt-8 text-center">
        <section aria-labelledby="shared-app-title" className="flex w-full flex-col items-center gap-4">
          <span className="relative block size-[72px]">
            <span aria-hidden="true" className="flex size-[72px] items-center justify-center rounded-[18px] text-[28px] font-semibold"
              style={{ background: palette.cream, color: palette.forestDeep }}>{appName.charAt(0).toUpperCase()}</span>
            {orgName ? <SharedAppBadge appName={appName} organization={{ organizationId: orgName, name: orgName }} /> : null}
          </span>
          <div className="flex flex-col gap-1">
            <h1 id="shared-app-title" className="m-0 text-xl font-semibold tracking-[-0.01em]" style={{ fontFamily: fonts.heading }}>{appName}</h1>
            {orgName ? <p className="m-0 text-[13px]" style={{ color: palette.mutedFg }}>Shared in {orgName}</p> : null}
          </div>
          <p role="status" className="m-0 flex items-center gap-2 text-[13px]" style={{ color: palette.deep }}>
            {opening ? <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className="motion-safe:animate-spin"><circle cx="12" cy="12" r="8" strokeOpacity="0.2" /><path d="M20 12a8 8 0 0 0-8-8" /></svg> : null}
            {opening ? "Opening in the Matrix app…" : "Didn’t open? Use the button below."}
          </p>
          <CtaButton href={desktopUrl} style={{ width: "100%", height: 44, boxSizing: "border-box", fontWeight: 600 }}>
            <span>Open in Matrix</span>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M8 7h9v9" /></svg>
          </CtaButton>
          <p className="m-0 text-[13px]" style={{ color: palette.mutedFg }}>
            Don’t have the app? <a href={downloadUrl} className="font-medium" style={{ color: palette.brandInk }} rel="noreferrer">Download Matrix</a>
          </p>
          <p className="m-0 text-xs" style={{ color: palette.subtle }}>
            Using Matrix Canary? <a href={canaryUrl} className="font-medium" style={{ color: palette.forest }}>Open in Canary</a>
          </p>
          <div className="w-full border-t pt-3.5 text-xs" style={{ borderColor: palette.border, color: palette.mutedFg }}>
            {orgName ? `Only ${orgName} members can open this app.` : "Only members of the sharing organization can open this app."}
          </div>
        </section>
      </BrandCard>
    </main>
  </div>;
}
