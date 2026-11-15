"use client";
import { useEffect, useRef, useState } from "react";
import { sharedAppDesktopUrl, type SharedAppLink } from "@matrix-os/contracts";
import { SharedAppBadge } from "@matrix-os/ui/collaborative-app-sharing";

const DESKTOP_SCHEME = "matrixos";

/** Tries the desktop app once on load; the buttons stay as the explicit fallback. */
export function SharedAppHandoff({ link, downloadUrl }: { link: SharedAppLink; downloadUrl: string }) {
  const desktopUrl = sharedAppDesktopUrl(DESKTOP_SCHEME, link);
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
  return <div className="flex min-h-dvh flex-col bg-[#F4F4F5] font-sans text-[#18181B]">
    <header className="flex h-14 items-center gap-2.5 px-6">
      <span aria-hidden="true" className="size-6 rounded-[7px] bg-[#18181B]" />
      <span className="text-sm font-semibold">Matrix</span>
    </header>
    <main className="flex flex-1 items-center justify-center p-6">
      <section aria-labelledby="shared-app-title" className="flex w-full max-w-[400px] flex-col items-center gap-4 rounded-2xl bg-white px-7 pb-6 pt-8 text-center shadow-[0_0_0_1px_rgba(24,24,27,0.06),0_12px_32px_rgba(24,24,27,0.08)]">
        <span className="relative block size-[72px]">
          <span aria-hidden="true" className="flex size-[72px] items-center justify-center rounded-[18px] bg-[#DBEAFE] text-[28px] font-semibold text-[#1E3A8A]">{appName.charAt(0).toUpperCase()}</span>
          {orgName ? <SharedAppBadge appName={appName} organization={{ organizationId: orgName, name: orgName }} /> : null}
        </span>
        <div className="flex flex-col gap-1">
          <h1 id="shared-app-title" className="m-0 text-xl font-semibold tracking-[-0.01em]">{appName}</h1>
          {orgName ? <p className="m-0 text-[13px] text-[#5B5B66]">Shared in {orgName}</p> : null}
        </div>
        <p role="status" className="m-0 flex items-center gap-2 text-[13px] text-[#3F3F46]">
          {opening ? <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className="motion-safe:animate-spin"><circle cx="12" cy="12" r="8" strokeOpacity="0.2" /><path d="M20 12a8 8 0 0 0-8-8" /></svg> : null}
          {opening ? "Opening in the Matrix app…" : "Didn’t open? Use the button below."}
        </p>
        <a href={desktopUrl} className="flex h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-[#18181B] text-sm font-semibold text-white no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71717A]">
          <span>Open in Matrix</span>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M8 7h9v9" /></svg>
        </a>
        <p className="m-0 text-[13px] text-[#5B5B66]">Don’t have the app? <a href={downloadUrl} className="font-medium text-[#18181B]" rel="noreferrer">Download Matrix</a></p>
        <div className="w-full border-t border-[#EDEDF0] pt-3.5 text-xs text-[#5B5B66]">
          {orgName ? `Only ${orgName} members can open this app.` : "Only members of the sharing organization can open this app."}
        </div>
      </section>
    </main>
  </div>;
}
