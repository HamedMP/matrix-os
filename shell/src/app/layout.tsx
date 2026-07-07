import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Inter, Instrument_Sans, JetBrains_Mono, Cormorant_Garamond, Orbitron } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { getPostHogVisitorCountry } from "@matrix-os/observability/client";
import { buildShellMetadata } from "@/lib/shell-metadata";
import "@xterm/xterm/css/xterm.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/500.css";
import "./globals.css";
import { PwaRegister } from "@/components/pwa/PwaRegister";
import { InstallPrompt } from "@/components/pwa/InstallPrompt";
import { PostHogIdentify } from "@/components/PostHogIdentify";
import { Toaster } from "@/components/ui/sonner";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

// Default shell sans — matches the landing site's --font-sans (Instrument Sans).
const instrumentSans = Instrument_Sans({
  variable: "--font-instrument",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
});

const cormorant = Cormorant_Garamond({
  variable: "--font-serif",
  subsets: ["latin"],
  weight: ["300", "400", "500"],
});

const orbitron = Orbitron({
  variable: "--font-orbitron",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export async function generateMetadata(): Promise<Metadata> {
  const metadata = await buildShellMetadata(process.env.GATEWAY_URL);
  return {
    ...metadata,
    // apple-touch-icon for iOS home-screen install. Next emits this from
    // icons.apple; reuse the existing app icon (iOS scales 192px down to its
    // expected 180px target).
    icons: {
      icon: [
        { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
      apple: [{ url: "/icon-192.png", sizes: "192x192", type: "image/png" }],
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // Cover the notch/safe-area; let the layout opt into safe-area insets.
  viewportFit: "cover",
  // On-screen keyboard resizes the layout viewport instead of overlaying it,
  // so keyboard-aware UI (terminal key bar, toasts) tracks the real height.
  interactiveWidget: "resizes-content",
  // Brand-aligned status-bar tint: cream surface in light, forest in dark.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#E0E1CA" },
    { media: "(prefers-color-scheme: dark)", color: "#434E3F" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const visitorCountry = getPostHogVisitorCountry(await headers());
  const selfHostedMode = process.env.MATRIX_SELF_HOSTED === "1";
  const renderDocument = (includePostHogIdentify: boolean) => (
    <html
      lang="en"
      data-posthog-visitor-country={visitorCountry ?? undefined}
      data-matrix-self-hosted={selfHostedMode ? "1" : undefined}
      // Runtime replay kill switch: read on the server per request, so
      // setting POSTHOG_DISABLE_REPLAY and restarting matrix-shell stops
      // replay without rebuilding the bundle.
      data-posthog-disable-replay={process.env.POSTHOG_DISABLE_REPLAY ? "1" : undefined}
    >
      <body className={`${inter.variable} ${instrumentSans.variable} ${jetbrainsMono.variable} ${cormorant.variable} ${orbitron.variable}`}>
        {children}
        {includePostHogIdentify ? <PostHogIdentify /> : null}
        <PwaRegister />
        <InstallPrompt />
        <Toaster />
      </body>
    </html>
  );

  if (selfHostedMode) {
    return renderDocument(false);
  }

  return (
    // ClerkProvider reads NEXT_PUBLIC_CLERK_SIGN_IN_URL / _SIGN_UP_URL to keep
    // sign-in/up cross-links on the in-app routes. Those vars are baked at
    // build time (default /sign-in and /sign-up); without them Clerk falls
    // back to the hosted Account Portal (accounts.matrix-os.com).
    <ClerkProvider>
      {renderDocument(true)}
    </ClerkProvider>
  );
}
