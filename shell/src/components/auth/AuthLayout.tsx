"use client";

import type { ReactNode } from "react";
import { cardShadow, palette as c } from "@matrix-os/brand";

interface AuthLayoutProps {
  featureContent: ReactNode;
  formContent: ReactNode;
}

export function AuthLayout({ featureContent, formContent }: AuthLayoutProps) {
  return (
    <main
      data-matrix-auth-shell="true"
      data-matrix-auth-layout="true"
      className="relative min-h-screen overflow-hidden"
      style={{ backgroundColor: c.pageBg, color: c.deep }}
    >
      <div className="relative mx-auto grid min-h-screen w-full max-w-6xl items-center gap-8 px-5 py-10 lg:grid-cols-[minmax(0,1fr)_minmax(380px,430px)] lg:gap-20 lg:px-10 xl:px-0">
        <div
          className="min-w-0 border-b pb-8 lg:border-b-0 lg:pb-0"
          style={{ borderColor: c.border }}
        >
          {featureContent}
        </div>

        <aside className="relative mx-auto w-full max-w-[430px] lg:justify-self-end">
          <div
            className="mb-4 flex items-center justify-between border-b pb-3 text-xs font-semibold uppercase tracking-[0.18em]"
            style={{ borderColor: c.border, color: c.subtle }}
          >
            <span>Matrix account</span>
            <span>Secure session</span>
          </div>
          <div
            className="relative overflow-hidden rounded-2xl p-4"
            style={{
              backgroundColor: c.card,
              border: `1px solid ${c.border}`,
              boxShadow: cardShadow,
            }}
          >
            {formContent}
          </div>
        </aside>
      </div>
    </main>
  );
}
