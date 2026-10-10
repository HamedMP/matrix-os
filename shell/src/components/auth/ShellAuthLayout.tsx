"use client";

import type { ReactNode } from "react";
import { appGalleryPalette, desktopPalette, fonts, rabbitMarkSvg } from "@matrix-os/brand";

interface ShellAuthLayoutProps {
  eyebrow: string;
  title: string;
  body: string;
  children: ReactNode;
}

export function ShellAuthLayout({ eyebrow, title, body, children }: ShellAuthLayoutProps) {
  return (
    <main
      data-matrix-auth-shell="true"
      className="relative h-dvh overflow-x-hidden overflow-y-auto"
      style={{ backgroundColor: desktopPalette.paper, color: desktopPalette.forest, fontFamily: fonts.ui }}
    >
      <section className="mx-auto flex min-h-full w-full max-w-7xl flex-col px-5 py-6 sm:px-10 sm:py-10">
        <header className="flex items-center gap-3 pb-8 sm:pb-12">
          <span
            className="flex size-10 items-center justify-center rounded-xl"
            style={{ backgroundColor: desktopPalette.forest, color: desktopPalette.green }}
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: rabbitMarkSvg("h-7 w-5") }}
          />
          <span className="text-xl font-bold tracking-tight" style={{ fontFamily: fonts.heading }}>{eyebrow}</span>
        </header>
        <div className="grid flex-1 items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] lg:gap-16">
          <div
            data-matrix-auth-brand="true"
            className="relative overflow-hidden rounded-3xl px-7 py-10 sm:px-12 sm:py-16"
            style={{ backgroundColor: desktopPalette.forest, color: desktopPalette.paper }}
          >
            <span
              className="mb-10 block h-16 w-12 sm:mb-14"
              style={{ color: desktopPalette.green }}
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: rabbitMarkSvg("h-full w-full") }}
            />
            <h1 className="max-w-xl text-balance text-[clamp(2.25rem,4.5vw,3.75rem)] font-bold leading-[1.1] tracking-[-0.02em]" style={{ fontFamily: fonts.heading }}>
              {title}
            </h1>
            <p className="mt-5 max-w-[38ch] text-base leading-relaxed" style={{ color: desktopPalette.blue }}>{body}</p>
            <div className="mt-12 flex gap-2 sm:mt-16" aria-hidden="true">
              {[desktopPalette.coral, desktopPalette.gold, desktopPalette.green, desktopPalette.blue].map((color) => (
                <span key={color} className="h-2 w-12 rounded-full" style={{ backgroundColor: color }} />
              ))}
            </div>
          </div>
          <div data-matrix-auth-form="true" className="order-first mx-auto w-full max-w-[430px] lg:order-none">
            <div className="rounded-2xl border bg-white p-3 sm:p-5" style={{ borderColor: appGalleryPalette.border }}>
              {children}
            </div>
            <p className="mt-5 text-center text-xs leading-relaxed" style={{ color: appGalleryPalette.textMuted }}>
              One Matrix account. Your apps, conversations, and computer.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
