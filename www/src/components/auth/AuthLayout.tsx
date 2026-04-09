"use client";

import { ReactNode } from "react";

interface AuthLayoutProps {
  featureContent: ReactNode;
  formContent: ReactNode;
}

export function AuthLayout({ featureContent, formContent }: AuthLayoutProps) {
  return (
    <div className="grid min-h-screen grid-cols-1 md:grid-cols-5">
      {/* Left: Feature showcase (3/5 on desktop, condensed on mobile) */}
      <div className="relative col-span-1 md:col-span-3 flex flex-col justify-center overflow-hidden bg-gradient-to-br from-primary/10 via-secondary to-primary/5">
        {/* Decorative glow */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse at 30% 50%, rgba(194,112,58,0.12) 0%, transparent 70%)",
          }}
        />
        <div className="relative z-10 px-6 py-8 md:px-12 md:py-16 lg:px-16">
          {featureContent}
        </div>
      </div>

      {/* Right: Clerk form (2/5 on desktop, full on mobile) */}
      <div className="col-span-1 md:col-span-2 flex items-center justify-center bg-card px-6 py-12 md:px-8">
        <div className="w-full max-w-sm">{formContent}</div>
      </div>
    </div>
  );
}
