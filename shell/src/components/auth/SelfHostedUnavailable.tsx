"use client";

import Link from "next/link";
import { palette } from "@matrix-os/brand";
import { AuthLayout } from "./AuthLayout";

/**
 * Hosted-only flows (managed sign-in, computer management, platform-owned
 * integrations) depend on a Matrix account that self-hosted computers do not
 * have. Explain that instead of mounting the flow, which would call Clerk.
 */
export function SelfHostedUnavailable({ feature }: { feature: string }) {
  return (
    <AuthLayout
      featureContent={
        <div className="space-y-5">
          <h1 className="text-4xl font-semibold">{feature} isn&apos;t available here.</h1>
          <p className="max-w-lg leading-7" style={{ color: palette.subtle }}>
            This computer is self-hosted. {feature} needs a hosted Matrix OS account.
          </p>
        </div>
      }
      formContent={
        <div className="space-y-5">
          <p role="status">This feature is only available on hosted Matrix OS.</p>
          <Link
            href="/"
            className="block w-full rounded-xl px-5 py-3 text-center font-semibold"
            style={{ backgroundColor: palette.deep, color: palette.card }}
          >
            Back to your computer
          </Link>
        </div>
      }
    />
  );
}
